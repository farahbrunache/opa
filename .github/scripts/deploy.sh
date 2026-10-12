#!/usr/bin/env bash
set -euo pipefail

KEYS=(
  DATABASE_URL
  CARD_ENCRYPTION_KEY
  AUTH_PUBLISHABLE_KEY
  AUTH_CLIENT_ID
  ADMIN_ACCOUNT_IDS
  RETELL_SECRET_KEY
  RETELL_AGENT_ID
  PAY_WISE
)

OPTIONAL_KEYS=(
  AUTH_CLIENT_SECRET
  SWEEP_SECRET
  RUNPOD_API_KEY
  TAXONOMY_URL
  TAXONOMY_TOKEN
  DIRECTORY_SERVICE_URL
  DIRECTORY_SERVICE_TOKEN
  CONFIRM_TARGET_HOURS
)

die() { echo "::error title=Deploy stopped::$*"; exit 1; }

[ -n "${RENDER_API_KEY:-}" ] || die "RENDER_API_KEY is not set."
name="${RENDER_SERVICE_NAME:-one-percent-app}"

sync_settings=yes
if [ -z "${INFISICAL_TOKEN:-}" ] || [ -z "${INFISICAL_PROJECT_ID:-}" ]; then
  sync_settings=no
  echo "::notice title=Settings not synced::Infisical is not configured for this repository, so Render will deploy with the settings already on the service. Add INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID and INFISICAL_URL to switch this on."
fi

if [ "$sync_settings" = yes ]; then
  echo "Reading the settings out of Infisical…"
  origin=$(printf '%s' "$INFISICAL_API_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
  [ -n "$origin" ] || die "INFISICAL_URL is not an address. It has to start with https:// and a host name."

  raw=$(curl -sS --fail-with-body --max-time 30 \
    -H "authorization: Bearer $INFISICAL_TOKEN" \
    "$origin/api/v3/secrets/raw?workspaceId=${INFISICAL_PROJECT_ID}&environment=production") || \
    die "Infisical would not hand over the settings. It answered: $raw"

  printf '%s' "$raw" | jq -e 'has("secrets")' > /dev/null 2>&1 || \
    die "Infisical answered with something unreadable. It sent: $(printf '%s' "$raw" | head -c 400)"

  printf '%s' "$raw" | jq '.secrets' > /tmp/secrets.json

  count=$(jq 'length' /tmp/secrets.json)
  [ "$count" -gt 0 ] || die "The production environment in that project holds no secrets. Check the environment's slug is production rather than prod."

  missing=()
  for key in "${KEYS[@]}"; do
    jq -e --arg k "$key" \
      'map(select(.secretKey == $k and (.secretValue | length) > 0)) | length > 0' \
      /tmp/secrets.json > /dev/null 2>&1 || missing+=("$key")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "Infisical has no value for: ${missing[*]}. Nothing was changed on Render."
  fi

  jq -c \
    --argjson keys "$(printf '%s\n' "${KEYS[@]}" | jq -R . | jq -sc .)" \
    --argjson optional "$(printf '%s\n' "${OPTIONAL_KEYS[@]}" | jq -R . | jq -sc .)" \
    'INDEX(.secretKey) as $have
     | ($keys + $optional)
     | map({key: ., value: ($have[.].secretValue // "")})' \
    /tmp/secrets.json > /tmp/env-vars.json
fi

echo "Finding the Render service named '${name}'…"
curl -sS -f -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services?name=${name}&limit=100" > /tmp/services.json \
  || die "Could not list Render services. Check RENDER_API_KEY."
id=$(jq -r --arg n "$name" \
  'map(.service) | map(select(.name == $n)) | .[0].id // empty' /tmp/services.json)
[ -n "$id" ] || die "No Render service named '${name}' exists under this API key."

if [ "$sync_settings" = yes ]; then
  echo "Writing ${#KEYS[@]} settings to Render…"
  curl -sS -f -X PUT \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    --data @/tmp/env-vars.json \
    "https://api.render.com/v1/services/${id}/env-vars" > /dev/null \
    || die "Render refused the settings. Nothing was deployed."
else
  echo "Leaving the settings on Render as they are."
fi

echo "Asking Render to deploy…"
curl -sS --fail-with-body -X POST \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"clearCache":"do_not_clear"}' \
  "https://api.render.com/v1/services/${id}/deploys" > /tmp/deploy.json \
  || die "Render refused the deploy. It answered: $(head -c 400 /tmp/deploy.json)"
deploy=$(jq -r '.id // empty' /tmp/deploy.json)
[ -n "$deploy" ] || die "Render accepted the deploy but named no deploy to watch."

echo "Waiting for it to finish…"
for _ in $(seq 1 60); do
  sleep 15
  status=$(curl -sS -H "Authorization: Bearer $RENDER_API_KEY" \
    "https://api.render.com/v1/services/${id}/deploys/${deploy}" | jq -r '.status // "unknown"')
  case "$status" in
    live)
      echo "Deployed and live."
      exit 0
      ;;
    build_failed|update_failed|pre_deploy_failed|canceled)
      die "The deploy ended as ${status}. The Render dashboard has the log."
      ;;
    *)
      echo "  ${status}…"
      ;;
  esac
done
die "Fifteen minutes and the deploy has not finished. The Render dashboard has the log."
