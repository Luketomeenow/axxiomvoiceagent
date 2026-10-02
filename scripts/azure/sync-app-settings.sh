#!/bin/zsh
# Push this service's environment to its Azure App Service, the same way the
# marketing hub does it (axxiommarketinghub/scripts/azure/sync-app-settings.sh):
#   secrets → @Microsoft.KeyVault(...) references (loaded into the vault from
#             .env first if the vault doesn't have them yet)
#   config  → plain app settings
#   Azure   → data backend, identity, SERVER_URL, startup command, Always-On,
#             health check, Key Vault reference identity
#
#   ./scripts/azure/sync-app-settings.sh            # dry-run (prints names, never values)
#   ./scripts/azure/sync-app-settings.sh --apply
#
# Vault: the app's OWN vault, kv-axxiom-voice (Zach, 2026-10). Secret name =
# env name lowercased, "_" → "-" (VAPI_API_KEY → vapi-api-key). SECRET_PREFIX
# exists only for a shared vault (e.g. SECRET_PREFIX=voice- in kv-axxiom-marketing,
# where the hub has its own, different ANTHROPIC_API_KEY).
#
# DIALER_ENABLED is only ever DEFAULTED (to false, on first setup) — a re-run
# never changes it. Flip it deliberately at cutover:
#   az webapp config appsettings set -g Axxiom-devs-foundry -n app-axxiom-voice-agents --settings DIALER_ENABLED=true
#
# KV-cache rule (cost the hub most of 9/11): references are cached; after
# rotating a secret, re-run this with --apply and restart — a restart alone
# keeps serving the old value.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="${APP:-app-axxiom-voice-agents}"
RG="${RG:-Axxiom-devs-foundry}"
VAULT="${VAULT:-kv-axxiom-voice}"
PREFIX="${SECRET_PREFIX-}"
UMI="${UMI:-umi-axxiom-voice}"                 # the app's user-assigned managed identity
PG_HOST="${PG_HOST:-psql-axxiom-marketing.postgres.database.azure.com}"
PG_DATABASE="${PG_DATABASE:-axxiom_hub}"
# Server-side Claude goes through Azure AI Foundry, never api.anthropic.com.
FOUNDRY_ANTHROPIC_URL="${FOUNDRY_ANTHROPIC_URL:-https://axxiom-ai.services.ai.azure.com/anthropic}"
ENV_FILE="${ENV_FILE:-.env}"
APPLY=false; [[ "${1:-}" == "--apply" ]] && APPLY=true

SECRETS=(
  VAPI_API_KEY VAPI_SERVER_SECRET VAPI_JWT_SECRET
  DASHBOARD_SESSION_SECRET
  ANTHROPIC_API_KEY ELEVENLABS_API_KEY
  GHL_ACCESS_TOKEN
  TWILIO_AUTH_TOKEN
)
CONFIG=(
  VAPI_ASSISTANT_ID VAPI_PHONE_NUMBER_ID OUTBOUND_ASSISTANT_ID
  TWILIO_ACCOUNT_SID
  GHL_LOCATION_ID GHL_CALENDAR_ID GHL_PIPELINE_ID GHL_PIPELINE_STAGE_ID GHL_TIMEZONE
  TRANSFER_PHONE_NUMBER EMERGENCY_INSTRUCTION
  ELEVENLABS_VOICE_ID ELEVENLABS_AGENT_ID
  ANTHROPIC_MODEL VOICE_PROVIDER VOICE_MODEL ENABLE_TRANSCRIPT_ANALYSIS INSIGHT_EVERY_N_CALLS INSIGHT_CALLS_LIMIT
  OUTBOUND_TIMEZONE CALL_WINDOW_START CALL_WINDOW_END MAX_CONCURRENT_CALLS MAX_CALL_ATTEMPTS
  RETRY_BACKOFF_MINUTES MAX_CALLS_PER_NUMBER_PER_DAY PII_RETAIN_DAYS ENABLE_VOICEMAIL_DETECTION
  DASHBOARD_SESSION_HOURS
  COMPANY_NAME AGENT_NAME SERVICE_AREA BUSINESS_HOURS BOOKING_TYPE
)

envval() {
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v key="$1" '$0 ~ "^"key"=" {print substr($0, index($0,"=")+1); exit}' "$ENV_FILE" |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

HOST="$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
# Read the identity from the web app (Website Contributor on the app is enough —
# no read access on the identity resource itself needed).
UMI_PAIR="$(az webapp identity show -g "$RG" -n "$APP" -o json | python3 -c '
import json, sys
name = sys.argv[1].lower()
for rid, v in ((json.load(sys.stdin) or {}).get("userAssignedIdentities") or {}).items():
    if rid.lower().endswith("/userassignedidentities/" + name):
        print(rid, v["clientId"])
' "$UMI")"
if [[ -z "$UMI_PAIR" ]]; then echo "STOP: identity $UMI is not attached to $APP yet (az webapp identity assign)"; exit 1; fi
UMI_ID="${UMI_PAIR%% *}"
UMI_CLIENT_ID="${UMI_PAIR##* }"
CURRENT_DIALER="$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='DIALER_ENABLED'].value | [0]" -o tsv 2>/dev/null || true)"

settings=(
  "NODE_ENV=production"
  "SCM_DO_BUILD_DURING_DEPLOYMENT=false"   # the zip is a self-contained bundle — nothing to install
  "SERVER_URL=https://$HOST"
  "DATA_BACKEND=azure"
  "AZURE_PG_HOST=$PG_HOST"
  "AZURE_PG_DATABASE=$PG_DATABASE"
  "AZURE_PG_USER=$UMI"                     # the Postgres role Zach created for the identity
  "AZURE_PG_CLIENT_ID=$UMI_CLIENT_ID"
  "DASHBOARD_DIR=public"
  "ANTHROPIC_BASE_URL=$FOUNDRY_ANTHROPIC_URL"   # + a Foundry key in the vault as anthropic-api-key
)
if [[ -z "$CURRENT_DIALER" ]]; then
  settings+=("DIALER_ENABLED=false")       # first setup: never two dialers — flip at cutover
  echo "note   DIALER_ENABLED not set on $APP yet → false (flip to true at cutover)"
else
  echo "keep   DIALER_ENABLED=$CURRENT_DIALER (this script never changes it)"
fi

for var in "${SECRETS[@]}"; do
  name="${PREFIX}$(echo "$var" | tr 'A-Z_' 'a-z-')"
  if ! az keyvault secret show --vault-name "$VAULT" --name "$name" --query name -o tsv >/dev/null 2>&1; then
    val="$(envval "$var")"
    if [[ -z "$val" ]]; then echo "skip   $var (not in vault, not in $ENV_FILE)"; continue; fi
    if [[ "$var" == "ANTHROPIC_API_KEY" && "$val" == sk-ant-* ]]; then
      echo "STOP: .env has an Anthropic-issued key (sk-ant-…). This app must use the Azure AI Foundry key —"
      echo "      put it in $VAULT as $name first (it's foundry-api-key in kv-axxiom-marketing)."; exit 1
    fi
    if [[ "$var" == "DASHBOARD_SESSION_SECRET" && ${#val} -lt 32 ]]; then
      echo "STOP: DASHBOARD_SESSION_SECRET must be >= 32 characters (it would be ignored and auth would fail closed)"; exit 1
    fi
    $APPLY && az keyvault secret set --vault-name "$VAULT" --name "$name" --value "$val" --query name -o tsv >/dev/null
    echo "vault+ $name"
  fi
  settings+=("$var=@Microsoft.KeyVault(SecretUri=https://$VAULT.vault.azure.net/secrets/$name/)")
done
for var in "${CONFIG[@]}"; do
  val="$(envval "$var")"
  [[ -z "$val" ]] && continue
  settings+=("$var=$val")
done

echo "${#settings[@]} settings prepared for $APP ($(printf '%s\n' "${settings[@]}" | grep -c KeyVault) vault refs) → https://$HOST"
if $APPLY; then
  # Key Vault references resolve with the USER-ASSIGNED identity only when the
  # app is told to use it (default is the system identity, which this app may not have).
  # Changing it needs Managed Identity Operator on the UMI (Zach) — so only try
  # when it isn't already right.
  CURRENT_KV_ID="$(az webapp show -g "$RG" -n "$APP" --query keyVaultReferenceIdentity -o tsv)"
  if [[ "${CURRENT_KV_ID:l}" != "${UMI_ID:l}" ]]; then
    az webapp update -g "$RG" -n "$APP" --set keyVaultReferenceIdentity="$UMI_ID" -o none ||
      { echo "STOP: set keyVaultReferenceIdentity=$UMI_ID on $APP (needs Managed Identity Operator on $UMI — ask Zach)"; exit 1; }
  else
    echo "keep   keyVaultReferenceIdentity = $UMI (already set)"
  fi
  az webapp config appsettings set -g "$RG" -n "$APP" --settings "${settings[@]}" --query "length(@)" -o tsv
  az webapp config set -g "$RG" -n "$APP" \
    --startup-file "node --enable-source-maps dist/server.mjs" --always-on true \
    --generic-configurations '{"healthCheckPath": "/health"}' -o none
  echo "applied (+ startup command, Always-On, health check /health, KV reference identity)."
else
  printf '%s\n' "${settings[@]}" | sed -E '/KeyVault|NODE_ENV|SCM_|SERVER_URL|DATA_BACKEND|AZURE_PG|DASHBOARD_DIR|DIALER|ANTHROPIC_BASE_URL|_MODEL/!s/=.*/=<value>/'
  echo "dry run — add --apply to write."
fi
