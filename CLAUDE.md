# CLAUDE.md

Guidance for Claude Code working in this repo. Keep it accurate — update it when structure or workflows change.

## What this is

Orchestration + integration layer for Axxiom Elevator's AI voice agents. **Vapi** runs the voice pipeline (Deepgram STT → Claude → ElevenLabs TTS) and calls **this service** for mid-call tools and end-of-call reports. This service owns the business logic: **GoHighLevel** (CRM) and **Supabase** (call log).

Two agents share one Hono webhook service:
- **Inbound** — answers every call 24/7, triages new leads vs. existing customers, books site surveys, transfers to a human (incl. a safety handoff for trapped/injured callers). Scope is inquiries + leads, **not** emergency dispatch.
- **Outbound** — compliant qualification campaign that dials CA elevator-violation leads, qualifies/dispositions them, monitored from a Next.js dashboard in `web/`. Lives in a separate Supabase `outbound` schema.

See `README.md` for the full setup/deploy/compliance narrative; this file is the quick operational map.

## Runtime & commands

Runtime is **Bun** for the server; CLI scripts have **Node (`tsx`) fallbacks** so you don't need Bun just to seed leads or create assistants.

```bash
bun install
bun run dev          # local server on :3000 (watch mode)
bun run start        # production server
bun run typecheck    # tsc --noEmit — run this to validate changes

bun run create-assistant            # create/update inbound Vapi assistant
bun run create-outbound-assistant   # create/update outbound assistant
bun run import-leads                 # seed outbound.lead from the workbook

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
  assistant/          Inbound: prompt, tools, Vapi assistant config
    outbound/         Outbound: qualification prompt, compliant disclosure, tools
  vapi/               Inbound webhook types + handlers (tool dispatch, end-of-call)
  outbound/           routes.ts (API), handlers.ts, dialer.ts, db.ts, phone.ts
  ghl/                GoHighLevel client + domain ops
  supabase/           ax_voice_call writer
  ai/                 Optional post-call Claude transcript analysis
scripts/
  create-assistant.ts, create-outbound-assistant.ts, import-leads.ts
  sql/                ax_voice_call.sql, outbound_schema.sql
web/                  Next.js + Tailwind dashboard (live monitor, leads, controls, export)
data/                 Lead workbooks (PII) — gitignored, never committed
```

## Conventions

- **ESM + Bun imports**: `"type": "module"`, and local imports use the explicit `.ts` extension (e.g. `import { env } from "./config/env.ts"`). Match this — don't drop the extension.
- **Config**: read env only through `src/config/env.ts`. The server is designed to **boot with missing keys** so Railway health checks stay green; feature modules call `assert*()` (e.g. `assertGhl`, `assertOutbound`) and throw a clear error only when an unconfigured feature is actually used. Add new env there with a sane default.
- **Default Claude model**: `claude-sonnet-4-6` (`ANTHROPIC_MODEL`).
- **Webhook auth**: `/vapi/webhook` verifies the `x-vapi-secret` header against `VAPI_SERVER_SECRET`. Inbound vs. outbound is branched via `isOutboundCall(message)` in `src/outbound/handlers.ts`.

## Gotchas

- **Per-call state is in-memory, single instance.** Scaling out requires moving it to Supabase/Redis first. Don't assume multi-instance safety.
- **Lead PII**: `.xlsx`/`.csv` and `data/` are gitignored and dockerignored — keep lead data there; never commit or bake it into the image.
- **GHL response shapes** (search, free-slots, appointments) are marked `TODO` in `src/ghl/api.ts` — confirm against the live account before trusting them.
- **Compliance** (CA AB 2905 AI disclosure, CIPA recording consent, TCPA calling hours, DNC) is implemented for outbound but has open items needing counsel — see the checklist in `README.md`. The calling-window/DNC guards live in `src/outbound/dialer.ts`.
- **Deploy**: Railway, via `railway.json` (`bun run src/index.ts`, health `/health`). Set `SERVER_URL` to the public URL.
```
