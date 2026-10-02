#!/bin/zsh
# Package the voice agents service for Azure App Service (Linux, Node 22) and
# optionally deploy it. One artifact carries everything:
#   dist/server.mjs  — the backend, dependencies bundled in (scripts/build.mjs)
#   public/          — the dashboard (Next.js static export of web/), served by it
#   package.json     — runtime-only, NO dependencies: nothing is installed on
#                      the server (SCM_DO_BUILD_DURING_DEPLOYMENT=false)
#   VERSION          — git sha, reported by GET /health so you can see what runs
#
#   ./scripts/azure/package-app.sh            # typecheck + build + zip → .azure-stage/app.zip
#   ./scripts/azure/package-app.sh --deploy   # ...and az webapp deploy (async)
#
# Deploys ship COMMITTED code: --deploy refuses a dirty tree (other machines
# deploy from git, so an uncommitted change silently misses their deploys).
# Never change app settings while a deploy is running — it restarts the
# container mid-deploy. A 502 from the CLI is not a failed deploy; check
# `az webapp log deployment show` / GET /health's version.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="${APP:-app-axxiom-voice-agents}"
RG="${RG:-Axxiom-devs-foundry}"
STAGE=".azure-stage"
DEPLOY=false; [[ "${1:-}" == "--deploy" ]] && DEPLOY=true

JS_RUNNER=$(command -v node || command -v bun) || { echo "need node or bun on PATH"; exit 1; }
VERSION="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!web/out' 2>/dev/null || echo "-dirty")"
if $DEPLOY && [[ "$VERSION" == *-dirty ]]; then
  echo "STOP: uncommitted changes — commit (and push) first, then deploy."; exit 1
fi

echo "== typecheck (backend + dashboard) =="
npx --no-install tsc --noEmit
(cd web && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npx --no-install tsc --noEmit -p tsconfig.json)

echo "== backend bundle =="
"$JS_RUNNER" scripts/build.mjs

echo "== dashboard (static export) =="
# The dashboard only talks to its own origin; make sure no stale API base or
# Supabase values from a local web/.env.local can leak into the build.
(cd web && rm -rf out && env -u NEXT_PUBLIC_API_BASE -u NEXT_PUBLIC_SUPABASE_URL -u NEXT_PUBLIC_SUPABASE_ANON_KEY npx --no-install next build >/dev/null)
[[ -f web/out/index.html ]] || { echo "dashboard export missing web/out/index.html"; exit 1; }

rm -rf "$STAGE" && mkdir -p "$STAGE/dist"
cp dist/server.mjs dist/server.mjs.map "$STAGE/dist/"
cp -R web/out "$STAGE/public"
echo "$VERSION" > "$STAGE/VERSION"
cat > "$STAGE/package.json" <<'JSON'
{
  "name": "axxiom-voice-agents",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": { "start": "node --enable-source-maps dist/server.mjs" }
}
JSON
(cd "$STAGE" && rm -f app.zip && zip -qr app.zip dist public package.json VERSION)
ls -lh "$STAGE/app.zip" | awk -v v="$VERSION" '{print "package:", $5, $9, "version", v}'

if $DEPLOY; then
  echo "== deploying $VERSION to $APP (async) =="
  az webapp deploy -g "$RG" -n "$APP" --src-path "$STAGE/app.zip" --type zip --clean true --async true -o none
  echo "submitted — verify: curl -s https://\$(az webapp show -g $RG -n $APP --query defaultHostName -o tsv)/health  (version $VERSION)"
fi
