# Axxiom Voice Agents

AI voice agents for Axxiom Elevator, built on **Vapi** (Deepgram transcription +
**Claude** brain + **ElevenLabs** voice). This repo is the **orchestration +
integration layer** that Vapi calls — it owns the CRM logic (GoHighLevel), the
call log (Supabase → Fabric), and the outbound calling campaign. Two agents
share one service: an **inbound** triage agent and an **outbound** qualification
campaign.

> 📚 **Full documentation lives in [`docs/`](docs/README.md)** — setup, the
> [per-brand agents](docs/brands.md), [voices & the ElevenLabs POC](docs/voices.md),
> the inbound agent, outbound campaigns, the API reference, the database schema,
> and [compliance + guardrails](docs/compliance.md). This README is the quick
> tour; `docs/` is the detail.

> The outbound campaign runs a **separate customized agent per Axxiom brand**
> (Quality, Motion, Liftech, Axxiom FL, Arizona, AmeriTex) — each with its own
> local caller ID, voice, and state compliance. See [docs/brands.md](docs/brands.md).

## Inbound agent

Answers every call 24/7, triages **new leads vs. existing customers**, books
site surveys, and hands off to a human when needed.

> Scope: customer inquiries + sales leads. **Not** an emergency dispatch line —
> but it carries a safety net that hands trapped/injured callers straight to a
> human instead of qualifying them.

## Architecture

```
Caller → Vapi (STT → Claude → ElevenLabs) ──tool-calls──▶ THIS SERVICE ──▶ GoHighLevel
                                          ──end-of-call──▶ THIS SERVICE ──▶ Supabase ─▶ Fabric
```

- **Voice pipeline** — Vapi (configured in `src/assistant/`).
- **Brain** — Claude, system prompt in `src/assistant/systemPrompt.ts`.
- **Tools (mid-call)** — `lookupContact`, `bookSurvey`, `transferCall`
  (`src/assistant/tools.ts` → run in `src/vapi/handlers.ts`).
- **CRM** — GoHighLevel client in `src/ghl/` (same auth as axxiommarketinghub).
- **Call log** — `ax_voice_call` in Supabase (`src/supabase/`), mirrored to Fabric.

## Project layout

```
src/
  index.ts              Hono server: /health + /vapi/webhook
  config/env.ts         All env, with assert* helpers (boots even if empty)
  assistant/            What gets pushed to Vapi (prompt, tools, full config)
  vapi/                 Webhook types + handlers (tool dispatch, end-of-call)
  ghl/                  GoHighLevel client + domain ops
  supabase/             ax_voice_call writer
  ai/                   Optional post-call Claude analysis
scripts/
  create-assistant.ts   Create/update the Vapi assistant
  sql/ax_voice_call.sql  Supabase table DDL
```

## Setup

```bash
bun install
cp .env.example .env        # fill in keys (see below)
bun run dev                 # local server on :3000
```

Expose it for Vapi during local testing (e.g. `ngrok http 3000`) and set
`SERVER_URL` to that public URL.

### Required to go live
| What | Env |
|------|-----|
| Vapi API key | `VAPI_API_KEY` |
| Webhook secret (any random string) | `VAPI_SERVER_SECRET` |
| Public URL of this service | `SERVER_URL` |
| GHL token + location | `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID` |
| Survey calendar | `GHL_CALENDAR_ID` |
| New-lead pipeline + stage | `GHL_PIPELINE_ID`, `GHL_PIPELINE_STAGE_ID` |
| Human/safety transfer number | `TRANSFER_PHONE_NUMBER` |
| ElevenLabs voice id | `ELEVENLABS_VOICE_ID` (+ EL key in Vapi dashboard) |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

The server **boots without these** (Railway health check stays green); each
feature logs a warning until its keys are present.

## Deploy (Railway)

1. `bun install` (commits `bun.lock` so Railway detects Bun).
2. Push the repo; Railway uses `railway.json` (`bun run src/index.ts`, health `/health`).
3. Set the env vars in Railway, including `SERVER_URL` = your Railway URL.

## Wire up Vapi

1. Run the table DDL: `scripts/sql/ax_voice_call.sql` in Supabase.
2. Add your ElevenLabs key to Vapi (dashboard → Provider Keys).
3. `bun run create-assistant` — creates the assistant, prints `VAPI_ASSISTANT_ID`.
4. Put that id in `.env`, set `VAPI_PHONE_NUMBER_ID`, re-run to attach the number.
5. Point your inbound / CallRail tracking number at the Vapi number.
6. Call it and walk the three paths; refine the prompt from transcripts.

## Notes / TODO before production
- Confirm GHL response shapes against the live account (search, free-slots,
  appointments) — marked with `TODO` in `src/ghl/api.ts`.
- `bookSurvey` books the earliest free slot; add preferred-time matching later.
- Per-call state is in-memory (single instance). Move to Supabase/Redis to scale out.
- Compliance (recording consent disclosure, AI disclosure) lives in the prompt
  for inbound; revisit before any outbound agents.

---

# Outbound Qualification Campaign

A compliant outbound calling system that dials elevator-violation leads
**region by region** (imported from per-region xlsx workbooks kept in `data/`,
gitignored — they contain lead PII), qualifies whether they want Axxiom's
service, looks up violation **codes** accurately, dispositions each lead into
**sales-ready** data, and is monitored live from a Next.js dashboard. Everything
lives in a dedicated Supabase **`outbound` schema** (separate from inbound
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
Next.js dashboard ◀─Supabase Realtime─┘   ◀─start/pause, call-now, test-call, export─ Hono API
```

- **Per-brand assistants** — `src/assistant/brands.ts` registry → `bun run create-brand-assistants`
  generates one Vapi assistant per brand; the dialer routes a campaign's calls to its brand's
  assistant + caller ID. (`src/assistant/outbound/` holds the shared prompt/tools/config.)
- **Outbound assistant** — qualification prompt, compliant first-message disclosure, tools
  `qualifyLead`, `recordDisposition`, `optOut`, `lookupViolationCode`, `transferToHuman`.
- **Dialer + worker** — `src/outbound/dialer.ts` (Vapi `POST /call`, calling-window
  + DNC guards, concurrency cap, manual "call now", arbitrary-number test calls).
- **Webhook handlers** — `src/outbound/handlers.ts` (branch outbound vs inbound,
  persist status/transcript/tool-calls/end-of-call, set dispositions + sales fields).
- **API routes** — `src/outbound/routes.ts` (campaigns, stats, start/pause,
  call-now, test-call, export to xlsx/csv).
- **Dashboard** — `web/` (Next.js + Tailwind): region selector, live monitor,
  leads table, campaign + test-call controls, export.

## Setup (outbound)

1. **Schema** — run `scripts/sql/outbound_schema.sql` in Supabase. Then in the
   dashboard: enable Realtime for the `outbound` schema (Database → Replication)
   and expose it for the API (Settings → API → Exposed schemas).
2. **Import a region's leads** — `bun run import-leads <file.xlsx> --region "CA — Bay Area"`
   (optionally `--sheet "Name"` / `--campaign "Name"`). Each region becomes its
   own campaign. Phones are normalized to E.164, deduped, and toll-free-only rows
   are flagged `bad_number`. Repeat per region.
3. **Seed the code reference** — `bun run import-codes <codes.xlsx>` so
   `lookupViolationCode` can verify codes. Until seeded it safely returns
   "not found → the team will confirm." (See docs for expected columns.)
4. **Phone number** — set `VAPI_PHONE_NUMBER_ID` to the Vapi number that places
   the outbound calls.
5. **Assistant** — `bun run create-outbound-assistant`, then put the printed
   `OUTBOUND_ASSISTANT_ID` in `.env`.
6. **Dashboard** — in `web/`: `cp .env.local.example .env.local` (fill in
   `NEXT_PUBLIC_SUPABASE_URL`, the **anon** key, and `NEXT_PUBLIC_API_BASE`),
   then `npm install && npm run dev` (serves on `:3001`; the backend runs on `:3000`).

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

(The HTTP server itself still runs under Bun — `bun run dev` / `bun run start`.)

## Outbound env

| What | Env |
|------|-----|
| Outbound caller number | `VAPI_PHONE_NUMBER_ID` |
| Outbound assistant id | `OUTBOUND_ASSISTANT_ID` (from create-outbound-assistant) |
| Lead timezone for calling window | `OUTBOUND_TIMEZONE` (default `America/Los_Angeles`) |
| Calling window (local hours) | `CALL_WINDOW_START` / `CALL_WINDOW_END` (8–21) |
| Concurrency / attempts | `MAX_CONCURRENT_CALLS`, `MAX_CALL_ATTEMPTS` |
| Dashboard → Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (in `web/.env.local`) |
| Dashboard → backend | `NEXT_PUBLIC_API_BASE` |

## Compliance checklist (CA outbound)

Built in, but **review with counsel before going live**:

- [x] **AI disclosure (CA AB 2905)** — the first message states it's an AI
      assistant on a recorded line before any substantive talk. *Strictest
      posture: deliver this opener in a recorded human voice; the line is in
      `src/assistant/outbound/prompt.ts`.*
- [x] **All-party recording consent (CIPA §632/§632.7)** — disclosure precedes
      the conversation; if the person declines, the agent calls `optOut` and ends.
      Every call writes an append-only `outbound.call_event` audit trail.
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
