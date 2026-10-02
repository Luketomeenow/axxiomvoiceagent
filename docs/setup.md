# Setup & Deployment

## Prerequisites

- **[Bun](https://bun.sh) 1.1+** for local dev (`bun run dev`, `bun test`). Production runs the bundled server on **Node 22** (Azure App Service); the CLI scripts also have Node fallbacks (via `tsx`).
- **Azure**: the App Service, managed identity, Key Vault and Postgres access described in [azure.md](azure.md) (Zach provisions; one-time).
- For local dev, **PostgreSQL 18** (`brew install postgresql@18`) — the same major as Azure; `bun test` uses it too.
- A **Vapi** account, with your **ElevenLabs** key added in Vapi → Provider Keys (only needed for ElevenLabs-voiced assistants).
- A **Twilio** account — your own DIDs are imported into Vapi as per-brand caller IDs, and Twilio is the authoritative source for telephony cost/status.
- A **GoHighLevel** (LeadConnector v2) account — for the inbound CRM flow.

## Install & run locally

```bash
bun install
cp .env.example .env        # fill in keys (see "Environment" below)
bun run dev                 # server on http://localhost:3000 (watch mode)
bun run typecheck           # tsc --noEmit — the static gate
bun test                    # data-layer contract tests (throwaway local Postgres)
npm run build && npm run start:node   # the exact production bundle, under Node
```

Expose the local server so Vapi can reach it during testing (e.g. `ngrok http 3000`) and set `SERVER_URL` to that public URL.

> **Local webhook testing:** `/vapi/webhook` **fails closed** (503) when `VAPI_SERVER_SECRET` is unset. Either set the secret locally too, or set `ALLOW_INSECURE_WEBHOOK=true` — local dev only, never in production.

### No Bun? Node fallbacks

`npm run build && npm run start:node` runs the server under Node; the seed/admin scripts run under Node + `tsx`:

```bash
npm install
npm run import-leads:node
npm run import-codes:node
npm run create-outbound-assistant:node
npm run create-assistant:node
```

## Environment

All config is read through `src/config/env.ts`. **The server boots even with missing keys** (so the App Service health check passes on first deploy); each feature logs a warning and the `assert*()` helpers throw a clear error only when an unconfigured feature is actually used. See `.env.example` for the annotated list. Key groups:

| Group | Vars |
|-------|------|
| Server | `PORT`, `SERVER_URL` (the public URL — Vapi webhook target) |
| Database | `DATA_BACKEND` (`azure` \| `supabase`; unset = azure when `AZURE_PG_USER` is set), `AZURE_PG_HOST`, `AZURE_PG_PORT`, `AZURE_PG_DATABASE`, `AZURE_PG_USER`, `AZURE_PG_CLIENT_ID` (App Service), `AZURE_PG_PASSWORD` + `AZURE_PG_SSL=disable` (local Postgres only), `AZURE_PG_POOL_MAX` |
| Dialer gate | `DIALER_ENABLED` (default `true`; `false` on any instance that must not place calls) |
| Vapi | `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_SERVER_SECRET` (**required** — webhook fails closed without it), `ALLOW_INSECURE_WEBHOOK` (local dev only) |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — caller-ID import script + per-call cost/status sync |
| Outbound dialing | `OUTBOUND_ASSISTANT_ID` (fallback assistant), `OUTBOUND_TIMEZONE`, `CALL_WINDOW_START`/`END` (8–21), `MAX_CONCURRENT_CALLS`, `MAX_CALL_ATTEMPTS`, `RETRY_BACKOFF_MINUTES`, `MAX_CALLS_PER_NUMBER_PER_DAY`, `ENABLE_VOICEMAIL_DETECTION` (set `true` for live campaigns) |
| Data lifecycle | `PII_RETAIN_DAYS` (retention purge default), `INSIGHT_EVERY_N_CALLS` (auto campaign-analysis cadence) |
| Dashboard auth | `DASHBOARD_SESSION_SECRET` (**required**, ≥ 32 chars — signs the session cookie; auth fails closed without it), `DASHBOARD_SESSION_HOURS` (default 12), `DASHBOARD_DIR` (the built dashboard; default `public`), `DASHBOARD_ORIGIN` (extra cross-origin dashboards — normally empty) |
| GoHighLevel | `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`, `GHL_CALENDAR_ID`, `GHL_PIPELINE_ID`, `GHL_PIPELINE_STAGE_ID`, `GHL_TIMEZONE` |
| Transfer / safety | `TRANSFER_PHONE_NUMBER`, `EMERGENCY_INSTRUCTION` |
| Voice + LLM | `ELEVENLABS_VOICE_ID`, `ANTHROPIC_API_KEY` (insights + transcript analysis), `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `ENABLE_TRANSCRIPT_ANALYSIS` |
| ElevenLabs (optional) | `ELEVENLABS_API_KEY` (dashboard voice list + Convai POC), `ELEVENLABS_AGENT_ID` (the Convai POC agent) — see [voices.md](voices.md) |
| Legacy Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (only with `DATA_BACKEND=supabase`, transition only), `VOICE_CALL_TABLE` |
| Business (prompt) | `COMPANY_NAME`, `AGENT_NAME`, `SERVICE_AREA`, `BUSINESS_HOURS`, `BOOKING_TYPE` |

> **Per-brand agents** (Twilio caller IDs, voices, compliance posture) are configured in code (`src/assistant/brands.ts`), not env. See [brands.md](brands.md).

> **Secrets & PII:** `.env*` and the `data/` folder (lead workbooks, code lists) are gitignored and never part of the deploy package. Never commit them. In Azure, secrets live in Key Vault (see [azure.md](azure.md)).

## Database setup

Production is **Azure Database for PostgreSQL** (`psql-axxiom-marketing` / `axxiom_hub`) — see [azure.md](azure.md). Apply the schema from **Azure Cloud Shell** (laptops can't reach the server) and **re-run it after every pull that changes it** (idempotent):

- `scripts/azure/sql/voice_schema.sql` — everything: the `outbound` schema (campaigns, leads, calls, events, DNC, code reference, `failed_op` dead-letter, `campaign_insight`, `dashboard_user`, the analytics `v_*` views) + `public.ax_voice_call`, and the grants for the app's managed identity (read/write) and the hub's (read-only).

Access posture: only this service connects to the database (the dashboard reads through the API), so there is no RLS/anon layer — plain GRANTs to the app's Postgres role; `dashboard_user` (password hashes) is never granted to the hub's reader role.

Sanity checks: the deployed app's **`GET /ready`** (database reachable, `outbound` schema readable, and `connectedAs` = the managed identity), or `bun run check-db` from Cloud Shell / against a local Postgres.

> Legacy: `scripts/sql/ax_voice_call.sql` + `scripts/sql/outbound_schema.sql` are the Supabase DDL (RLS, Realtime publication). They're only needed while something still runs with `DATA_BACKEND=supabase`.

## Twilio caller IDs

Vapi-provided numbers have a **daily outbound-call cap** — real campaigns dial from your own Twilio DIDs, one per brand (see [brands.md](brands.md) for the number map):

```bash
bun run import-twilio-numbers -- --list                       # see what's registered
bun run import-twilio-numbers -- --brand quality --number +12405551234
```

The script registers each DID in Vapi (idempotent — matches existing numbers by E.164) and prints the `vapiPhoneNumberId` lines to paste into `src/assistant/brands.ts`. The dialer reads caller IDs from `brands.ts` **at dial time**, so a number swap does not require re-running `create-brand-assistants`. Needs `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + `VAPI_API_KEY`.

## Wire up Vapi

> **On Azure, use the dashboard:** Agent studio → **Re-sync Vapi assistants** (`POST /outbound/admin/assistants/sync`) runs steps 2–4 server-side — it PATCHes the inbound + generic outbound assistants, creates/updates every brand assistant (ids in `app_setting`), keeps approved prompt overrides, and points every webhook at `SERVER_URL`. The scripts below still work against a local database or from Cloud Shell, and are how an env-referenced assistant (`VAPI_ASSISTANT_ID`, `OUTBOUND_ASSISTANT_ID`) is created the first time.

1. Add your ElevenLabs key in Vapi → Provider Keys (only needed for ElevenLabs-voiced assistants — the brand + inbound agents use Vapi-native voices).
2. `bun run create-assistant` → creates the **inbound** assistant, prints `VAPI_ASSISTANT_ID` (put it in `.env`). Set `VAPI_PHONE_NUMBER_ID` and re-run to attach the number.
3. `bun run create-outbound-assistant` → creates the generic/fallback **outbound** assistant, prints `OUTBOUND_ASSISTANT_ID` (put it in `.env`).
4. `bun run create-brand-assistants` → creates/updates **one assistant per brand** from `src/assistant/brands.ts` (ids stored in `outbound.app_setting`). See [brands.md](brands.md).
5. (Optional) `bun run create-convai-agent` → the ElevenLabs Conversational AI **evaluation POC**. See [voices.md](voices.md).
6. Point your inbound / CallRail tracking number at the inbound Vapi number.

> **Re-sync whenever you deploy changes** to prompts or tools (`src/assistant/**`) — e.g. the `confirmConsent` tool only reaches an assistant when its config is re-pushed. Existing assistants are PATCHed, missing brand assistants created. Approved prompt overrides (`brand_prompt:<slug>`, and `brand_prompt:default` for the generic outbound assistant) are preserved.

### Other scripts

- `bun run dashboard-user add|reset|disable|enable|list <email> [--sql]` — dashboard logins (invite-only; `--sql` prints SQL for Cloud Shell). See [azure.md](azure.md#dashboard-accounts).
- Lead import: the dashboard's **Leads → Import** (same code as the CLI). `bun run import-leads <file.xlsx> --region "…" [--campaign "…"]` works where the database is reachable.
- `bun run import-codes [scripts/seed/ca_elevator_compliance.csv]` — seed the violation-code knowledge base.
- `bun run check-db` — database reachability diagnostic (backend, identity, row counts, a DNC lookup).

## Deploy (Azure App Service)

Full detail — resources, identity, Key Vault, the cutover runbook and troubleshooting — is in **[azure.md](azure.md)**. In short:

1. `./scripts/azure/sync-app-settings.sh --apply` — secrets → Key Vault references (loaded from `.env` if missing), config → app settings, plus `DATA_BACKEND=azure`, the managed identity, `SERVER_URL`, startup command, Always-On, health check. `DIALER_ENABLED` defaults to `false` on first setup and is never changed by the script.
2. Commit, then `./scripts/azure/package-app.sh --deploy` — one zip: the bundled backend (`dist/server.mjs`), the dashboard export (`public/`), a `VERSION` file. Nothing installs server-side.
3. Verify with **`/health`** (`version` = your commit) and **`/ready`** (`connectedAs` = the app identity, `outbound` schema readable).
4. Agent studio → **Re-sync Vapi assistants** when prompts/tools changed.
5. **Run exactly one instance.** The campaign worker, rate limiter, anti-loop tool history, disclosure tracking and the live-update bus are in-memory — a second instance would double-dial.

Graceful shutdown is handled (SIGTERM stops the worker, then closes the database pool), and the worker auto-resumes on boot if any campaign is still `running` (unless `DIALER_ENABLED=false`).

## Dashboard (web/)

The dashboard is a Next.js 14 app exported as **static files** and served by the backend itself (same origin — the session cookie and the live stream need that; there is no separate dashboard host).

```bash
cd web
npm install
npm run dev        # :3001 — proxies /outbound + /auth to the backend on :3000 (API_DEV_ORIGIN to change)
npm run build      # static export → web/out (package-app.sh ships it as public/)
```

No `NEXT_PUBLIC_*` variables anymore — the old `NEXT_PUBLIC_SUPABASE_*` / `NEXT_PUBLIC_API_BASE` in a local `web/.env.local` are ignored and can be deleted.

The dashboard is **login-gated**: `/login` signs in against the backend (`POST /auth/login`, invite-only accounts), the backend sets an httpOnly session cookie, an `AuthGuard` wraps every page, and every API call and the SSE stream (`GET /outbound/events`) carry the cookie automatically.
