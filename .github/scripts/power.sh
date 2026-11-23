#!/usr/bin/env bash
set -euo pipefail

die() { echo "::error title=Stopped::$*"; exit 1; }
[ -n "${RENDER_API_KEY:-}" ] || die "RENDER_API_KEY is not set."
name="${RENDER_SERVICE_NAME:-one-percent-app}"
api=https://api.render.com/v1
auth=(-H "Authorization: Bearer $RENDER_API_KEY")

id=$(curl -sS -f "${auth[@]}" "$api/services?name=${name}&limit=100" \
  | jq -r --arg n "$name" 'map(.service) | map(select(.name == $n)) | .[0].id // empty')
[ -n "$id" ] || die "No Render service named '${name}'."
state=$(curl -sS -f "${auth[@]}" "$api/services/${id}" | jq -r '.suspended')

if [ "$ACTION" = off ]; then
  [ "$state" = suspended ] && { echo "Already off."; exit 0; }
  curl -sS --fail-with-body -X POST "${auth[@]}" "$api/services/${id}/suspend" > /tmp/out \
    || die "Render refused: $(head -c 400 /tmp/out)"
  echo "Off. Render bills nothing while it stays off."
  exit 0
fi

if [ "$state" = suspended ]; then
  curl -sS --fail-with-body -X POST "${auth[@]}" "$api/services/${id}/resume" > /tmp/out \
    || die "Render refused: $(head -c 400 /tmp/out)"
fi
curl -sS --fail-with-body -X POST "${auth[@]}" -H "Content-Type: application/json" \
  -d '{"clearCache":"do_not_clear"}' "$api/services/${id}/deploys" > /tmp/deploy.json \
  || die "Render refused the deploy: $(head -c 400 /tmp/deploy.json)"
deploy=$(jq -r '.id // empty' /tmp/deploy.json)
[ -n "$deploy" ] || die "Render named no deploy to watch."
for _ in $(seq 1 60); do
  sleep 15
  status=$(curl -sS "${auth[@]}" "$api/services/${id}/deploys/${deploy}" | jq -r '.status // "unknown"')
  case "$status" in
    live) echo "On and live."; exit 0 ;;
    build_failed|update_failed|pre_deploy_failed|canceled) die "The deploy ended as ${status}." ;;
    *) echo "  ${status}…" ;;
  esac
done
die "Fifteen minutes and the deploy has not finished."
