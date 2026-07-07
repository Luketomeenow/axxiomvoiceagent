# Setup & Deployment

## Prerequisites

- **[Bun](https://bun.sh) 1.1+** runs the HTTP server. The CLI scripts also have Node fallbacks (via `tsx`) if you don't have Bun.
- A **Supabase** project (Postgres + Realtime + **Auth** — dashboard users are provisioned invite-only).
- A **Vapi** account, with your **ElevenLabs** key added in Vapi → Provider Keys (only needed for ElevenLabs-voiced assistants).
- A **Twilio** account — your own DIDs are imported into Vapi as per-brand caller IDs, and Twilio is the authoritative source for telephony cost/status.
- A **GoHighLevel** (LeadConnector v2) account — for the inbound CRM flow.

## Install & run locally

```bash
bun install
cp .env.example .env        # fill in keys (see "Environment" below)
bun run dev                 # server on http://localhost:3000 (watch mode)
bun run typecheck           # tsc --noEmit — the static gate (no tests/linter)
```

Expose the local server so Vapi can reach it during testing (e.g. `ngrok http 3000`) and set `SERVER_URL` to that public URL.

> **Local webhook testing:** `/vapi/webhook` **fails closed** (503) when `VAPI_SERVER_SECRET` is unset. Either set the secret locally too, or set `ALLOW_INSECURE_WEBHOOK=true` — local dev only, never in production.

### No Bun? Node fallbacks

The HTTP server needs Bun, but the seed/admin scripts can run under Node + `tsx`:

```bash
npm install
npm run import-leads:node
npm run import-codes:node
npm run create-outbound-assistant:node
npm run create-assistant:node
```

## Environment

All config is read through `src/config/env.ts`. **The server boots even with missing keys** (so Railway's health check passes on first deploy); each feature logs a warning and the `assert*()` helpers throw a clear error only when an unconfigured feature is actually used. See `.env.example` for the annotated list. Key groups:

| Group | Vars |
|-------|------|
| Server | `PORT`, `SERVER_URL` |
| Vapi | `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_SERVER_SECRET` (**required** — webhook fails closed without it), `ALLOW_INSECURE_WEBHOOK` (local dev only) |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — caller-ID import script + per-call cost/status sync |
| Outbound dialing | `OUTBOUND_ASSISTANT_ID` (fallback assistant), `OUTBOUND_TIMEZONE`, `CALL_WINDOW_START`/`END` (8–21), `MAX_CONCURRENT_CALLS`, `MAX_CALL_ATTEMPTS`, `RETRY_BACKOFF_MINUTES`, `MAX_CALLS_PER_NUMBER_PER_DAY`, `ENABLE_VOICEMAIL_DETECTION` (set `true` for live campaigns) |
| Data lifecycle | `PII_RETAIN_DAYS` (retention purge default), `INSIGHT_EVERY_N_CALLS` (auto campaign-analysis cadence) |
| Dashboard API auth | `SUPABASE_ANON_KEY` (validates dashboard user JWTs), `DASHBOARD_ORIGIN` (CORS allow-list, comma-separated; empty = no cross-origin) |
| GoHighLevel | `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`, `GHL_CALENDAR_ID`, `GHL_PIPELINE_ID`, `GHL_PIPELINE_STAGE_ID`, `GHL_TIMEZONE` |
| Transfer / safety | `TRANSFER_PHONE_NUMBER`, `EMERGENCY_INSTRUCTION` |
| Voice + LLM | `ELEVENLABS_VOICE_ID`, `ANTHROPIC_API_KEY` (insights + transcript analysis), `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `ENABLE_TRANSCRIPT_ANALYSIS` |
| ElevenLabs (optional) | `ELEVENLABS_API_KEY` (dashboard voice list + Convai POC), `ELEVENLABS_AGENT_ID` (the Convai POC agent) — see [voices.md](voices.md) |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `VOICE_CALL_TABLE` |
| Business (prompt) | `COMPANY_NAME`, `AGENT_NAME`, `SERVICE_AREA`, `BUSINESS_HOURS`, `BOOKING_TYPE` |

> **Per-brand agents** (Twilio caller IDs, voices, compliance posture) are configured in code (`src/assistant/brands.ts`), not env. See [brands.md](brands.md).

> **Secrets & PII:** `.env*` and the `data/` folder (lead workbooks, code lists) are gitignored **and** dockerignored. Never commit them.

## Supabase setup

Run the DDL in the Supabase SQL editor — **both files, top to bottom, and re-run them after every pull** (they're idempotent/additive; newer features live in later blocks):

1. `scripts/sql/ax_voice_call.sql` — the inbound call log table (+ RLS: service-role-only).
2. `scripts/sql/outbound_schema.sql` — the entire `outbound` schema: campaigns, leads, calls, events, DNC, code reference, `failed_op` dead-letter, `campaign_insight`, the analytics `v_*` views, and the security-hardening RLS block.

Then, in the Supabase dashboard:

- **Settings → API → Exposed schemas:** add `outbound`. *(If missed, `/ready` returns 503 and every DNC lookup fails closed — the dialer treats every number as suppressed and dials nothing.)*
- **Database → Replication:** enable Realtime for the `outbound` schema (live monitor + live campaign cards).
- **Auth → Users:** **invite your dashboard users** (invite-only — there is no public signup). The dashboard has a login page; every read runs as that authenticated user.

**RLS posture (already in the SQL):** all reads require the `authenticated` role — `anon` select is revoked on tables and views, views run with `security_invoker`, and `ax_voice_call` is service-role-only. All writes go through the backend with the service-role key. There is no anon access to lead PII.

Sanity check from your machine: `bun run check-db` verifies the service role can reach the `outbound` schema and prints campaign/lead/DNC counts.

## Twilio caller IDs

Vapi-provided numbers have a **daily outbound-call cap** — real campaigns dial from your own Twilio DIDs, one per brand (see [brands.md](brands.md) for the number map):

```bash
bun run import-twilio-numbers -- --list                       # see what's registered
bun run import-twilio-numbers -- --brand quality --number +12405551234
```

The script registers each DID in Vapi (idempotent — matches existing numbers by E.164) and prints the `vapiPhoneNumberId` lines to paste into `src/assistant/brands.ts`. The dialer reads caller IDs from `brands.ts` **at dial time**, so a number swap does not require re-running `create-brand-assistants`. Needs `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + `VAPI_API_KEY`.

## Wire up Vapi

1. Add your ElevenLabs key in Vapi → Provider Keys (only needed for ElevenLabs-voiced assistants — the brand + inbound agents use Vapi-native voices).
2. `bun run create-assistant` → creates the **inbound** assistant, prints `VAPI_ASSISTANT_ID` (put it in `.env`). Set `VAPI_PHONE_NUMBER_ID` and re-run to attach the number.
3. `bun run create-outbound-assistant` → creates the generic/fallback **outbound** assistant, prints `OUTBOUND_ASSISTANT_ID` (put it in `.env`).
4. `bun run create-brand-assistants` → creates/updates **one assistant per brand** from `src/assistant/brands.ts` (ids stored in `outbound.app_setting`). See [brands.md](brands.md).
5. (Optional) `bun run create-convai-agent` → the ElevenLabs Conversational AI **evaluation POC**. See [voices.md](voices.md).
6. Point your inbound / CallRail tracking number at the inbound Vapi number.

> **Re-run the `create-*` scripts whenever you pull changes** to prompts or tools (`src/assistant/**`) — e.g. the `confirmConsent` tool only reaches an assistant when its config is re-pushed. They PATCH the existing assistant when its id is known, otherwise POST a new one. Approved prompt overrides (`brand_prompt:<slug>` in `app_setting`) are preserved.

### Other scripts

- `bun run import-leads <file.xlsx> --region "…" [--campaign "…"]` — import a region's leads (one campaign per region; auto-assigns the campaign's brand from the leads).
- `bun run import-codes [scripts/seed/ca_elevator_compliance.csv]` — seed the violation-code knowledge base.
- `bun run check-db` — outbound-schema reachability diagnostic.

## Deploy (Railway)

The repo ships a `Dockerfile` (Bun base image) and `railway.json`:

1. Push the repo; Railway builds the Dockerfile and runs `bun run src/index.ts` with health check `/health`.
2. Set all env vars in Railway, including `SERVER_URL` = your Railway URL. **Required for production:** `VAPI_SERVER_SECRET` (webhook is 503 without it), `SUPABASE_ANON_KEY` + `DASHBOARD_ORIGIN` (dashboard API auth/CORS), `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` (cost sync), `ANTHROPIC_API_KEY` (insights), `ENABLE_VOICEMAIL_DETECTION=true` for live campaigns.
3. The create scripts read `SERVER_URL` to set each assistant's webhook to `${SERVER_URL}/vapi/webhook`.
4. Use `/ready` (not just `/health`) to verify a deploy: it checks Supabase connectivity **and** that the `outbound` schema is exposed.
5. **Run exactly one instance.** The campaign worker, rate limiter, anti-loop tool history, and disclosure tracking are in-memory — a second replica would double-dial.

**Post-pull checklist:** re-run both SQL files → re-run `create-outbound-assistant` + `create-brand-assistants` → confirm the env vars above → provision dashboard users in Supabase Auth.

Graceful shutdown is handled (SIGTERM stops the worker before exit), and the worker auto-resumes on boot if any campaign is still `running`.

## Dashboard (web/)

```bash
cd web
cp .env.local.example .env.local   # NEXT_PUBLIC_SUPABASE_URL, anon key, NEXT_PUBLIC_API_BASE
npm install
npm run dev                        # serves on :3001; backend runs on :3000
```

| Var | Meaning |
|-----|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key — used only to establish the user session; all data reads run as the **logged-in** user |
| `NEXT_PUBLIC_API_BASE` | Backend base URL (default `http://localhost:3000`; in prod, the Railway URL) |

The dashboard is **login-gated**: `/login` signs in against Supabase Auth (invite-only), an `AuthGuard` wraps every page, and `web/lib/api.ts` forwards the user's JWT as `Authorization: Bearer` on every backend call (exports download via an authenticated fetch, since a plain link can't carry the header).

### Deploy the dashboard (Netlify)

The dashboard deploys to **Netlify**; the **backend stays on Railway** (Netlify can't host the persistent Bun webhook + dialer worker). Config lives in `netlify.toml` (root): `base = "web"`, `npm run build`, Node 20, and the official `@netlify/plugin-nextjs` runtime.

1. Netlify → **Add new site → Import from Git**, pick this repo. `netlify.toml` already points the build at `web/` — no manual build settings needed.
2. **Site settings → Environment variables** — add the three `NEXT_PUBLIC_*` vars above. Set **`NEXT_PUBLIC_API_BASE` to your Railway backend URL** (not localhost).
3. On the **backend**, set `DASHBOARD_ORIGIN` to the Netlify site URL — CORS is fail-closed, so an unset/mismatched origin blocks every dashboard API call.
4. Deploy, then log in with an invited Supabase Auth user.

> These are `NEXT_PUBLIC_*` (inlined at build time) — after changing any of them in Netlify, trigger a **redeploy**. If they're unset the dashboard silently points at `localhost` and login/Realtime/API all break.
