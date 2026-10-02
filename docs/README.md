# Axxiom Voice Agents — Documentation

AI voice agents for Axxiom Elevator, built on **Vapi** (Deepgram speech-to-text → **Claude** → **Vapi-native / ElevenLabs** voice) with **Twilio** as the telephony carrier. This repository is the **orchestration + integration layer** that Vapi calls: it owns the business logic (GoHighLevel CRM, the call log in Azure Postgres) and runs the outbound calling campaigns — a **separate customized agent per Axxiom brand**, each dialing from its **own Twilio caller ID**, with live monitoring, cost + quality analytics, and human-gated AI self-improvement.

There are two agents sharing one service:

| Agent | Direction | Purpose |
|-------|-----------|---------|
| **Inbound** | Answers calls 24/7 | Triage new leads vs. existing customers, book site surveys, safety hand-off to a human. Opens with an AI + recorded-line disclosure. |
| **Outbound** | Places calls | **Per-brand** qualification campaigns over elevator-violation leads: compliant disclosure → consent → qualification flow, multi-campaign live monitoring, per-run call budgets, cost/quality/compliance analytics, and AI-proposed prompt improvements (human-approved). |

## Documentation map

| Doc | What's inside |
|-----|---------------|
| [overview.md](overview.md) | **Plain-English executive summary** of the whole system — business value, compliance story, dashboard, status. Presentation-ready. |
| [setup.md](setup.md) | Install, environment variables, local dev, database setup, Twilio caller IDs, Vapi wiring, scripts, deploy summary. |
| [azure.md](azure.md) | **Azure hosting** — what runs where, managed identity + Key Vault, the database, deploying, dashboard accounts, **the Supabase/Railway → Azure cutover runbook**, what's needed from Zach, troubleshooting. |
| [brands.md](brands.md) | **Per-brand outbound agents** — the brand registry, one Vapi assistant per brand, **Twilio caller IDs (incl. AmeriTex per-state routing)**, automatic brand resolution, and prompt overrides from approved insights. |
| [voices.md](voices.md) | Voice providers (Vapi native vs ElevenLabs), the dashboard voice picker, and the ElevenLabs Conversational AI **evaluation POC** + agent switcher. |
| [inbound-agent.md](inbound-agent.md) | The inbound triage agent: prompt, tools, safety net, disclosure, call log. |
| [outbound-campaigns.md](outbound-campaigns.md) | The outbound campaign end-to-end: lead import, brand auto-assignment, the dialer's guardrails, **live monitoring**, the **code-reference lookup**, dispositions → sales-ready data, **analytics + Twilio cost sync**, **AI insights / self-learning**, testing, and data retention. |
| [monitoring.md](monitoring.md) | **System logs + health checks** — what the server logs, where it's stored, the checks (incl. "Vapi → this server"), the red banner, retention, and the Azure-side log stream. |
| [api-reference.md](api-reference.md) | Every HTTP endpoint (with **auth requirements**) and every assistant tool (function) with its parameters. |
| [database.md](database.md) | The schema for both flows (`ax_voice_call` + the `outbound` schema) on Azure Postgres, the analytics views, and the **access posture**. |
| [compliance.md](compliance.md) | Disclosure + explicit consent capture, calling-window/DNC/frequency guards, retention + DSAR, audit trail, and open items needing counsel. |

## High-level architecture

```
                    ┌──────────────────────── Vapi ─────────────────────────┐
 Callee ◄──Twilio──►│  Deepgram (STT) → Claude (brain) → Vapi/11Labs (voice) │
   (carrier)        └───────────┬────────────────────────────┬──────────────┘
                     tool-calls │                             │ end-of-call / status / transcript
                                ▼                             ▼
      ┌──────────── THIS SERVICE (Hono, Node 22 on Azure App Service, 1 instance) ─────────────┐
      │  /vapi/webhook    x-vapi-secret (fails closed) — inbound + outbound handlers            │
      │  /auth/*          dashboard sign-in → httpOnly session cookie                           │
      │  /outbound/*      dashboard API — session cookie + same-origin + rate limit             │
      │  /outbound/events live SSE stream of every write (replaces Supabase Realtime)           │
      │  /                the dashboard itself (Next.js static export)                          │
      │  campaign worker  15s tick: dial within guardrails, budgets, stale sweeper,             │
      │                   Twilio cost auto-sync, auto campaign insights                         │
      └──────┬────────────────────┬──────────────────────┬──────────────────┬───────────────────┘
             ▼                    ▼                      ▼                  ▼
      GoHighLevel CRM     Azure Postgres (managed     Vapi REST          Twilio REST
    (inbound leads/        identity, no password)   (place calls,     (authoritative cost /
       surveys)          axxiom_hub: ax_voice_call    patch prompts)    status / answered-by)
                           + outbound.* — also read
                           by the marketing hub
```

- **Backend** — TypeScript, the [Hono](https://hono.dev) web framework: Bun for local dev, one esbuild bundle on **Node 22** in production (`src/index.ts` runs under both). `/health` is a dependency-free liveness check (with the deployed `version`); **`/ready`** additionally verifies the database, the `outbound` schema, and which identity the app connected as.
- **Data** — **Azure Database for PostgreSQL** (`psql-axxiom-marketing` / `axxiom_hub`, the marketing hub's server), reached with the app's **managed identity** (Entra token — no password anywhere). `src/lib/dataClient.ts` keeps the Supabase query-builder dialect via the hub's pg shim, so call sites are unchanged.
- **Security** — `/vapi/webhook` verifies `x-vapi-secret` (constant-time) and **fails closed** without it; every `/outbound/*` route requires a signed **session cookie** for an invite-only account (`outbound.dashboard_user`), rejects cross-site requests, is rate-limited, uploads size-capped. Secrets live in **Key Vault**; only this service can reach the database.
- **Dashboard** — Next.js 14 + Tailwind in `web/`, exported as static files and **served by the backend** (same origin). **Login-gated**; reads through the API; live panels share one SSE stream.
- **Hosting** — Azure App Service (`app-axxiom-voice-agents`, Always-On, **one instance** — worker and per-call state are in-memory). The server boots even with missing config so the health check stays green; each feature warns until its keys are present. See [azure.md](azure.md).

## Repository layout

```
src/
  index.ts              Hono server: /health, /ready, /vapi/webhook, mounts outbound routes,
                        graceful shutdown + boot-resume of the campaign worker
  config/env.ts         All env access + assert* helpers (boots even when empty)
  lib/                  dataClient.ts (Azure Postgres / legacy Supabase + change events),
                        pg/ (shim.ts PostgREST-compatible query builder, backend.ts
                        managed-identity pool), changes.ts (live-update bus), auth.ts
                        (webhook secret + requireAuth session middleware), session.ts,
                        passwords.ts, staticDashboard.ts, rateLimit.ts, redact.ts
  auth/                 routes.ts (/auth/login|logout|me|password), users.ts
  assistant/            Inbound assistant: systemPrompt.ts, tools.ts, config.ts
    brands.ts           Per-brand registry: 6 brands, Twilio caller IDs, voices, compliance
    voicePipeline.ts    Transcriber/voice/endpointing shared config
    outbound/           Outbound assistant: prompt.ts (disclosure opener), tools.ts, config.ts
  vapi/                 Inbound webhook types + handlers, voiceCall.ts (ax_voice_call writer)
  outbound/             dialer.ts (worker + guardrails), handlers.ts, routes.ts, db.ts
                        (retry + dead-letter), twilioSync.ts, timezone.ts, phone.ts,
                        voice.ts, brandStore.ts, import.ts
  ghl/                  GoHighLevel client + domain ops
  ai/                   analyzeTranscript.ts (inbound post-call), campaignInsights.ts
                        (outbound self-learning)
scripts/
  create-assistant.ts            Create/update the inbound Vapi assistant
  create-outbound-assistant.ts   Create/update the generic/fallback outbound assistant
  create-brand-assistants.ts     Create/update one Vapi assistant per brand
  import-twilio-numbers.ts       Register your Twilio DIDs in Vapi as caller IDs
  import-leads.ts                Import a region's leads workbook
  import-codes.ts                Seed the violation-code / compliance KB
  check-outbound-db.ts           Diagnostic: verify the database + outbound schema are reachable
  dashboard-user.ts              Dashboard logins (add/reset/disable; --sql for Cloud Shell)
  build.mjs                      Production bundle → dist/server.mjs (esbuild)
  azure/                         package-app.sh, sync-app-settings.sh, migrate_from_supabase.py,
                                 sql/voice_schema.sql (the Azure schema)
  elevenlabs/create-convai-agent.ts  ElevenLabs Conversational AI evaluation POC
  seed/                          ca_elevator_compliance.csv (code KB, draft)
  sql/                           ax_voice_call.sql + outbound_schema.sql (legacy Supabase DDL)
web/                  Next.js dashboard (static export, served by the backend) — /login, console (live campaigns, live monitor,
                      campaign controls, leads, test-call, insights, export) + /analytics
                      (funnel, trends, costs, call quality, compliance audit)
data/                 Lead workbooks + code lists (PII) — gitignored, never committed
```

> **Quick start:** read [setup.md](setup.md) and [azure.md](azure.md), then [outbound-campaigns.md](outbound-campaigns.md) to launch a campaign.
