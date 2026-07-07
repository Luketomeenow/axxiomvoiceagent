# Inbound Agent

The inbound agent answers every call to Axxiom 24/7. Its scope is **customer inquiries + new sales leads** — it is *not* an emergency dispatcher, but it carries a safety net that hands an entrapment/injury call straight to a human.

## Call flow

```
Caller → Vapi (STT → Claude → ElevenLabs) ──tool-calls──▶ THIS SERVICE ──▶ GoHighLevel
                                          ──end-of-call──▶ THIS SERVICE ──▶ Supabase (ax_voice_call)
```

The assistant config (`src/assistant/config.ts`) is pushed to Vapi by `bun run create-assistant`. The brain is Claude (`ANTHROPIC_MODEL`, default `claude-sonnet-4-6`) with the system prompt in `src/assistant/systemPrompt.ts`.

## What the agent does

0. **Discloses up front.** The greeting is a fixed first message (`buildFirstMessage` in `systemPrompt.ts`): *"Thanks for calling …, this is …, a virtual AI assistant — just so you know, this call is recorded."* — the AI + recording notice precedes any conversation (AB 2905 / CIPA posture, matching the outbound agents).
1. **Safety check first (highest priority).** If anyone is *trapped* or *injured*, it stops everything and calls `transferCall` immediately; if the transfer fails it tells the caller to do `EMERGENCY_INSTRUCTION` (default: "hang up and dial 911"). It never qualifies a lead during an emergency.
2. **Identifies the caller** — new prospect vs. existing customer (calls `lookupContact` to pull a known customer's record; the caller's number is passed in automatically).
3. **New prospect → qualify, then book** — gathers name, callback number, building name/address, elevator count, the issue, and decision-maker status, then calls `bookSurvey` to create the lead and book a site survey.
4. **Existing customer** — helps with their question; transfers (or takes a message) for account/billing/complaints.

## Tools

| Tool | Required params | What it does |
|------|-----------------|--------------|
| `lookupContact` | _(none)_ — `phone` defaults to the caller; optional `email` | Looks up an existing customer in GoHighLevel and returns their account context. |
| `bookSurvey` | `fullName`, `phone`, `buildingAddress` | Creates the lead in the CRM and books a site survey on the configured calendar. |
| `transferCall` | _(built-in)_ | Warm-transfers to `TRANSFER_PHONE_NUMBER` (only wired when set). |

Full parameter schemas are in [api-reference.md](api-reference.md).

## Hard rules baked into the prompt

- Never quote/commit to price, timeline, or guarantee — a specialist confirms at the survey.
- Answers honestly that it's an AI if asked.
- Never invents account/pricing/availability facts.
- Reads phone numbers and addresses back to confirm.

## Call log

Every completed call writes a row to `ax_voice_call` in Supabase (`src/supabase/voiceCall.ts`), mirrored to Fabric. If `ENABLE_TRANSCRIPT_ANALYSIS=true` (and `ANTHROPIC_API_KEY` is set), a post-call Claude pass adds sentiment / objections / next-best-action (`src/ai/analyzeTranscript.ts`). The table is **RLS-locked to the service role** (no anon/authenticated reads — it holds full transcripts + caller numbers). The handler also tags the GHL contact with the outcome (`voice-booked` / `voice-transferred` / `voice-handled`).

## Configuration knobs

The prompt is templated from business-config env vars so it stays generic: `COMPANY_NAME`, `AGENT_NAME`, `SERVICE_AREA`, `BUSINESS_HOURS`, `BOOKING_TYPE`. Change these in `.env` and re-run `create-assistant`.

## Production notes

- `/vapi/webhook` **requires `VAPI_SERVER_SECRET`** (fails closed with 503 when unset) — the create script writes the secret into the assistant's server config.
- Per-call state is in-memory (single instance). Move to Supabase/Redis before scaling out.
- Confirm GHL response shapes (search, free-slots, appointments) against the live account — marked `TODO` in `src/ghl/api.ts`.
- The AI/recording disclosure is deterministic (fixed greeting), not model-generated; keep it in sync with the recording posture in `config.ts`. Wording is drafted — confirm with counsel.
