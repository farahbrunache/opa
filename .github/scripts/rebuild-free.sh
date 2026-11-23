#!/usr/bin/env bash
set -euo pipefail

die() { echo "::error title=Stopped::$*"; exit 1; }
[ -n "${RENDER_API_KEY:-}" ] || die "RENDER_API_KEY is not set."
api=https://api.render.com/v1
name=one-percent-app
old_name=one-percent-app-starter
domain=app.farahbrunache.com
r() { curl -sS --fail-with-body -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "$@"; }
find_id() {
  r "$api/services?name=$1&limit=100" | jq -r --arg n "$1" 'map(.service) | map(select(.name == $n)) | .[0].id // empty'
}

old=$(find_id "$old_name")
if [ -z "$old" ]; then
  old=$(find_id "$name")
  [ -n "$old" ] || die "No service named $name."
  plan=$(r "$api/services/$old" | jq -r '.serviceDetails.plan')
  [ "$plan" != free ] || { echo "Already on the free plan."; exit 0; }
  r -X PATCH -d "{\"name\":\"$old_name\"}" "$api/services/$old" > /dev/null || die "Could not rename the old service."
fi
echo "Old service: $old"
r "$api/services/$old" > /tmp/old.json
owner=$(jq -r '.ownerId' /tmp/old.json)

r "$api/services/$old/env-vars?limit=100" | jq '[.[].envVar | {key, value}]' > /tmp/env.json
jq -r '.[].value' /tmp/env.json | while IFS= read -r v; do [ -n "$v" ] && echo "::add-mask::$v"; done
echo "Copying $(jq length /tmp/env.json) settings."

new=$(find_id "$name")
if [ -z "$new" ]; then
  jq -n --arg owner "$owner" --arg name "$name" --slurpfile env /tmp/env.json '{
    type: "web_service", name: $name, ownerId: $owner,
    repo: "https://github.com/farahbrunache/opa", branch: "main", autoDeploy: "no",
    envVars: $env[0],
    serviceDetails: {
      runtime: "node", plan: "free", region: "ohio", healthCheckPath: "/robots.txt",
      envSpecificDetails: { buildCommand: "npm install --omit=dev", startCommand: "node server.js" }
    }
  }' > /tmp/create.json
  r -X POST --data @/tmp/create.json "$api/services" > /tmp/created.json \
    || die "Render refused the new service: $(jq -c '.message // .' /tmp/created.json)"
  new=$(jq -r '.service.id' /tmp/created.json)
  deploy=$(jq -r '.deployId // empty' /tmp/created.json)
else
  r -X PUT --data @/tmp/env.json "$api/services/$new/env-vars" > /dev/null || die "Could not write settings."
  deploy=""
fi
echo "New service: $new"
if [ -z "$deploy" ]; then
  deploy=$(r -X POST -d '{"clearCache":"do_not_clear"}' "$api/services/$new/deploys" | jq -r '.id')
fi

for _ in $(seq 1 80); do
  sleep 15
  status=$(r "$api/services/$new/deploys/$deploy" | jq -r '.status // "unknown"')
  case "$status" in
    live) break ;;
    build_failed|update_failed|pre_deploy_failed|canceled) die "New service deploy ended as $status. Old service is untouched and still serving." ;;
    *) echo "  $status…" ;;
  esac
done
[ "$status" = live ] || die "New service not live after 20 minutes. Old service still serving."
url=$(r "$api/services/$new" | jq -r '.serviceDetails.url')
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 120 "$url/robots.txt" || true)
[ "$code" = 200 ] || die "New service answered $code at $url. Old service still serving."
echo "New service live at $url"

if r "$api/services/$old/custom-domains" | jq -e --arg d "$domain" 'map(.customDomain.name) | index($d)' > /dev/null; then
  r -X DELETE "$api/services/$old/custom-domains/$domain" > /dev/null || die "Could not remove $domain from the old service."
fi
if ! r "$api/services/$new/custom-domains" | jq -e --arg d "$domain" 'map(.customDomain.name) | index($d)' > /dev/null; then
  r -X POST -d "{\"name\":\"$domain\"}" "$api/services/$new/custom-domains" > /tmp/domain.json \
    || die "Could not add $domain to the new service: $(head -c 400 /tmp/domain.json)"
fi
r -X POST "$api/services/$new/custom-domains/$domain/verify" > /dev/null || true

r -X POST "$api/services/$old/suspend" > /dev/null || die "Could not suspend the old service."

host=${url#https://}
{
  echo "## Rebuilt on the free plan"
  echo
  echo "- New service: \`$name\`, $url"
  echo "- Old service: \`$old_name\`, suspended"
  echo "- DNS: \`$domain\` CNAME → \`$host\`"
} >> "$GITHUB_STEP_SUMMARY"
echo "Done. Point $domain (CNAME) at $host."
