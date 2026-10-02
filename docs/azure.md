# Azure — hosting, data, deploy, cutover

The voice agents run on **Microsoft Azure**, in the same environment as the marketing hub
(`axxiommarketinghub`, branch `feat/azure-migration`) and built the same way. This replaces
**Railway** (backend), **Netlify** (dashboard) and **Supabase** (database, auth, realtime).

- Resource group **`Axxiom-devs-foundry`** · subscription "Axxiom AI Dev" · tenant `50a5de4c-b021-4ab1-8c07-99221c6456ba`
- **Zach** (Data Engineering) owns the environment: resources, role assignments, the Postgres server, firewall.
- **Luke** owns the code and deploys it (Website Contributor on the app, Key Vault Secrets Officer, Entra login on Postgres). Anything needing `roleAssignments/write` goes through Zach.

## What runs where

```
 Callee ◄─Twilio─► Vapi (Deepgram → Claude → voice) ──webhooks──┐
                                                                │ x-vapi-secret
 Operator's browser ──https (same origin, session cookie)───┐   │
                                                            ▼   ▼
   ┌──────────── App Service: app-axxiom-voice-agents (Linux, Node 22, Always-On, 1 instance) ───────────┐
   │  node dist/server.mjs  — one Hono service:                                                           │
   │    /vapi/webhook   inbound + outbound handlers        /outbound/*  dashboard API (cookie auth)       │
   │    /outbound/events  live SSE stream (replaces Supabase Realtime)                                    │
   │    /auth/*   sign-in (replaces Supabase Auth)         /  the dashboard (Next.js static export)       │
   │    campaign worker (15 s tick)                         identity: umi-axxiom-voice (managed)         │
   └──────┬──────────────────────────────┬──────────────────────────────┬────────────────────────────────┘
          │ Entra token (no password)    │ Key Vault references         │ Vapi / Twilio / GHL / Anthropic
          ▼                              ▼                              ▼
   psql-axxiom-marketing / axxiom_hub   kv-axxiom-voice               SaaS APIs (unchanged)
   (PostgreSQL 18, East US 2)           (this app's own vault)
     outbound.*          ◄── also read by the marketing hub (Voice page, report emails, agent service)
     public.ax_voice_call ◄── and mirrored to Fabric for Power BI
```

| Piece | Before | On Azure |
|---|---|---|
| Backend | Railway (Docker, Bun) | **App Service** `app-axxiom-voice-agents`, Node 22, zip deploy of one bundled file |
| Dashboard | Netlify (Next.js runtime) | **Same App Service** — static export served by the backend (same origin: no CORS, no second host) |
| Database | Supabase Postgres (Tokyo region) | **Azure Database for PostgreSQL** `psql-axxiom-marketing`, database `axxiom_hub` — same server/DB as the hub, same table names |
| DB credentials | service-role key (static JWT, bypasses RLS) | **None** — the app's managed identity gets an Entra token, presented as the Postgres password |
| Dashboard login | Supabase Auth | App accounts in `outbound.dashboard_user` (scrypt), HMAC-signed httpOnly session cookie |
| Live updates | Supabase Realtime (browser ↔ Postgres) | **SSE** from the backend (`/outbound/events`), fed by every write the backend makes |
| Secrets | Railway / Netlify env vars | **Key Vault** `kv-axxiom-voice` (this app's own), referenced from app settings |

Side benefit: the database moves from Supabase's Tokyo region to East US 2 — every query a
live-call tool webhook makes stops paying a trans-Pacific round trip.

## Identity & secrets

- **`umi-axxiom-voice`** — user-assigned managed identity attached to the app (client id
  `cb028d83-b150-41d6-92bf-a80cee2613a7`). It is a **Postgres role** (grants in
  `scripts/azure/sql/voice_schema.sql`) and **Key Vault Secrets User** on `kv-axxiom-voice`. No database password or connection string exists anywhere.
  (Reusing the hub's `umi-marketing-functions` also works — set `UMI=umi-marketing-functions`
  for the settings script and `voice.app_role` in the SQL — but then this app can write every hub
  table and vice versa. A dedicated identity keeps lead PII and the hub's 47 secrets apart.)
- **Postgres auth** (`src/lib/pg/backend.ts`, same as the hub): `DefaultAzureCredential` with
  `AZURE_PG_CLIENT_ID` → token for `https://ossrdbms-aad.database.windows.net/.default`, cached
  until 5 min before expiry, fetched per new pool connection. Locally / in Cloud Shell the same
  chain uses your `az login` (`AZURE_PG_USER` = your Entra email).
- **Secrets** are app-setting **references**: `@Microsoft.KeyVault(SecretUri=https://kv-axxiom-voice.vault.azure.net/secrets/vapi-api-key/)`.
  Name rule: env name lowercased, `_`→`-` (same as the hub). The vault is this app's alone, so
  no prefix; you have Secrets Officer on it through a group.
  Secret set: `VAPI_API_KEY`, `VAPI_SERVER_SECRET`, `VAPI_JWT_SECRET`, `DASHBOARD_SESSION_SECRET`,
  `ANTHROPIC_API_KEY` (**the Azure AI Foundry key** — copied from the hub vault's `foundry-api-key`;
  the settings script refuses an Anthropic-issued `sk-ant-` key), `ELEVENLABS_API_KEY`,
  `GHL_ACCESS_TOKEN`, `TWILIO_AUTH_TOKEN`.
- **AI stays inside Azure**: server-side Claude (insights, system analysis, transcript analysis)
  calls Foundry's Anthropic endpoint (`ANTHROPIC_BASE_URL=https://axxiom-ai.services.ai.azure.com/anthropic`,
  deployment `ANTHROPIC_MODEL=claude-sonnet-4-6`, 50K tokens/min; `claude-fable-5-1` has 250K if
  rate limits appear). The **voice agents' own model** (`VOICE_MODEL`) runs inside Vapi, which calls
  its model provider itself — moving that into Foundry is a separate decision (see Open items).
- The app must be told which identity resolves references (`keyVaultReferenceIdentity` = the UMI's
  resource id) — `sync-app-settings.sh --apply` sets it. Without it the references show **not
  Resolved** and the values arrive empty (which looks like "not configured", not like an auth error).

## Database

- Schema: **`scripts/azure/sql/voice_schema.sql`** — the consolidated final state of
  `scripts/sql/outbound_schema.sql` + `ax_voice_call.sql` minus everything Supabase-specific
  (no anon/authenticated roles, RLS policies or Realtime publication — only this service connects).
  Every column/type/default was diffed against the Supabase-built schema: identical, plus the new
  `outbound.dashboard_user`. Idempotent — re-run after pulling schema changes.
- Access: `voice.app_role` (the app's identity) gets read/write on `outbound.*` +
  `public.ax_voice_call`; `voice.reader_role` (the hub's identity) gets read-only — **never**
  `dashboard_user`.
- The data layer (`src/lib/dataClient.ts`) keeps the Supabase query-builder dialect: on
  `DATA_BACKEND=azure` it is the hub's PostgREST-compatible **pg shim** (`src/lib/pg/shim.ts`,
  contract-tested in `shim.test.ts`), so the ~150 existing `db().from(…)` call sites didn't change.
  Our copy fixes one behavior of the hub's: `undefined` values in an update/insert are *not
  provided* (like supabase-js), not `NULL` — see the shim header.
- `DATA_BACKEND=supabase` still works (legacy client) for the transition and as the in-window
  rollback lever. Remove it (and `@supabase/supabase-js`) once Supabase is decommissioned.
- **No laptop access**: the server firewall allows Azure services only. Admin SQL runs in
  **Azure Cloud Shell** (upload the file; Cloud Shell has no repo checkout). Connect:
  ```bash
  export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
  psql "host=psql-axxiom-marketing.postgres.database.azure.com dbname=axxiom_hub user=luke.fernandez@axxiomelevator.com sslmode=require"
  ```
  Your login defaults to role `dataservices@…`; the SQL files start with
  `set role "luke.fernandez@axxiomelevator.com"` so you own what they create.

## Dashboard accounts

Invite-only, no signup. Laptops can't reach the database, so generate the SQL and paste it into
Cloud Shell psql:

```bash
bun run dashboard-user add someone@axxiomelevator.com --name "Some One" --sql   # prints SQL + a one-time password
bun run dashboard-user reset someone@axxiomelevator.com --sql                   # new password, signs out everywhere
bun run dashboard-user disable someone@axxiomelevator.com --sql
```

Operators change their own password from the header menu. Sessions last 12 h
(`DASHBOARD_SESSION_HOURS`) and renew while active. Supabase Auth accounts are **not** migrated —
everyone gets a fresh one-time password. (A later option: Microsoft sign-in via App Service
authentication, which needs an Entra app registration from Zach.)

## Deploying

Deploys run from a developer machine with the Azure CLI (`az login --tenant 50a5de4c-b021-4ab1-8c07-99221c6456ba`)
until a GitHub Actions pipeline exists. **Commit first** — the package script refuses a dirty tree.

| Step | Command | What happens |
|---|---|---|
| Settings | `./scripts/azure/sync-app-settings.sh` then `--apply` | Loads missing secrets from `.env` into the vault, writes KV references + config, sets `DATA_BACKEND=azure`, identity, `SERVER_URL`, startup `node --enable-source-maps dist/server.mjs`, Always-On, health check `/health`. `DIALER_ENABLED` is defaulted to `false` on first run and **never changed afterwards** by the script. |
| Package + deploy | `./scripts/azure/package-app.sh --deploy` | Typechecks, bundles the backend (`dist/server.mjs`, all deps inlined), builds the dashboard export (`public/`), zips with a `VERSION` file, `az webapp deploy --async`. Nothing is installed server-side (`SCM_DO_BUILD_DURING_DEPLOYMENT=false`) — no Oryx, no version drift. |
| Verify | `curl https://<host>/health` → `version` = your sha · `/ready` → `connectedAs: umi-axxiom-voice` | `/ready` is the end-to-end identity → token → Postgres → schema proof. |
| Agent config | Dashboard → Agent studio → **Re-sync Vapi assistants** | Server-side replacement for the `create-*-assistant` scripts (which need the database). Pushes prompts/tools/voices/approved prompt overrides and points every webhook at `SERVER_URL`. Run after any deploy that changes `src/assistant/**`. |

Rules carried over from the hub: never change app settings while a deploy is running; a 502 from
`az webapp deploy` usually means the CLI timed out, not that the deploy failed (check `/health`'s
version); Key Vault references are cached — after rotating a secret re-run
`sync-app-settings.sh --apply` **and** restart; `az login` dies with every password reset
(`AADSTS50173` → `az logout && az login --tenant …`).

**Run exactly one instance.** The campaign worker, per-call state and the SSE change bus are
in-memory. Never scale out.

## What's needed from Zach (one session, ~20 min)

1. **App Service** `app-axxiom-voice-agents` — Linux, `NODE:22-lts`, Always-On. **Region: East
   US 2 if there's quota** (same region as the database: live-call tool webhooks make several
   queries each); otherwise the hub's West Central US plan `asp-axxiom-mktg-hub` (30–40 ms per query).
   B1 is enough; it is one lightweight process.
   ```bash
   az webapp create -g Axxiom-devs-foundry -p <plan> -n app-axxiom-voice-agents --runtime "NODE:22-lts"
   az webapp config set -g Axxiom-devs-foundry -n app-axxiom-voice-agents --always-on true
   ```
2. **Identity** `umi-axxiom-voice`, attached to the app:
   ```bash
   az identity create -g Axxiom-devs-foundry -n umi-axxiom-voice
   az webapp identity assign -g Axxiom-devs-foundry -n app-axxiom-voice-agents \
     --identities $(az identity show -g Axxiom-devs-foundry -n umi-axxiom-voice --query id -o tsv)
   ```
3. **Key Vault**: `Key Vault Secrets User` on the app's vault (`kv-axxiom-voice`) for `umi-axxiom-voice`; Secrets Officer for Luke. *(Done 2026-10.)*
4. **Postgres** (as an Entra admin of `psql-axxiom-marketing`, database `axxiom_hub`):
   ```sql
   -- in database postgres:
   select * from pgaadauth_create_principal('umi-axxiom-voice', false, false);
   -- in database axxiom_hub:
   grant connect on database axxiom_hub to "umi-axxiom-voice";
   grant create on database axxiom_hub to "luke.fernandez@axxiomelevator.com";  -- so voice_schema.sql can create schema outbound
   select tableowner from pg_tables where schemaname = 'public' and tablename = 'ax_voice_call';
   -- if that returns a row NOT owned by Luke: it never held real voice data on Azure (the hub's
   -- cutover excluded it), so drop it and voice_schema.sql recreates it:
   -- drop table public.ax_voice_call;
   ```
5. **Luke**: Website Contributor on the new app (deploys + settings).
6. Optional: Application Insights connection string on the app; later, add `outbound.*` +
   `public.ax_voice_call` to the Fabric mirror "Axxiom Marketing Server".

## Cutover runbook

**Invariants** (same as the hub's): *never two dialers* — the Azure app keeps
`DIALER_ENABLED=false` until the old stack is idle; and *flip only after a verified copy* —
`migrate_from_supabase.py` proves exact row counts **and** content checksums per table.

**0. Before the window** (any time):
- Zach's steps above done; `voice_schema.sql` applied in Cloud Shell (check its last query: every
  table owned by you, no WARNINGs).
- `sync-app-settings.sh --apply` (generate `DASHBOARD_SESSION_SECRET` first, ≥ 32 chars) →
  `package-app.sh --deploy` → `/ready` green, Configuration blade shows every reference **Resolved**.
- Create the operators' accounts (`dashboard-user add … --sql` → Cloud Shell).
- **Rehearsal**: in Cloud Shell `python3 migrate_from_supabase.py` (trial copy — Railway keeps
  running untouched, the Azure app can't dial and Vapi still posts to Railway). Sign in to the Azure
  dashboard and compare campaigns/leads/analytics with the old one. Re-run as often as you like.
- Disconnect Railway's and Netlify's GitHub auto-deploy (so merging this branch to `main` can't
  redeploy the old stack with the new code).

**1. The window** (~30 min, after the calling window has closed in every lead timezone):
1. Old dashboard: **pause every campaign**; wait for "Idle" (no live calls).
2. Take the old dashboard offline (Netlify → site → stop builds / delete) so nobody restarts a campaign there.
3. Cloud Shell: `python3 migrate_from_supabase.py --final` → **`0 mismatches`**. (It refuses while
   anything is running or live on Supabase.) Note the time.
4. Turn Azure on: `az webapp config appsettings set -g Axxiom-devs-foundry -n app-axxiom-voice-agents --settings DIALER_ENABLED=true` (restarts ~1 min).
5. Azure dashboard → Agent studio → **Re-sync Vapi assistants** → every item `updated`, webhook = the Azure URL.
   This moves inbound + outbound webhooks (and any phone number still pointing at Railway).
   Also check Vapi dashboard → Org settings → Server URL, if one is set there.
6. Stop the Railway service.
7. Smoke test: Agent studio → test call to your own phone (live transcript streams, then it lands in
   Call history); call the inbound number once (a row in `public.ax_voice_call`).
8. Stragglers: inbound calls answered between step 3 and step 5 were logged on Supabase only —
   `select count(*) from public.ax_voice_call where created_at > '<step-3 time>'` on Supabase; re-insert if any.
9. Operators sign in on Azure and start campaigns.

**Rollback** (only clean inside the window): `DIALER_ENABLED=false` on Azure; start Railway; from
a laptop on `main`, re-run the `create-*-assistant` scripts with `SERVER_URL`=the Railway URL
(they still read Supabase). Anything written to Azure after step 4 would need copying back.

**2. After** (the following week):
- Merge `feat/azure-migration` → `main`; delete the Railway project and the Netlify site.
- **Hub follow-up** (axxiommarketinghub, `src/lib/supabase/admin.ts`): its hybrid client still sends
  `schema("outbound")` to Supabase — route `outbound` to Azure Postgres, or the hub's Voice page,
  brand report emails and agent service keep showing the frozen Supabase copy. (Its
  `public.ax_voice_call` reads already go to Azure — and start returning data after step 3.)
- Fabric: include `outbound.*` + `public.ax_voice_call` in the Azure Postgres mirror; drop
  `ax_voice_call` from the legacy `supabase_mirror` notebook.
- Supabase can be switched off only when the hub's remaining schemas (Meta, aeo, apollo_agent,
  social) and storage buckets have moved too — the voice app is one of five tenants there.
- Then remove `DATA_BACKEND=supabase` + `@supabase/supabase-js` from this repo.

## Open items (decisions pending)

- **Transfer number** (`TRANSFER_PHONE_NUMBER`): not set in production or here, so the agents have
  no transfer-to-a-person tool — a trapped/injured caller is told to dial 911 instead of being
  handed to someone. Set it, then run the assistant sync.
- **Inbound booking**: GoHighLevel credentials are not set anywhere (booking/lookup fail today);
  waiting on whether booking moves to Azure/Microsoft calendars instead.
- **Voice agents' model**: Vapi calls the agents' model provider itself, outside Azure. Keeping the
  whole conversation inside Azure means pointing Vapi at a Foundry deployment (or replacing the
  Vapi/Deepgram/ElevenLabs/Twilio stack with Azure services) — a product decision, not done here.

## Local development

- Database: a local PostgreSQL 18 (`brew install postgresql@18`), with `voice_schema.sql` applied
  (create stand-in roles `luke.fernandez@axxiomelevator.com` and your app role first, or edit the
  settings block), and in `.env`: `DATA_BACKEND=azure AZURE_PG_HOST=127.0.0.1
  AZURE_PG_DATABASE=… AZURE_PG_USER=… AZURE_PG_PASSWORD=… AZURE_PG_SSL=disable`.
  No production PII on laptops.
- `bun run dev` (API :3000) + `cd web && npm run dev` (:3001, proxies `/outbound` + `/auth` to the API).
- `bun test` — shim contract tests against a throwaway Postgres (needs the postgresql@18 binaries).
- `npm run build && npm run start:node` runs the exact production bundle under Node.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `/ready` 503, `databaseError` mentions a token | Identity chain: `AZURE_PG_USER=umi-axxiom-voice` + `AZURE_PG_CLIENT_ID` set, the UMI attached to the app, and a Postgres role for it (`pgaadauth_create_principal`). |
| `/ready` 503, `outboundSchemaError: permission denied` | The Postgres role exists but lacks grants — re-run `voice_schema.sql` (grants block) with the right `voice.app_role`. |
| A setting shows the literal `@Microsoft.KeyVault(…)` / feature "not configured" | Reference not resolved: identity lacks Secrets User on `kv-axxiom-voice`, `keyVaultReferenceIdentity` not set (re-run the settings script), or the secret name is wrong (lowercase, dashes). |
| Every dashboard request 503 "auth not configured" | `DASHBOARD_SESSION_SECRET` missing or shorter than 32 characters. |
| Banner "Dialing is disabled on this instance" | `DIALER_ENABLED=false` — intended until cutover step 4. |
| Calls happen but nothing reaches the app | Vapi still posts to the old host — run **Re-sync Vapi assistants**; check Vapi's org-level Server URL. |
| Live panels stop updating | The SSE stream dropped; the browser reconnects within ~5 s and every panel refetches. Persistent: check the app log for `/outbound/events` errors. |
| `/health` shows an older `version` | The deploy didn't land (or is still in progress) — `az webapp log deployment show -g Axxiom-devs-foundry -n app-axxiom-voice-agents`. |
| Logs | `az webapp log tail -g Axxiom-devs-foundry -n app-axxiom-voice-agents` (JSON lines; phones/emails masked). |
