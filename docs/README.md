# Axxiom Voice Agents — Documentation

AI voice agents for Axxiom Elevator, built on **Vapi** (Deepgram speech-to-text → **Claude** → **Vapi-native / ElevenLabs** voice). This repository is the **orchestration + integration layer** that Vapi calls: it owns the business logic (GoHighLevel CRM, Supabase call logging) and runs the outbound calling campaign — with a **separate customized agent per Axxiom brand**.

There are two agents sharing one service:

| Agent | Direction | Purpose |
|-------|-----------|---------|
| **Inbound** | Answers calls 24/7 | Triage new leads vs. existing customers, book site surveys, safety hand-off to a human. |
| **Outbound** | Places calls | **Per-brand** region-by-region qualification campaigns over elevator-violation leads, with live monitoring and a sales-ready handoff. |

## Documentation map

| Doc | What's inside |
|-----|---------------|
| [setup.md](setup.md) | Install, environment variables, local dev, Railway deploy, Supabase + Vapi wiring, scripts. |
| [brands.md](brands.md) | **Per-brand outbound agents** — the brand registry, generating one Vapi assistant per brand, caller-ID + voice + compliance, and campaign→brand routing. |
| [voices.md](voices.md) | Voice providers (Vapi native vs ElevenLabs), the dashboard voice picker, and the ElevenLabs Conversational AI **evaluation POC** + agent switcher. |
| [inbound-agent.md](inbound-agent.md) | The inbound triage agent: prompt, tools, safety net, call log. |
| [outbound-campaigns.md](outbound-campaigns.md) | The outbound campaign end-to-end: **regions/brands**, lead import, the **code-reference lookup**, launching/monitoring, **dispositions → sales-ready data**, and **testing the agent**. |
| [api-reference.md](api-reference.md) | Every HTTP endpoint and every assistant tool (function) with its parameters. |
| [database.md](database.md) | Supabase schema for both flows (`ax_voice_call` + the `outbound` schema). |
| [compliance.md](compliance.md) | All-party consent policy, per-brand compliance, agent guardrails, and open items needing counsel. |

## High-level architecture

```
                 ┌──────────────────────── Vapi ────────────────────────┐
 Caller  ◄─────► │  Deepgram (STT) → Claude (brain) → ElevenLabs (voice) │
                 └───────────┬───────────────────────────┬──────────────┘
                  tool-calls │                            │ end-of-call / status / transcript
                             ▼                            ▼
                   ┌──────────────────────  THIS SERVICE (Hono on Bun)  ──────────────────────┐
                   │  /vapi/webhook       inbound + outbound handlers (tool dispatch, logging) │
                   │  /outbound/*         campaign API for the dashboard                       │
                   └───────┬───────────────────────────────┬───────────────────────┬──────────┘
                           ▼                                ▼                       ▼
                    GoHighLevel CRM                  Supabase (Postgres)     Vapi REST (place calls)
                  (inbound leads/surveys)        ax_voice_call + outbound.*
                                                          ▲
                                                          │ Realtime (anon, read-only)
                                                 Next.js dashboard (web/)
```

- **Backend** — TypeScript on **Bun**, the [Hono](https://hono.dev) web framework. Entry point: `src/index.ts`.
- **Dashboard** — Next.js 14 + Tailwind in `web/`, reads Supabase directly (anon key + Realtime), acts through the backend API.
- **Hosting** — Railway (Docker / Bun). The server boots even with missing config so the health check stays green; each feature warns until its keys are present.

## Repository layout

```
src/
  index.ts              Hono server: /health, /vapi/webhook, mounts outbound routes
  config/env.ts         All env access + assert* helpers (boots even when empty)
  assistant/            Inbound assistant: systemPrompt.ts, tools.ts, config.ts
    brands.ts           Per-brand registry (the 6 brands) + voicePipeline.ts (voices)
    outbound/           Outbound assistant: prompt.ts, tools.ts, config.ts
  vapi/                 Inbound webhook types + handlers
  outbound/             dialer.ts, handlers.ts, routes.ts, db.ts, phone.ts, voice.ts, brandStore.ts
  ghl/                  GoHighLevel client + domain ops
  supabase/             ax_voice_call writer
  ai/                   Optional post-call Claude transcript analysis
scripts/
  create-assistant.ts            Create/update the inbound Vapi assistant
  create-outbound-assistant.ts   Create/update the generic/fallback outbound assistant
  create-brand-assistants.ts     Create/update one Vapi assistant per brand
  elevenlabs/create-convai-agent.ts  ElevenLabs Conversational AI evaluation POC
  import-leads.ts                Import a region's leads workbook
  import-codes.ts                Seed the violation-code / compliance KB
  seed/                          ca_elevator_compliance.csv (code KB, draft)
  sql/                           ax_voice_call.sql + outbound_schema.sql
web/                  Next.js dashboard (monitor, leads, campaign + brand + voice + test controls, export)
data/                 Lead workbooks + code lists (PII) — gitignored, never committed
```

> **Quick start:** read [setup.md](setup.md), then [outbound-campaigns.md](outbound-campaigns.md) to launch a region.
