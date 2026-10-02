# Axxiom Voice Agents

AI voice agents for Axxiom Elevator, built on **Vapi** (Deepgram transcription +
**Claude** brain + **Vapi-native / ElevenLabs** voices) with **Twilio** as the
carrier. This repo is the **orchestration + integration layer** that Vapi calls —
it owns the CRM logic (GoHighLevel), the call log (Azure Postgres → Fabric), and the
outbound calling campaigns. It runs on **Azure** (App Service + Azure Database for
PostgreSQL + Key Vault) next to the marketing hub — see [docs/azure.md](docs/azure.md). Two agents share one service: an **inbound** triage
agent and an **outbound** qualification campaign with live monitoring, cost +
compliance analytics, and human-gated AI self-improvement.

> 📚 **Full documentation lives in [`docs/`](docs/README.md)** — setup, [Azure hosting + the cutover runbook](docs/azure.md), the
> [per-brand agents](docs/brands.md), [voices & the ElevenLabs POC](docs/voices.md),
> the inbound agent, outbound campaigns, the API reference, the database schema,
> and [compliance + guardrails](docs/compliance.md). This README is the quick
> tour; `docs/` is the detail.

> The outbound campaign runs a **separate customized agent per Axxiom brand**
> (Quality, Motion, Liftech, Axxiom FL, Arizona, AmeriTex) — each with its own
> **Twilio caller ID** (AmeriTex picks TX vs CA numbers by the lead's state),
> voice, and state compliance. Brands are **resolved automatically** per lead/
> campaign. See [docs/brands.md](docs/brands.md).

## Inbound agent

Answers every call 24/7, triages **new leads vs. existing customers**, books
site surveys, and hands off to a human when needed.

> Scope: customer inquiries + sales leads. **Not** an emergency dispatch line —
> but it carries a safety net that hands trapped/injured callers straight to a
> human instead of qualifying them.

## Architecture

```
Caller → Vapi (STT → Claude → ElevenLabs) ──tool-calls──▶ THIS SERVICE ──▶ GoHighLevel
                                          ──end-of-call──▶ THIS SERVICE ──▶ Azure Postgres ─▶ Fabric
```

- **Voice pipeline** — Vapi (configured in `src/assistant/`).
- **Brain** — Claude, system prompt in `src/assistant/systemPrompt.ts`.
- **Tools (mid-call)** — `lookupContact`, `bookSurvey`, `transferCall`
  (`src/assistant/tools.ts` → run in `src/vapi/handlers.ts`).
- **CRM** — GoHighLevel client in `src/ghl/` (same auth as axxiommarketinghub).
- **Call log** — `public.ax_voice_call` in Azure Postgres (`src/vapi/voiceCall.ts`), mirrored to Fabric and read by the marketing hub.
- **Security** — `/vapi/webhook` verifies `x-vapi-secret` (constant-time) and **fails
  closed** without `VAPI_SERVER_SECRET`; the dashboard API (`/outbound/*`) requires a
  signed session cookie (invite-only accounts), same-origin + rate-limited; the database
  is reachable only by this service's managed identity. See `src/lib/`.

## Project layout

```
src/
  index.ts              Hono server: /health, /ready, /vapi/webhook, /auth, outbound routes,
                        and the dashboard's static files (Node 22 in prod, Bun in dev)
  config/env.ts         All env, with assert* helpers (boots even if empty)
  lib/                  dataClient + pg/ (Azure Postgres via managed identity), change bus
                        (live SSE), auth (webhook secret + session middleware), rate limit,
                        PII redaction
  auth/                 dashboard sign-in routes + accounts
  assistant/            Inbound prompt/tools/config; brands.ts (6-brand registry);
    outbound/           outbound prompt (disclosure opener) + tools + config
  vapi/                 Inbound webhook types + handlers (tool dispatch, end-of-call)
  outbound/             dialer/worker, handlers, routes, db (retry+dead-letter),
                        twilioSync, timezone, import, voice, brandStore
  ghl/                  GoHighLevel client + domain ops
  ai/                   Post-call transcript analysis + campaign insights (self-learning)
scripts/
  create-assistant.ts / create-outbound-assistant.ts / create-brand-assistants.ts
  import-twilio-numbers.ts / import-leads.ts / import-codes.ts / check-outbound-db.ts
  dashboard-user.ts     dashboard logins (invite-only; --sql for Cloud Shell)
  build.mjs             production bundle → dist/server.mjs
  azure/                package-app.sh, sync-app-settings.sh, migrate_from_supabase.py,
                        sql/voice_schema.sql (the Azure schema — idempotent)
  sql/                  legacy Supabase DDL (ax_voice_call.sql + outbound_schema.sql)
web/                    Next.js dashboard (login-gated, static export served by the backend)
```

## Setup

```bash
bun install
cp .env.example .env        # fill in keys (see below)
bun run dev                 # local server on :3000 (a local Postgres 18 — see docs/setup.md)
bun test                    # data-layer contract tests
```

Expose it for Vapi during local testing (e.g. `ngrok http 3000`) and set
`SERVER_URL` to that public URL.

### Required to go live
| What | Env |
|------|-----|
| Vapi API key | `VAPI_API_KEY` |
| Webhook secret (**required** — webhook fails closed 503 without it) | `VAPI_SERVER_SECRET` |
| Public URL of this service | `SERVER_URL` |
| GHL token + location | `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID` |
| Survey calendar | `GHL_CALENDAR_ID` |
| New-lead pipeline + stage | `GHL_PIPELINE_ID`, `GHL_PIPELINE_STAGE_ID` |
| Human/safety transfer number | `TRANSFER_PHONE_NUMBER` |
| ElevenLabs voice id | `ELEVENLABS_VOICE_ID` (+ EL key in Vapi dashboard) |
| Database (Azure Postgres, managed identity) | `DATA_BACKEND=azure`, `AZURE_PG_USER`, `AZURE_PG_CLIENT_ID` (+ host/db defaults) |
| Dashboard session signing (≥ 32 chars) | `DASHBOARD_SESSION_SECRET` |
| Twilio (caller-ID import + cost sync) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |

The server **boots without these** (the health check stays green); each
feature logs a warning until its keys are present. In Azure they are App Service
settings, secrets as Key Vault references (`scripts/azure/sync-app-settings.sh`).

## Deploy (Azure App Service)

```bash
./scripts/azure/sync-app-settings.sh --apply   # vault refs + config + identity + startup/Always-On
./scripts/azure/package-app.sh --deploy        # bundle backend + dashboard export, zip deploy
curl https://<app>.azurewebsites.net/ready      # connectedAs = the managed identity
```

Then dashboard → Agent studio → **Re-sync Vapi assistants** whenever prompts/tools
change. One instance only. Everything else — resources, what Zach provisions, the
Supabase/Railway cutover — is in [docs/azure.md](docs/azure.md).

## Wire up Vapi

1. Apply the schema: `scripts/azure/sql/voice_schema.sql` (Azure Cloud Shell).
2. Add your ElevenLabs key to Vapi (dashboard → Provider Keys).
3. `bun run create-assistant` — creates the assistant, prints `VAPI_ASSISTANT_ID`.
4. Put that id in `.env`, set `VAPI_PHONE_NUMBER_ID`, re-run to attach the number.
5. Point your inbound / CallRail tracking number at the Vapi number.
6. Call it and walk the three paths; refine the prompt from transcripts.

## Notes / TODO before production
- Confirm GHL response shapes against the live account (search, free-slots,
  appointments) — marked with `TODO` in `src/ghl/api.ts`.
- `bookSurvey` books the earliest free slot; add preferred-time matching later.
- Per-call state is in-memory (**run a single instance**). Move to Postgres/Redis to scale out.
- The inbound greeting is a fixed AI + recorded-line disclosure (AB 2905/CIPA posture);
  wording is drafted — confirm with counsel.

---

# Outbound Qualification Campaign

A compliant outbound calling system that dials elevator-violation leads
**region by region** (imported from per-region xlsx workbooks kept in `data/`,
gitignored — they contain lead PII), qualifies whether they want Axxiom's
service, looks up violation **codes** accurately, dispositions each lead into
**sales-ready** data, and is monitored live from a Next.js dashboard. Everything
lives in a dedicated **`outbound` schema** in Azure Postgres (separate from inbound
`ax_voice_call`).

> See **[docs/outbound-campaigns.md](docs/outbound-campaigns.md)** for the full
> workflow. Highlights: one campaign per region with a dashboard selector; a
> `lookupViolationCode` tool backed by a curated `code_reference` table so the
> agent never guesses codes; structured qualification columns for sales; and a
> "Test the agent" form that dials any number.

## Outbound architecture

```
Leads xlsx ──import (per region)──▶ outbound.lead
Worker / call-now / test-call ─POST /call─▶ Vapi ─status/transcript/tools/end-of-call─▶ /vapi/webhook
                                                       │
                  outbound.call + call_event + lead disposition + sales fields
                                                       │
Next.js dashboard ◀─live SSE stream─┘   ◀─start/pause, call-now, test-call, export─ Hono API
```

- **Per-brand assistants** — `src/assistant/brands.ts` registry → `bun run create-brand-assistants`
  (or, on Azure, dashboard → **Re-sync Vapi assistants**) generates one Vapi assistant per brand; the dialer routes a campaign's calls to its brand's
  assistant + caller ID. (`src/assistant/outbound/` holds the shared prompt/tools/config.)
- **Outbound assistant** — qualification prompt, deterministic AI/recorded-line
  disclosure opener, tools `confirmConsent`, `qualifyLead`, `recordDisposition`,
  `optOut`, `lookupViolationCode`, `transferCall`/`endCall`.
- **Dialer + worker** — `src/outbound/dialer.ts`: 15s multi-campaign tick with
  calling-window (lead's own timezone), DNC (fail-closed), per-number daily cap,
  attempt cap + backoff, per-lead + per-number in-flight guards, dial batches
  deduped to distinct numbers (concurrency N = N different people, even when
  many lead rows share one contact number), per-run call budget (auto-pause),
  stale-call sweeper (keeps ticking after pause until in-flight calls resolve),
  systemic-error auto-pause; manual "call now" + test calls; throttled Twilio
  cost sync + auto campaign insights.
- **Webhook handlers** — `src/outbound/handlers.ts` (branch outbound vs inbound,
  persist status/transcript/tool-calls/end-of-call, disclosure/consent stamps,
  `ended_by` attribution, dispositions + sales fields).
- **API routes** — `src/outbound/routes.ts` (campaigns, start/pause with budget,
  stats, analytics + compliance audit, insights approve/reject, Twilio sync,
  failed-op replay, retention purge, DSAR delete, import/export, test-call,
  assistant sync, System logs + health checks, the live SSE stream) — all
  session-gated.
- **Monitoring** — `src/lib/logStore.ts` + `src/outbound/health.ts`: every log
  line is kept in `outbound.app_log` (masked, 30 days) and streamed live to the
  dashboard's **System logs** tab, with health checks (Vapi webhook routing,
  stuck calls, database, dialer, Foundry, Twilio) re-run every 5 minutes. See
  [docs/monitoring.md](docs/monitoring.md).
- **Dashboard** — `web/` (Next.js + Tailwind, **login-gated**): live campaign
  cards, live monitor with transcripts + end-call, leads table, campaign/brand/
  test-call controls, AI insights panel, export, System logs, and `/analytics`
  (funnel, trends, costs, call quality, compliance).

## Setup (outbound)

1. **Schema** — apply `scripts/azure/sql/voice_schema.sql` in Azure Cloud Shell
   (idempotent; it also grants the app's managed identity). `/ready` confirms it.
2. **Import a region's leads** — dashboard → **Leads → Import** (or
   `bun run import-leads <file.xlsx> --region "CA — Bay Area"` where the database
   is reachable; optionally `--sheet "Name"` / `--campaign "Name"`). Each region becomes its
   own campaign. Phones are normalized to E.164, deduped, and toll-free-only rows
   are flagged `bad_number`. Repeat per region.
3. **Seed the code reference** — `bun run import-codes <codes.xlsx>` so
   `lookupViolationCode` can verify codes. Until seeded it safely returns
   "not found → the team will confirm." (See docs for expected columns.)
4. **Caller IDs** — import your own Twilio DIDs into Vapi
   (`bun run import-twilio-numbers`) and keep each brand's `vapiPhoneNumberId`
   in `src/assistant/brands.ts`; `VAPI_PHONE_NUMBER_ID` is only the fallback
   number. (Vapi-provided numbers have a daily outbound cap.)
5. **Assistants** — `bun run create-outbound-assistant` once (fallback; put the
   printed `OUTBOUND_ASSISTANT_ID` in the app settings), then dashboard → Agent
   studio → **Re-sync Vapi assistants** (creates/updates one per brand) after
   every prompt/tool change.
6. **Dashboard** — served by the backend itself. Create logins with
   `bun run dashboard-user add you@axxiomelevator.com --sql` (paste the SQL in
   Cloud Shell; invite-only, no public signup). Local dev: `cd web && npm install
   && npm run dev` (`:3001`, proxies the API on `:3000`).

Pick a region and start/pause its campaign from the dashboard. The worker dials
eligible leads (highest `lead_score` first) within the calling window, up to the
concurrency cap and max attempts. "Call now" on any lead dials immediately, and
the "Test the agent" card dials any number you enter — both still DNC-checked.

### No Bun installed? (Node fallback)

The CLI scripts have Node-runnable variants (via `tsx`), so you don't need Bun
just to seed leads or create the assistant. They auto-load `.env` with Node's
`--env-file`:

```bash
npm install                      # installs tsx + deps
npm run import-leads:node
npm run create-outbound-assistant:node
npm run create-assistant:node    # inbound assistant
```

(The HTTP server runs under Bun locally — `bun run dev` — and under Node in production: `npm run build && npm run start:node`.)

## Outbound env

| What | Env |
|------|-----|
| Fallback caller number / assistant | `VAPI_PHONE_NUMBER_ID`, `OUTBOUND_ASSISTANT_ID` (per-brand caller IDs live in `brands.ts`) |
| Fallback timezone for calling window | `OUTBOUND_TIMEZONE` (default `America/Los_Angeles`; the dialer prefers the **lead's** state tz) |
| Calling window (local hours) | `CALL_WINDOW_START` / `CALL_WINDOW_END` (8–21) |
| Concurrency / attempts / backoff | `MAX_CONCURRENT_CALLS`, `MAX_CALL_ATTEMPTS`, `RETRY_BACKOFF_MINUTES` |
| Per-number frequency cap | `MAX_CALLS_PER_NUMBER_PER_DAY` (default 3, rolling 24 h) |
| Voicemail detection | `ENABLE_VOICEMAIL_DETECTION` (**set `true` for live campaigns**) |
| Twilio cost/status sync | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| AI insights (self-learning) | `ANTHROPIC_API_KEY`, `INSIGHT_EVERY_N_CALLS` (default 25) |
| PII retention | `PII_RETAIN_DAYS` (default 90) |
| Dashboard auth | `DASHBOARD_SESSION_SECRET` (≥ 32 chars), `DASHBOARD_SESSION_HOURS` (default 12) |
| Dialing on/off per instance | `DIALER_ENABLED` (default `true`; `false` until cutover on a new host) |

## Go-live pre-flight (operational)

The code guardrails are enforced, but the campaign **will misbehave** without these
environment/config steps. Run through this before pressing **Start** on a real campaign:

- [ ] **`GET /ready` is green** and shows `connectedAs` = the app's managed identity.
      *If the schema or a grant is missing, every DNC lookup errors → fail-closed →
      **every number is blocked** and the campaign dials nothing.*
- [ ] **Re-run `scripts/azure/sql/voice_schema.sql`** (idempotent) after pulling schema
      changes so the latest columns, views and grants exist.
- [ ] **`DIALER_ENABLED=true`** on the one instance that should dial (it defaults to
      `false` on a new Azure app — the banner on the dashboard says so).
- [ ] **`ENABLE_VOICEMAIL_DETECTION=true`** for the live run *(off by default, or the
      agent pitches answering machines)*.
- [ ] **`VAPI_SERVER_SECRET`** set and matched in the assistants — the webhook **fails
      closed (503) without it**, so an unset secret means no call events are processed.
- [ ] **Dashboard auth wired**: `DASHBOARD_SESSION_SECRET` set (≥ 32 chars) and operator
      accounts created with `bun run dashboard-user add … --sql` (the API is session-gated;
      without a login the dashboard is unusable).
- [ ] **Required settings** present: `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`,
      `OUTBOUND_ASSISTANT_ID`, `DATA_BACKEND=azure` + `AZURE_PG_USER`/`AZURE_PG_CLIENT_ID`
      (+ `TWILIO_*` for cost sync, `ANTHROPIC_API_KEY` for insights) — all Key Vault
      references **Resolved** in the portal. Sync assistants (Agent studio → **Re-sync Vapi
      assistants**); seed any known DNC numbers into `outbound.dnc_suppression`.
- [ ] **Telephony — dial from your own Twilio DIDs.** Vapi-*provided* numbers have a
      **daily outbound-call cap** (you'll get `400 "Numbers Bought On Vapi Have A Daily Outbound
      Call Limit"` once hit, and the campaign auto-pauses). All six brands are wired to
      imported Twilio numbers in `src/assistant/brands.ts` (AmeriTex per-state TX/CA);
      register any new DID with `bun run import-twilio-numbers` and update the registry —
      caller IDs are read at dial time, no assistant re-run needed.
- [ ] **Start small**: `MAX_CONCURRENT_CALLS=1` and use **Calls this run** on the dashboard
      to dial a small first batch. Do one **test call**, confirm the disclosure plays, then
      check `outbound.v_compliance_audit` shows `disclosure_logged` + `consent_event` for it.
- [ ] **Watch the dead-letter count** — the `/analytics` page surfaces unresolved write
      failures (`outbound.failed_op`); it should stay at 0.

## Compliance checklist (CA outbound)

Built in, but **review with counsel before going live**:

- [x] **AI disclosure (CA AB 2905)** — the first message states it's an AI
      assistant on a recorded line before any substantive talk. *Strictest
      posture: deliver this opener in a recorded human voice; the line is in
      `src/assistant/outbound/prompt.ts`.*
- [x] **All-party recording consent (CIPA §632/§632.7)** — the deterministic opener
      precedes the conversation, and consent is captured **explicitly** by the
      `confirmConsent` tool (only an actual "yes" stamps `consent_captured`/`consent_at`;
      declines are honored). Every call writes an append-only `outbound.call_event`
      audit trail, surfaced on the `/analytics` compliance card.
- [x] **Calling hours (TCPA, 8am–9pm local)** — enforced in the dialer per the
      lead's timezone; the campaign worker won't dial outside the window.
- [x] **Do-not-call / opt-out** — `outbound.dnc_suppression` is checked before
      every dial; `optOut` adds the number and marks the lead `dnc`.
- [ ] **CA telephonic seller registration / $100k bond (B&P §17511)** — confirm
      whether a B2B exemption applies for your calls. **Not auto-handled.**
- [ ] **Consent standard** — TCPA consent rules are in flux (post-McLaughlin /
      Bradford). Confirm your basis for calling these numbers.

## Dispositions

`new → queued/calling →` one of: `qualified`, `needs_followup`, `not_interested`,
`remove`, `no_answer`, `voicemail`, `bad_number`, `dnc`. Export cleaned lists
(qualified / follow-up / remove / all) as Excel or CSV from the dashboard, or via
`GET /outbound/export?disposition=qualified&format=xlsx`.
