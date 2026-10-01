import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { handler, store, resetForTests, signSession, verifySession, parseRange } from "../lambda/handler";

const SECRET = "test-secret";
let params: Record<string, string>;
let puts: [string, string, boolean][];
let calls: string[];
let stravaActivities: unknown[];

store.get = async (names) => Object.fromEntries(names.filter((n) => n in params).map((n) => [n, params[n]]));
store.put = async (name, value, secure) => {
  puts.push([name, value, secure]);
  params[name] = value;
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith("/oauth/token")) {
    const body = new URLSearchParams(String(init?.body));
    if (body.get("grant_type") === "authorization_code")
      return Response.json({ access_token: "at1", refresh_token: "rt1", expires_at: Date.now() / 1000 + 3600, athlete: { id: 42 } });
    return Response.json({ access_token: "at2", refresh_token: "rt2", expires_at: Date.now() / 1000 + 3600 });
  }
  if (url.includes("/api/v3/athlete/activities")) return Response.json(stravaActivities);
  return new Response("nope", { status: 404 });
}) as typeof fetch;

function ev(rawPath: string, query: Record<string, string> = {}, cookies: string[] = []): LambdaFunctionURLEvent {
  return { rawPath, queryStringParameters: query, cookies, requestContext: { http: { method: "GET" } } } as unknown as LambdaFunctionURLEvent;
}

beforeEach(() => {
  resetForTests();
  params = {
    "/marathon/strava/client_id": "123",
    "/marathon/strava/client_secret": "shh",
    "/marathon/session_secret": SECRET,
    "/marathon/public_url": "https://d1.cloudfront.net",
  };
  puts = [];
  calls = [];
  stravaActivities = [];
});

test("session cookie round-trips and rejects tampering or expiry", () => {
  const c = signSession(SECRET, "42", 1000);
  assert.equal(verifySession(SECRET, c, 1001), "42");
  assert.equal(verifySession("other", c, 1001), null);
  assert.equal(verifySession(SECRET, c.replace(/^42/, "43"), 1001), null);
  assert.equal(verifySession(SECRET, c, 1000 + 60 * 86400 + 1), null);
});

test("parseRange converts ISO to epoch seconds and validates", () => {
  assert.deepEqual(parseRange({ after: "2026-09-27T14:00:00.000Z", before: "2026-11-01T13:59:59.000Z" }), {
    after: 1790517600,
    before: 1793541599,
  });
  assert.throws(() => parseRange({ after: "nope", before: "2026-11-01" }));
});

test("auth/start redirects to Strava with activity:read_all and a state cookie", async () => {
  const r = await handler(ev("/api/auth/start"));
  assert.equal(r.statusCode, 302);
  const loc = new URL(String(r.headers!.location));
  assert.equal(loc.origin + loc.pathname, "https://www.strava.com/oauth/authorize");
  assert.equal(loc.searchParams.get("scope"), "activity:read_all");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://d1.cloudfront.net/api/auth/callback");
  assert.match(r.cookies![0], new RegExp(`^__Host-oauth_state=${loc.searchParams.get("state")};.*HttpOnly; Secure`));
});

test("callback stores refresh token + athlete, sets session, then activities work", async () => {
  const bad = await handler(ev("/api/auth/callback", { code: "c", state: "x", scope: "read,activity:read_all" }, ["__Host-oauth_state=y"]));
  assert.equal(bad.statusCode, 400);

  const r = await handler(ev("/api/auth/callback", { code: "c", state: "s", scope: "read,activity:read_all" }, ["__Host-oauth_state=s"]));
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers!.location, "/");
  assert.deepEqual(puts, [
    ["/marathon/strava/athlete_id", "42", false],
    ["/marathon/strava/refresh_token", "rt1", true],
  ]);
  const session = r.cookies!.find((c) => c.startsWith("__Host-session="))!;
  assert.match(session, /HttpOnly; Secure; SameSite=Lax/);

  stravaActivities = [
    { id: 7, name: "Easy", sport_type: "Run", start_date_local: "2026-09-29T06:10:00Z", distance: 10012.3, moving_time: 3300, total_elevation_gain: 42, timezone: "(GMT+10:00) Australia/Sydney", extra: 1 },
  ];
  const cookie = decodeURIComponent(session.split(";")[0]);
  const q = { after: "2026-09-27T14:00:00.000Z", before: "2026-11-01T13:59:59.000Z" };
  const a = await handler(ev("/api/activities", q, [cookie]));
  assert.equal(a.statusCode, 200);
  assert.deepEqual(JSON.parse(String(a.body)).activities, [
    { id: 7, name: "Easy", sport_type: "Run", start_local: "2026-09-29T06:10:00Z", tz: "Australia/Sydney", summary: { distance: 10012.3, moving_time: 3300, elevation_gain: 42 } },
  ]);
  assert.match(calls.at(-1)!, /after=1790517600&before=1793541599&per_page=100&page=1/);

  // Second call inside 5 minutes is served from cache.
  const n = calls.length;
  await handler(ev("/api/activities", q, [cookie]));
  assert.equal(calls.length, n);
});

test("a different athlete can't take over the deployment", async () => {
  params["/marathon/strava/athlete_id"] = "99";
  const r = await handler(ev("/api/auth/callback", { code: "c", state: "s", scope: "activity:read_all" }, ["__Host-oauth_state=s"]));
  assert.equal(r.statusCode, 403);
  assert.equal(puts.length, 0);
});

test("activities are public once connected and 401 before", async () => {
  const q = { after: "2026-09-27T14:00:00.000Z", before: "2026-11-01T13:59:59.000Z" };
  assert.equal((await handler(ev("/api/activities", q))).statusCode, 401);
  params["/marathon/strava/athlete_id"] = "42";
  params["/marathon/strava/refresh_token"] = "rt0";
  resetForTests();
  assert.equal((await handler(ev("/api/activities", q))).statusCode, 200);
});

test("expired access token is refreshed and the rotated refresh token saved", async () => {
  params["/marathon/strava/athlete_id"] = "42";
  params["/marathon/strava/refresh_token"] = "rt0";
  const q = { after: "2026-09-27T14:00:00.000Z", before: "2026-11-01T13:59:59.000Z" };
  const r = await handler(ev("/api/activities", q, [`__Host-session=${signSession(SECRET, "42")}`]));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(puts, [["/marathon/strava/refresh_token", "rt2", true]]);
});
