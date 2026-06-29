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
web/                  Next.js + Tailwind dashboard — console (page.tsx: monitor, leads, test-call, export)
                      + /analytics (funnel, trends, call quality, compliance audit; charts in components/Charts.tsx)
data/                 Lead workbooks + code lists (PII) — gitignored, never committed
docs/                 Full documentation (see docs/README.md)
```

## Conventions

- **ESM + Bun imports**: `"type": "module"`, and local imports use the explicit `.ts` extension (e.g. `import { env } from "./config/env.ts"`). Match this — don't drop the extension.
- **Config**: read env only through `src/config/env.ts`. The server is designed to **boot with missing keys** so Railway health checks stay green; feature modules call `assert*()` (e.g. `assertGhl`, `assertOutbound`) and throw a clear error only when an unconfigured feature is actually used. Add new env there with a sane default.
- **Default Claude model**: `claude-sonnet-4-6` (`ANTHROPIC_MODEL`).
- **Webhook auth**: `/vapi/webhook` verifies the `x-vapi-secret` header against `VAPI_SERVER_SECRET`. Inbound vs. outbound is branched via `isOutboundCall(message)` in `src/outbound/handlers.ts`.

## Gotchas

- **Per-call state is in-memory, single instance.** The anti-loop tool history, the disclosure-logged set (`disclosedCalls`), and the campaign worker all assume one Railway instance. Scaling out requires moving them to Supabase/Redis first.
- **Outbound write resilience**: lead/call/event writes go through `updateLead` / `updateCall` / `recordEvent` in `src/outbound/db.ts`, which retry then dead-letter to `outbound.failed_op` instead of silently dropping. When adding new outbound writes, use these — don't call `db().from(...).update()` raw. The `/analytics` page surfaces the unresolved-failure count.
- **Analytics**: the dashboard reads pre-aggregated SQL views (`outbound.v_*`) via `GET /outbound/analytics` + `/analytics/compliance` (in `routes.ts`). **Re-run `scripts/sql/outbound_schema.sql`** after pulling — it's additive/idempotent and creates the new columns, `failed_op`, and the views.
- **Lead PII**: `.xlsx`/`.csv` and `data/` are gitignored and dockerignored — keep lead data there; never commit or bake it into the image.
- **GHL response shapes** (search, free-slots, appointments) are marked `TODO` in `src/ghl/api.ts` — confirm against the live account before trusting them.
- **Compliance** (CA AB 2905 AI disclosure, CIPA recording consent, TCPA calling hours, DNC) is implemented for outbound but has open items needing counsel — see the checklist in `README.md`. Calling-window/DNC guards + retry backoff (`RETRY_BACKOFF_MINUTES`) + the per-lead in-flight guard live in `src/outbound/dialer.ts`. The audit trail (disclosure spoken → `disclosed_at` + `disclosure` event; consent → `consent_captured`/`consent_at` + `consent` event) is written in `src/outbound/handlers.ts` and reported on the `/analytics` compliance card.
- **Per-run call budget**: `campaign.max_calls_per_run` + `run_started_at` let an operator dial only N calls per run. `runCampaignTick` counts `call` rows since `run_started_at` (= dial attempts) and **auto-pauses** the campaign at N. Every Start (`POST /outbound/campaign/start` with `maxCalls`) resets `run_started_at`, so each Start is a fresh batch; omit `maxCalls`/leave it null for unlimited. Concurrency (`max_concurrent`) is editable via the same start/update endpoints.
- **Deploy**: Railway, via `railway.json` (`bun run src/index.ts`, health `/health`). Set `SERVER_URL` to the public URL.
```
