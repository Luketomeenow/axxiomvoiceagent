# Setup & Deployment

## Prerequisites

- **[Bun](https://bun.sh) 1.1+** runs the HTTP server. The CLI scripts also have Node fallbacks (via `tsx`) if you don't have Bun.
- A **Supabase** project (Postgres + Realtime).
- A **Vapi** account, with your **ElevenLabs** key added in Vapi → Provider Keys.
- A **GoHighLevel** (LeadConnector v2) account — for the inbound CRM flow.

## Install & run locally

```bash
bun install
cp .env.example .env        # fill in keys (see "Environment" below)
bun run dev                 # server on http://localhost:3000 (watch mode)
bun run typecheck           # tsc --noEmit — the static gate (no tests/linter)
```

Expose the local server so Vapi can reach it during testing (e.g. `ngrok http 3000`) and set `SERVER_URL` to that public URL.

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
| Vapi | `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_SERVER_SECRET` |
| Outbound | `OUTBOUND_ASSISTANT_ID` (env-default/fallback assistant), `OUTBOUND_TIMEZONE`, `CALL_WINDOW_START`/`END`, `MAX_CONCURRENT_CALLS`, `MAX_CALL_ATTEMPTS`, `ENABLE_VOICEMAIL_DETECTION` |
| GoHighLevel | `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`, `GHL_CALENDAR_ID`, `GHL_PIPELINE_ID`, `GHL_PIPELINE_STAGE_ID`, `GHL_TIMEZONE` |
| Transfer / safety | `TRANSFER_PHONE_NUMBER`, `EMERGENCY_INSTRUCTION` |
| Voice + LLM | `ELEVENLABS_VOICE_ID`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `ENABLE_TRANSCRIPT_ANALYSIS` |
| ElevenLabs (optional) | `ELEVENLABS_API_KEY` (dashboard voice list + Convai POC), `ELEVENLABS_AGENT_ID` (the Convai POC agent) — see [voices.md](voices.md) |

> **Per-brand agents** (caller IDs, voices) are configured in code (`src/assistant/brands.ts`), not env. See [brands.md](brands.md).
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOICE_CALL_TABLE` |
| Business (prompt) | `COMPANY_NAME`, `AGENT_NAME`, `SERVICE_AREA`, `BUSINESS_HOURS`, `BOOKING_TYPE` |

> **Secrets & PII:** `.env*` and the `data/` folder (lead workbooks, code lists) are gitignored **and** dockerignored. Never commit them.

## Supabase setup

Run the DDL in the Supabase SQL editor (both are safe to re-run — everything is `if not exists`):

1. `scripts/sql/ax_voice_call.sql` — the inbound call log table.
2. `scripts/sql/outbound_schema.sql` — the entire `outbound` schema (campaigns, leads, calls, events, DNC, the code reference, and the sales-ready columns).

Then, for the dashboard:

- **Database → Replication:** enable Realtime for the `outbound` schema.
- **Settings → API → Exposed schemas:** add `outbound`.

The dashboard reads with the **anon** key (read-only RLS policies); all writes go through the backend with the **service-role** key (which bypasses RLS). For production, put the dashboard behind auth and tighten the read policies from `anon` to `authenticated` so lead PII isn't exposed. See [database.md](database.md).

## Wire up Vapi

1. Add your ElevenLabs key in Vapi → Provider Keys.
2. `bun run create-assistant` → creates the **inbound** assistant, prints `VAPI_ASSISTANT_ID` (put it in `.env`). Set `VAPI_PHONE_NUMBER_ID` and re-run to attach the number.
3. `bun run create-outbound-assistant` → creates the generic/fallback **outbound** assistant, prints `OUTBOUND_ASSISTANT_ID` (put it in `.env`).
4. `bun run create-brand-assistants` → creates/updates **one assistant per brand** from `src/assistant/brands.ts` (ids stored in the DB). See [brands.md](brands.md).
5. (Optional) `bun run create-convai-agent` → the ElevenLabs Conversational AI **evaluation POC**. See [voices.md](voices.md).
6. Point your inbound / CallRail tracking number at the inbound Vapi number.

> Re-run the `create-*` scripts whenever you change a prompt, tool, voice, or brand (`src/assistant/**`, `brands.ts`) — they PATCH the existing assistant when its id is known, otherwise POST a new one.

### Other scripts
- `bun run import-leads <file.xlsx> --region "…" [--campaign "…"]` — import a region's leads (one campaign per region).
- `bun run import-codes [scripts/seed/ca_elevator_compliance.csv]` — seed the violation-code knowledge base.

## Deploy (Railway)

The repo ships a `Dockerfile` (Bun base image) and `railway.json`:

1. Push the repo; Railway builds the Dockerfile and runs `bun run src/index.ts` with health check `/health`.
2. Set all env vars in Railway, including `SERVER_URL` = your Railway URL.
3. Set the same `SERVER_URL`-derived webhook on the assistants (the create scripts read `SERVER_URL` to set `${SERVER_URL}/vapi/webhook`).

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
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **anon** key (read + Realtime only) |
| `NEXT_PUBLIC_API_BASE` | Backend base URL (default `http://localhost:3000`; in prod, the Railway URL) |

### Deploy the dashboard (Netlify)

The dashboard deploys to **Netlify**; the **backend stays on Railway** (Netlify can't host the persistent Bun webhook + dialer worker). Config lives in `netlify.toml` (root): `base = "web"`, `npm run build`, Node 20, and the official `@netlify/plugin-nextjs` runtime.

1. Netlify → **Add new site → Import from Git**, pick this repo. `netlify.toml` already points the build at `web/` — no manual build settings needed.
2. **Site settings → Environment variables** — add the three `NEXT_PUBLIC_*` vars above. Set **`NEXT_PUBLIC_API_BASE` to your Railway backend URL** (not localhost).
3. Deploy. The backend already allows CORS on `/outbound/*`, so the Netlify-hosted dashboard can call it.

> These are `NEXT_PUBLIC_*` (inlined at build time) — after changing any of them in Netlify, trigger a **redeploy**.
