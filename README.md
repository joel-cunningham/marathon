# Tokyo lead-up

A static training-plan page for the five weeks from 28 Sep to 1 Nov 2026. It shows today's session, a review of the latest run, weekly volume, the pace zones, each day's session against your Strava runs and a log of every run.

It runs on AWS in `ap-southeast-2`. The page and its small Strava API share one CloudFront domain, so the browser only ever makes same-origin requests.

```
browser ──HTTPS──▶ CloudFront ─┬─ /*      ──OAC──▶ S3 (private)          index.html
                               └─ /api/*  ──OAC──▶ Lambda function URL   Strava OAuth + activities
                                                     │
                                                     └──▶ SSM Parameter Store (client id/secret, refresh token, session key)
```

| Path | What it does |
| --- | --- |
| `index.html` | The page. It calls `GET /api/activities`. On a 401 it shows **Connect Strava**. |
| `infra/lib/marathon-stack.ts` | CDK stack: S3, CloudFront, Lambda and the `public_url` parameter. |
| `infra/lambda/handler.ts` | API routes (`/api/auth/start`, `/api/auth/callback`, `/api/activities`), on Node.js 24. |
| `infra/test/handler.test.ts` | Handler tests with SSM and Strava mocked. Run them with `cd infra && npm test`. |
| `deploy.sh` | Deploys everything: sets secrets, runs `cdk deploy`, uploads the page and invalidates CloudFront. |

## Cost

For one person this should come to well under US$1 a month, and mostly nothing:

- **CloudFront, Lambda:** inside the always-free tiers at this traffic.
- **S3:** a single small file.
- **SSM:** standard-tier parameters are free. SecureStrings use the AWS-managed `aws/ssm` key, which is also free; no customer-managed KMS key is created.
- **CloudWatch Logs:** kept for one month.
- **CDK bootstrap:** an S3 bucket and an ECR repository. The first deploy creates them if the region isn't bootstrapped yet, and they cost cents.

## Prerequisites

- An AWS account and AWS CLI v2 credentials for it (`aws sts get-caller-identity` should work).
- Node.js 20 or newer, and npm.
- A Strava account.

## First deploy

Strava needs the CloudFront domain before it will issue app credentials, and CloudFront needs a deploy before it has a domain. So the first deploy runs without Strava credentials:

```sh
SKIP_SECRETS=1 ./deploy.sh
```

When it finishes, it prints:

```
Site:                      https://d1234abcd.cloudfront.net
Strava callback domain:    d1234abcd.cloudfront.net
```

The page already works at this point, but only as the plan. If you open `/api/activities` directly, it reports that the server isn't configured yet.

## Create the Strava API app

1. Sign in to Strava and open <https://www.strava.com/settings/api>.
2. Fill in the form:
   - **Application Name:** anything, e.g. `Tokyo lead-up`.
   - **Category:** `Training`.
   - **Website:** the site URL, e.g. `https://d1234abcd.cloudfront.net`.
   - **Authorization Callback Domain:** the **callback domain** printed by `deploy.sh`, e.g. `d1234abcd.cloudfront.net`.
     - Enter the bare host only: no `https://` and no path.
     - Strava only redirects back to URLs on this domain, and the Lambda sends `https://<domain>/api/auth/callback`.
     - If you ever tear down and recreate the distribution, the domain changes and you'll need to update this field.
3. Save. Strava may ask you to upload an app icon first, and any image will do.
4. Copy the **Client ID** and **Client Secret** from the app page.

A new Strava app has an athlete capacity of 1, which is you. Its default rate limits are 100 read requests per 15 minutes and 1,000 per day. The API caches results for 5 minutes and one page load is usually one Strava call, so normal use stays far below those limits.

## Second deploy: add the credentials

```sh
STRAVA_CLIENT_ID=12345 STRAVA_CLIENT_SECRET=abcdef... ./deploy.sh
```

If you leave the variables out, the script prompts for any credential that isn't stored yet. The credentials are stored as SecureStrings:

| Parameter | Type | Written by |
| --- | --- | --- |
| `/marathon/strava/client_id` | SecureString | `deploy.sh` |
| `/marathon/strava/client_secret` | SecureString | `deploy.sh` |
| `/marathon/session_secret` | SecureString | `deploy.sh` (random, generated once) |
| `/marathon/strava/refresh_token` | SecureString | Lambda, after you connect |
| `/marathon/strava/athlete_id` | String | Lambda, on first connect |
| `/marathon/public_url` | String | CDK |

## Connect

Open the site and click **Connect Strava**, then approve access. Leave **"View data about your private activities"** ticked, because the page requests `activity:read_all` and rejects the connection without it. Strava sends you back to `/` and your runs appear.

What happens behind the scenes:

- The callback stores your refresh token in SSM.
- It sets a signed, HttpOnly, Secure `__Host-session` cookie that lasts 60 days.
- It locks the deployment to your Strava athlete ID. Anyone else who tries to connect gets a 403 and can't replace your token.

You only connect once. After that `/api/activities` is public: anyone who opens the page sees your runs (name, type, date, timezone, distance, moving time and elevation gain) without connecting. No maps, heart rate or location are returned.

## Updating the page

Edit `index.html` and run `./deploy.sh` again. Credentials that are already stored are left alone. Browsers may keep the old page for up to 5 minutes.

## API

| Route | Behaviour |
| --- | --- |
| `GET /api/auth/start` | Sets a short-lived `state` cookie and redirects to Strava with `scope=activity:read_all`. |
| `GET /api/auth/callback` | Checks `state` and scope, then exchanges the code for tokens. Stores the refresh token and athlete ID, sets the session cookie and redirects to `/`. |
| `GET /api/activities?after=<iso>&before=<iso>` | Public once Strava is connected (401 `not_connected` before that). Refreshes the access token when needed. Calls `GET /api/v3/athlete/activities?per_page=100`, paging if necessary. Returns `{activities:[{id,name,sport_type,start_local,tz,summary:{distance,moving_time,elevation_gain}}], fetched_at}`, where `tz` is the IANA timezone such as `Australia/Sydney`. The range can span up to about 15 months. Results are cached in the Lambda for 5 minutes and in the browser (`private, max-age=300`). |

Error responses are JSON of the form `{error, message}`, where `error` is one of:

- `not_connected` (401)
- `rate_limited` (503)
- `strava_error` (502)
- `not_configured` (500)
- `bad_request` (400)

## Troubleshooting

- **"Connect Strava" keeps coming back:** the refresh token was revoked, for example from <https://www.strava.com/settings/apps>. Connect again.
- **403 "linked to a different Strava athlete":** delete `/marathon/strava/athlete_id` and `/marathon/strava/refresh_token` in SSM, then connect with the right account.
- **Strava says `redirect_uri invalid`:** the app's Authorization Callback Domain doesn't match the CloudFront domain.
- **Hide your runs:** revoke the app at <https://www.strava.com/settings/apps>, or delete `/marathon/strava/refresh_token` in SSM. The page falls back to the plan only until you connect again.

## Tear down

```sh
cd infra && npx cdk destroy MarathonStack
aws ssm delete-parameters --region ap-southeast-2 --names \
  /marathon/strava/client_id /marathon/strava/client_secret /marathon/session_secret \
  /marathon/strava/refresh_token /marathon/strava/athlete_id
```

Then delete the app at <https://www.strava.com/settings/api>.
