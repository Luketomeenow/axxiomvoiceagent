# Axxiom Voice Agents — Documentation

AI voice agents for Axxiom Elevator, built on **Vapi** (Deepgram speech-to-text → **Claude** → **Vapi-native / ElevenLabs** voice) with **Twilio** as the telephony carrier. This repository is the **orchestration + integration layer** that Vapi calls: it owns the business logic (GoHighLevel CRM, Supabase call logging) and runs the outbound calling campaigns — a **separate customized agent per Axxiom brand**, each dialing from its **own Twilio caller ID**, with live monitoring, cost + quality analytics, and human-gated AI self-improvement.

There are two agents sharing one service:

| Agent | Direction | Purpose |
|-------|-----------|---------|
| **Inbound** | Answers calls 24/7 | Triage new leads vs. existing customers, book site surveys, safety hand-off to a human. Opens with an AI + recorded-line disclosure. |
| **Outbound** | Places calls | **Per-brand** qualification campaigns over elevator-violation leads: compliant disclosure → consent → qualification flow, multi-campaign live monitoring, per-run call budgets, cost/quality/compliance analytics, and AI-proposed prompt improvements (human-approved). |

## Documentation map

| Doc | What's inside |
|-----|---------------|
| [overview.md](overview.md) | **Plain-English executive summary** of the whole system — business value, compliance story, dashboard, status. Presentation-ready. |
| [setup.md](setup.md) | Install, environment variables, local dev, Railway deploy, Supabase (schema + auth + RLS), Twilio caller IDs, Vapi wiring, scripts. |
| [brands.md](brands.md) | **Per-brand outbound agents** — the brand registry, one Vapi assistant per brand, **Twilio caller IDs (incl. AmeriTex per-state routing)**, automatic brand resolution, and prompt overrides from approved insights. |
| [voices.md](voices.md) | Voice providers (Vapi native vs ElevenLabs), the dashboard voice picker, and the ElevenLabs Conversational AI **evaluation POC** + agent switcher. |
| [inbound-agent.md](inbound-agent.md) | The inbound triage agent: prompt, tools, safety net, disclosure, call log. |
| [outbound-campaigns.md](outbound-campaigns.md) | The outbound campaign end-to-end: lead import, brand auto-assignment, the dialer's guardrails, **live monitoring**, the **code-reference lookup**, dispositions → sales-ready data, **analytics + Twilio cost sync**, **AI insights / self-learning**, testing, and data retention. |
| [api-reference.md](api-reference.md) | Every HTTP endpoint (with **auth requirements**) and every assistant tool (function) with its parameters. |
| [database.md](database.md) | Supabase schema for both flows (`ax_voice_call` + the `outbound` schema), the analytics views, and the **RLS posture**. |
| [compliance.md](compliance.md) | Disclosure + explicit consent capture, calling-window/DNC/frequency guards, retention + DSAR, audit trail, and open items needing counsel. |

## High-level architecture

```
                    ┌──────────────────────── Vapi ─────────────────────────┐
 Callee ◄──Twilio──►│  Deepgram (STT) → Claude (brain) → Vapi/11Labs (voice) │
   (carrier)        └───────────┬────────────────────────────┬──────────────┘
                     tool-calls │                             │ end-of-call / status / transcript
                                ▼                             ▼
      ┌────────────────────── THIS SERVICE (Hono on Bun, Railway) ──────────────────────┐
      │  /vapi/webhook   x-vapi-secret (fails closed) — inbound + outbound handlers      │
      │  /outbound/*     dashboard API — Supabase user JWT + CORS + rate limit           │
      │  campaign worker 15s tick: dial within guardrails, budgets, stale sweeper,       │
      │                  Twilio cost auto-sync, auto campaign insights                   │
      └──────┬────────────────────┬───────────────────┬──────────────────┬──────────────┘
             ▼                    ▼                   ▼                  ▼
      GoHighLevel CRM      Supabase (Postgres)     Vapi REST         Twilio REST
    (inbound leads/surveys)  ax_voice_call        (place calls,    (authoritative cost /
                             + outbound.*          patch prompts)   status / answered-by)
                                   ▲
                                   │ reads + Realtime as the AUTHENTICATED user
                        Next.js dashboard (web/) — login-gated (invite-only Supabase Auth)
                        console (live campaigns, monitor, leads, controls) + /analytics
```

- **Backend** — TypeScript on **Bun**, the [Hono](https://hono.dev) web framework. Entry point: `src/index.ts`. `/health` is a dependency-free liveness check; **`/ready`** additionally verifies Supabase is reachable and the `outbound` schema is exposed.
- **Security** — `/vapi/webhook` verifies `x-vapi-secret` (constant-time) and **fails closed** without it; every `/outbound/*` route requires a **Supabase user JWT**, CORS is locked to `DASHBOARD_ORIGIN`, requests are rate-limited, uploads size-capped. Database reads run under authenticated-only RLS.
- **Dashboard** — Next.js 14 + Tailwind in `web/`, **login-gated** (invite-only Supabase Auth, no public signup). Reads Supabase directly (Realtime) as the logged-in user and acts through the backend API with its JWT.
- **Hosting** — Railway (Docker / Bun) for the backend, Netlify for the dashboard. The server boots even with missing config so the health check stays green; each feature warns until its keys are present. **Run a single Railway instance** — worker and per-call state are in-memory.

## Repository layout

```
src/
  index.ts              Hono server: /health, /ready, /vapi/webhook, mounts outbound routes,
                        graceful shutdown + boot-resume of the campaign worker
  config/env.ts         All env access + assert* helpers (boots even when empty)
  lib/                  auth.ts (webhook secret + requireAuth JWT middleware),
                        rateLimit.ts, redact.ts (PII-safe logging)
  assistant/            Inbound assistant: systemPrompt.ts, tools.ts, config.ts
    brands.ts           Per-brand registry: 6 brands, Twilio caller IDs, voices, compliance
    voicePipeline.ts    Transcriber/voice/endpointing shared config
    outbound/           Outbound assistant: prompt.ts (disclosure opener), tools.ts, config.ts
  vapi/                 Inbound webhook types + handlers
  outbound/             dialer.ts (worker + guardrails), handlers.ts, routes.ts, db.ts
                        (retry + dead-letter), twilioSync.ts, timezone.ts, phone.ts,
                        voice.ts, brandStore.ts, import.ts
  ghl/                  GoHighLevel client + domain ops
  supabase/             ax_voice_call writer
  ai/                   analyzeTranscript.ts (inbound post-call), campaignInsights.ts
                        (outbound self-learning)
scripts/
  create-assistant.ts            Create/update the inbound Vapi assistant
  create-outbound-assistant.ts   Create/update the generic/fallback outbound assistant
  create-brand-assistants.ts     Create/update one Vapi assistant per brand
  import-twilio-numbers.ts       Register your Twilio DIDs in Vapi as caller IDs
  import-leads.ts                Import a region's leads workbook
  import-codes.ts                Seed the violation-code / compliance KB
  check-outbound-db.ts           Diagnostic: verify the outbound schema is reachable
  elevenlabs/create-convai-agent.ts  ElevenLabs Conversational AI evaluation POC
  seed/                          ca_elevator_compliance.csv (code KB, draft)
  sql/                           ax_voice_call.sql + outbound_schema.sql (both idempotent)
web/                  Next.js dashboard — /login, console (live campaigns, live monitor,
                      campaign controls, leads, test-call, insights, export) + /analytics
                      (funnel, trends, costs, call quality, compliance audit)
data/                 Lead workbooks + code lists (PII) — gitignored, never committed
```

> **Quick start:** read [setup.md](setup.md), then [outbound-campaigns.md](outbound-campaigns.md) to launch a campaign.
