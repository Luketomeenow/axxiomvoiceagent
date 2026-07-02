# CLAUDE.md

Guidance for Claude Code working in this repo. Keep it accurate — update it when structure or workflows change.

## What this is

Orchestration + integration layer for Axxiom Elevator's AI voice agents. **Vapi** runs the voice pipeline (Deepgram STT → Claude → ElevenLabs TTS) and calls **this service** for mid-call tools and end-of-call reports. This service owns the business logic: **GoHighLevel** (CRM) and **Supabase** (call log).

Two agents share one Hono webhook service:
- **Inbound** — answers every call 24/7, triages new leads vs. existing customers, books site surveys, transfers to a human (incl. a safety handoff for trapped/injured callers). Scope is inquiries + leads, **not** emergency dispatch.
- **Outbound** — compliant qualification campaign that dials CA elevator-violation leads, qualifies/dispositions them, monitored from a Next.js dashboard in `web/`. Lives in a separate Supabase `outbound` schema.

See `docs/` for the full guides (`docs/README.md` is the index: setup, inbound, outbound campaigns, API reference, database, compliance) and `README.md` for the quick tour. This file is the operational map for working in the code.

## Runtime & commands

Runtime is **Bun** for the server; CLI scripts have **Node (`tsx`) fallbacks** so you don't need Bun just to seed leads or create assistants.

```bash
bun install
bun run dev          # local server on :3000 (watch mode)
bun run start        # production server
bun run typecheck    # tsc --noEmit — run this to validate changes

bun run create-assistant            # create/update inbound Vapi assistant
bun run create-outbound-assistant   # create/update the generic/fallback outbound assistant
bun run create-brand-assistants     # create/update one Vapi assistant per brand (brands.ts)
bun run create-convai-agent         # ElevenLabs Conversational AI evaluation POC
bun run import-leads <f> --region X  # seed outbound.lead for a region (one campaign per region)
bun run import-codes <f>             # seed outbound.code_reference (codes + compliance topics)

# Node fallbacks (no Bun): npm install, then *:node variants
npm run import-leads:node
npm run create-outbound-assistant:node
```

There are **no automated tests** and **no linter** configured. `bun run typecheck` is the only static gate — run it after edits.

## Layout

```
src/
  index.ts            Hono server: /health, /vapi/webhook, mounts outbound routes
  config/env.ts       All env access; assert* helpers; boots even when keys missing
  assistant/          Inbound prompt/tools/config; brands.ts (6-brand registry); voicePipeline.ts
    outbound/         Outbound: qualification prompt, compliant disclosure, tools, config
  vapi/               Inbound webhook types + handlers (tool dispatch, end-of-call)
  outbound/           routes.ts (API), handlers.ts, dialer.ts, db.ts, phone.ts, voice.ts, brandStore.ts
  ghl/                GoHighLevel client + domain ops
  supabase/           ax_voice_call writer
  ai/                 Optional post-call Claude transcript analysis
scripts/
  create-assistant.ts, create-outbound-assistant.ts, create-brand-assistants.ts, import-leads.ts, import-codes.ts
  elevenlabs/create-convai-agent.ts; seed/ (code KB); sql/ (ax_voice_call.sql, outbound_schema.sql)
web/                  Next.js + Tailwind dashboard — console (page.tsx: LiveCampaigns realtime
                      multi-campaign monitor, monitor, leads, test-call, export)
                      + /analytics (funnel, trends, call quality, compliance audit; charts in components/Charts.tsx)
data/                 Lead workbooks + code lists (PII) — gitignored, never committed
docs/                 Full documentation (see docs/README.md)
```

## Conventions

- **ESM + Bun imports**: `"type": "module"`, and local imports use the explicit `.ts` extension (e.g. `import { env } from "./config/env.ts"`). Match this — don't drop the extension.
- **Config**: read env only through `src/config/env.ts`. The server is designed to **boot with missing keys** so Railway health checks stay green; feature modules call `assert*()` (e.g. `assertGhl`, `assertOutbound`) and throw a clear error only when an unconfigured feature is actually used. Add new env there with a sane default.
- **Default Claude model**: `claude-sonnet-4-6` (`ANTHROPIC_MODEL`).
- **Webhook auth**: `/vapi/webhook` verifies the `x-vapi-secret` header against `VAPI_SERVER_SECRET` with a **constant-time compare** (`safeEqual` in `src/lib/auth.ts`) and **fails closed** — if the secret is unset it returns 503 (unless `ALLOW_INSECURE_WEBHOOK=true`, local dev only). Inbound vs. outbound is branched via `isOutboundCall(message)` in `src/outbound/handlers.ts`.
- **Dashboard API auth**: every `/outbound/*` route requires a valid Supabase user JWT (`requireAuth` middleware in `src/lib/auth.ts`, validated via `auth.getUser`); CORS is locked to `DASHBOARD_ORIGIN`, rate-limited (`src/lib/rateLimit.ts`), and uploads are size-capped. The dashboard (`web/`) has a login page + `AuthGuard` and forwards its JWT via `web/lib/api.ts`. New env: `SUPABASE_ANON_KEY` (backend token validation), `DASHBOARD_ORIGIN`. **Provision dashboard users invite-only in Supabase Auth** (no public signup).

## Gotchas

- **Per-call state is in-memory, single instance.** The anti-loop tool history, the disclosure-logged set (`disclosedCalls`), and the campaign worker all assume one Railway instance. Scaling out requires moving them to Supabase/Redis first.
- **Outbound write resilience**: lead/call/event writes go through `updateLead` / `updateCall` / `recordEvent` in `src/outbound/db.ts`, which retry then dead-letter to `outbound.failed_op` instead of silently dropping. When adding new outbound writes, use these — don't call `db().from(...).update()` raw. The `/analytics` page surfaces the unresolved-failure count.
- **Analytics + RLS**: the dashboard reads pre-aggregated SQL views (`outbound.v_*`) via `GET /outbound/analytics` + `/analytics/compliance` (in `routes.ts`). **Re-run `scripts/sql/outbound_schema.sql` AND `scripts/sql/ax_voice_call.sql`** after pulling — both are additive/idempotent. The outbound script now also locks all reads to the `authenticated` role (RLS policies + `security_invoker` views, anon `select` revoked); `ax_voice_call.sql` enables RLS with service-role-only access. Reads run as the logged-in dashboard user, not anon.
- **Failed-op replay + retention**: dead-lettered writes can be re-applied via `POST /outbound/failed-ops/replay` (`replayFailedOps` in `db.ts`), not just counted. Call content (transcript/recording/raw) is purged after `PII_RETAIN_DAYS` via `POST /outbound/retention/purge`; `POST /outbound/dsar/delete` erases all data for a phone (keeping only the DNC entry).
- **Lead PII**: `.xlsx`/`.csv` and `data/` are gitignored and dockerignored — keep lead data there; never commit or bake it into the image.
- **GHL response shapes** (search, free-slots, appointments) are marked `TODO` in `src/ghl/api.ts` — confirm against the live account before trusting them.
- **Compliance** (CA AB 2905 AI disclosure, CIPA recording consent, TCPA calling hours, DNC) is implemented for outbound but has open items needing counsel — see the checklist in `README.md`. Calling-window/DNC guards + retry backoff (`RETRY_BACKOFF_MINUTES`) + the per-lead in-flight guard live in `src/outbound/dialer.ts`. The **calling window is now enforced in the LEAD's own timezone** (`timezoneForState` in `src/outbound/timezone.ts`), not the campaign/brand tz, plus a per-number frequency cap (`MAX_CALLS_PER_NUMBER_PER_DAY`). Recording **consent is captured explicitly** by a dedicated `confirmConsent` tool (only an actual "yes" stamps `consent_captured` — no longer auto-set by `qualifyLead`); `disclosed_at` is backfilled at end-of-call so a deterministic opener is always credited. Inbound + voicemail now carry an AI/recording disclosure. **After pulling, re-run `create-outbound-assistant` + `create-brand-assistants`** so the new `confirmConsent` tool reaches each Vapi assistant. Audit trail is written in `src/outbound/handlers.ts` and shown on the `/analytics` compliance card.
- **Automatic brand/voice routing**: the dialer resolves each lead's brand (→ voice + caller-ID + per-brand assistant + calling-hours tz + compliance posture) via `resolveBrand()` in `src/assistant/brands.ts` — priority: explicit `campaign.brand` → lead `servicing_brand` (`brandByName`) → lead `state` (`brandForState`, CA/FL are ambiguous and need servicing_brand). `autoAssignCampaignBrand()` (in `dialer.ts`) sets `campaign.brand` + timezone from the leads on **import** and on **start** so nobody has to pick a voice; the dashboard brand dropdown is just an optional override ("Auto" = resolve automatically). Voices are baked into each brand's Vapi assistant (`brands.ts` `voiceId`/`voiceProvider`).
- **Per-run call budget**: `campaign.max_calls_per_run` + `run_started_at` let an operator dial only N calls per run. `tickCampaign` counts `call` rows since `run_started_at` (= dial attempts) and **auto-pauses that campaign** at N (other running campaigns keep going). Every Start (`POST /outbound/campaign/start` with `maxCalls`) resets `run_started_at`, so each Start is a fresh batch; omit `maxCalls`/leave it null for unlimited. Concurrency (`max_concurrent`) is editable via the same start/update endpoints.
- **Multiple campaigns run concurrently**: `runCampaignTick` loops over ALL `status='running'` campaigns and ticks each via `tickCampaign` with its own window/budget/concurrency; `activeCallCount(campaignId)` is **scoped per campaign**, so one can't starve another. The worker self-stops when no campaign is running. Total simultaneous calls = sum of each running campaign's `max_concurrent` — mind your Vapi account concurrency limit.
- **Stale-call sweeper**: `sweepStaleCalls()` runs at the top of every tick and closes any `call` stuck in `queued/ringing/in-progress` for >15 min (a missed end-of-call webhook would otherwise pin a concurrency slot forever and silently halt dialing — this was a real incident). Sets `ended_reason='stale-timeout'`, and now **also returns the stranded lead to a retryable disposition** (it was previously left pinned in `calling` and never re-dialed). The tick has a re-entrancy guard (`ticking`) so overlapping ticks can't double-dial.
- **Deploy**: Railway, via `railway.json` (`bun run src/index.ts`, health `/health`; `/ready` is a dependency-aware check that catches an unexposed `outbound` schema). Graceful SIGTERM shutdown stops the worker; `unhandledRejection`/`uncaughtException` are handled. Set `SERVER_URL` to the public URL. **Post-pull deploy checklist**: set `VAPI_SERVER_SECRET`, `SUPABASE_ANON_KEY`, `DASHBOARD_ORIGIN`; re-run both SQL files; re-run the create-assistant scripts; provision dashboard users in Supabase Auth.
```
