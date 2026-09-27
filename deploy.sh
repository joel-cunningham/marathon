#!/usr/bin/env bash
# Deploy the Tokyo lead-up page: CDK stack, Strava secrets in SSM, index.html to S3, CloudFront invalidation.
#
# Usage:
#   ./deploy.sh                                   # deploy; prompts for Strava app credentials if they aren't in SSM yet
#   STRAVA_CLIENT_ID=123 STRAVA_CLIENT_SECRET=abc ./deploy.sh
#   SKIP_SECRETS=1 ./deploy.sh                    # first run, before the Strava app exists
#
# Uses your normal AWS credentials (AWS_PROFILE etc.). Requires node >= 20, npm and the AWS CLI v2.
set -euo pipefail

REGION="ap-southeast-2"
STACK="MarathonStack"
PREFIX="/marathon"
ROOT="$(cd "$(dirname "$0")" && pwd)"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

for cmd in aws node npm openssl; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 1; }
done

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Deploying to account $ACCOUNT in $REGION"

param_exists() { aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1; }
put_secret() { aws ssm put-parameter --name "$1" --value "$2" --type SecureString --overwrite >/dev/null; echo "  set $1"; }

# --- Secrets (SecureString; CloudFormation can't create these, so they're managed here) ---
echo "Checking Strava parameters in SSM…"
if ! param_exists "$PREFIX/session_secret"; then
  put_secret "$PREFIX/session_secret" "$(openssl rand -base64 48 | tr -d '\n')"
fi
if [[ -z "${SKIP_SECRETS:-}" ]]; then
  if [[ -n "${STRAVA_CLIENT_ID:-}" ]] || ! param_exists "$PREFIX/strava/client_id"; then
    id="${STRAVA_CLIENT_ID:-}"
    [[ -n "$id" ]] || read -rp "Strava Client ID (blank to skip for now): " id || true
    if [[ -n "$id" ]]; then put_secret "$PREFIX/strava/client_id" "$id"; fi
  fi
  if [[ -n "${STRAVA_CLIENT_SECRET:-}" ]] || ! param_exists "$PREFIX/strava/client_secret"; then
    secret="${STRAVA_CLIENT_SECRET:-}"
    [[ -n "$secret" ]] || { read -rsp "Strava Client Secret (blank to skip for now): " secret || true; echo; }
    if [[ -n "$secret" ]]; then put_secret "$PREFIX/strava/client_secret" "$secret"; fi
  fi
fi

# --- Infrastructure ---
cd "$ROOT/infra"
npm ci --no-audit --no-fund
if ! aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
  echo "Bootstrapping CDK in $REGION…"
  npx cdk bootstrap "aws://$ACCOUNT/$REGION"
fi
npx cdk deploy "$STACK" --require-approval never --outputs-file cdk.out/outputs.json

output() { node -e "console.log(require('./cdk.out/outputs.json')['$STACK']['$1'])"; }
BUCKET="$(output BucketName)"
DIST="$(output DistributionId)"
URL="$(output SiteUrl)"
DOMAIN="$(output StravaCallbackDomain)"

# --- Page ---
echo "Uploading index.html…"
aws s3 cp "$ROOT/index.html" "s3://$BUCKET/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public, max-age=300, s-maxage=86400"

echo "Invalidating CloudFront…"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/" "/index.html" \
  --query Invalidation.Id --output text

cat <<EOF

Done.
  Site:                      $URL
  Strava callback domain:    $DOMAIN
EOF
if ! param_exists "$PREFIX/strava/client_id" || ! param_exists "$PREFIX/strava/client_secret"; then
  echo
  echo "Strava credentials aren't set yet. Create the Strava API app with the callback domain above,"
  echo "then run: STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... ./deploy.sh"
fi
