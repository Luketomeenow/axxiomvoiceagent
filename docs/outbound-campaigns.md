# Outbound Campaigns

A compliant outbound calling system that dials elevator-violation leads **region by region**, discloses + captures consent, qualifies whether they want the brand's help, looks up violation **codes** accurately, dispositions each lead into **sales-ready** data — and is monitored, measured, and **continuously improved** from the dashboard. Everything lives in a dedicated Supabase **`outbound` schema** (separate from the inbound `ax_voice_call`).

```
Leads xlsx ──import (CLI or dashboard upload)──▶ outbound.lead ──auto-assign──▶ campaign.brand
Worker (15s tick) / "call now" / test call ──▶ Vapi ──status/transcript/tools/end-of-call──▶ /vapi/webhook
        │  guardrails: window(lead tz) · DNC · per-number cap · attempts+backoff ·        │
        │  in-flight guards (lead + number) · distinct numbers per batch ·                 │
        │  per-run budget · stale sweeper · systemic auto-pause                            ▼
        │                                     outbound.call + call_event + lead disposition + sales fields
        ├── every ~5 min: Twilio cost/status sync            │
        └── every N ended calls: AI campaign insight         ▼
Dashboard (login-gated) ◀── Supabase Realtime + authenticated API ── console + /analytics
```

The shared outbound assistant logic is defined in `src/assistant/outbound/` (qualification prompt, deterministic disclosure opener, tools); each **brand** gets its own Vapi assistant + Twilio caller ID ([brands.md](brands.md)). The dialer, webhook handlers, and HTTP API live in `src/outbound/`.

---

## 1. Launch a campaign per region

**The model is one campaign per region.** Each region's workbook is imported into its own `outbound.campaign` row; the dashboard has a **region/campaign selector** that scopes the stats, leads table, live monitor, and exports.

### Import a region's leads

```bash
bun run import-leads <path-to-xlsx> --region "CA — Bay Area" [--sheet "Tier A - Campaign Ready"] [--campaign "Custom name"]
```

Or upload from the dashboard (**Import leads** card → preview sheets → import; 15 MB cap).

- `--region` names (and creates/updates) the campaign and is stamped on every lead in that file. The campaign name defaults to the region; override with `--campaign`.
- Phones are normalized to E.164, deduped on `(device_id, contact_phone)`, direct contact numbers are preferred over owner lines, and toll-free-only rows are flagged `bad_number`.
- **The campaign's brand is auto-assigned from the leads** right after import (see [brands.md](brands.md)) — no manual voice/caller-ID picking needed.
- Re-running the same region is safe — it upserts that campaign and its leads only.

> Expected workbook columns (read leniently): `contact_name`, `contact_title`, `contact_email`, `contact_phone`, `owner_phone`, `building_name`, `address`, `city`, `state`, `zip`, `market`, `device_id`, `equipment_type`, `manufacturer`, `service_company`, `oem_match`, `problem_type`, `inspection_type`, `violation_codes`, `violation_count`, `violation_details`, `last_inspection_date`, `cert_expiry_date`, `lead_score`, `lead_tier`, `servicing_brand`, `source_url`, `date_scraped`.

### Start / pause — with a per-run budget

Pick the campaign in the dashboard and hit **Start** (optionally setting **Calls this run** and **concurrency**). A **confirmation popup** first shows the calling-window status per timezone group — how many eligible leads are dialable *right now* vs. when each group's window opens (e.g. "661 CA leads — opens 8:00 AM PT, in 47m") — so a quiet campaign is never a mystery. Starting early is always safe: the dialer holds each lead until its local window opens. Under the hood:

- `POST /outbound/campaign/start` `{ campaignId, maxCalls?, maxConcurrent? }` — marks it `running`, stamps `run_started_at`, and starts the worker. **Each Start is a fresh batch**: the worker counts dial attempts since `run_started_at` and **auto-pauses that campaign** when it reaches `maxCalls`. Omit `maxCalls` for unlimited.
- `POST /outbound/campaign/pause` — pause one (or all). The worker keeps ticking while any campaign runs **or any call is still live** (so the stale sweeper can close in-flight calls after a pause — otherwise a missed webhook left a call "ringing" forever) and self-stops once both are quiet.

**Multiple campaigns run concurrently.** Each `running` campaign is ticked independently with its own calling window, budget, and `max_concurrent`; active-call counts are **scoped per campaign**, so one campaign can't starve another. Total simultaneous calls = the sum of every running campaign's `max_concurrent` — mind your Vapi/Twilio account concurrency limit (there is no global cap).

**Concurrency means distinct people.** Each tick's dial batch is deduped to **distinct phone numbers** — many lead rows share one number (a single contact managing several buildings; some numbers cover 10+ rows), so `max_concurrent: 3` dials 3 *different* numbers, never the same person 3× simultaneously. A per-number in-flight guard enforces the same rule across ticks and manual call-now.

### The worker's guardrails (every 15 s tick)

Order of checks per lead (`placeCall` in `src/outbound/dialer.ts`):

1. Dialable phone present, lead not `dnc`.
2. **In-flight guards (lead + number)** — skip if the lead *or its phone number* already has a live call (prevents tick + call-now double-dials, and stops lead rows that share one contact number from ringing the same person twice at once).
3. **DNC suppression, fail-closed** — a listing blocks and marks the lead; an infrastructure lookup *error* blocks the dial without mislabeling the lead.
4. **Calling window in the lead's own timezone** — `timezoneForState(lead.state)`, falling back to the campaign tz.
5. **Per-number frequency cap** — max `MAX_CALLS_PER_NUMBER_PER_DAY` per phone per rolling 24 h (sets a cooldown so it isn't rechecked every tick).
6. Brand routing (assistant + caller ID), then dial via Vapi with the lead's `variableValues`.

Around the loop: leads are picked highest `lead_score` first among retryable dispositions (`new/queued/no_answer/voicemail/ivr`) under the attempt cap and past their `next_attempt_after` backoff (`RETRY_BACKOFF_MINUTES`), then the batch is **deduped to distinct phone numbers** (a skipped lead doesn't consume a concurrency slot); a **re-entrancy guard** stops overlapping ticks; a **stale-call sweeper** closes any call stuck live >15 min (`ended_reason='stale-timeout'`) and returns its lead to a retryable state — a missed end-of-call webhook can't pin a concurrency slot or strand a lead; and **systemic dial errors** (daily caps, billing, concurrency limits) auto-pause the campaign instead of burning the whole lead list. The worker resumes automatically after a redeploy if a campaign is still `running` **or any call is still live** (so stray calls always get swept).

---

## 2. Accuracy & value — what's wrong with their elevator

The agent's job is to **lead with value**: tell the prospect, accurately, what the public record shows about their building — then offer help. It must never invent specifics.

> **What the leads actually contain:** these leads are flagged by an **overdue State inspection and/or an expired permit (certificate of operation)** — *not* by specific cited code violations. In the current workbook the `violation_codes` / `violation_details` columns are empty. So the truthful, valuable hook is the **overdue/expired status with the real dates**, and any specific deficiencies are framed as "what the free survey identifies."

### (a) The verified status is spoken first

Each call injects the building's real compliance status into the prompt via Vapi `variableValues` (computed in `src/outbound/dialer.ts` → `variableValuesFor`): `{{humanProblem}}` (e.g. "an overdue State elevator inspection"), `{{lastInspectionDate}}`, `{{certStatus}}`, plus `{{buildingName}}`/`{{address}}`/`{{city}}`/`{{oemMatch}}`. The **deterministic opener** discloses the AI + recorded line and leads with this verified status. `{{violationCodes}}` is only referenced when non-empty.

### (b) A verified knowledge base for "what does that mean?"

The agent has a `lookupViolationCode` tool covering **compliance topics** (`overdue inspection`, `expired permit`, `permit to operate`, …) **and** specific code sections. Before explaining what any of these means — or confirming a code a caller cites — it calls the tool, which reads **only** from the curated `outbound.code_reference` table and returns the verified `plain_summary` / `severity` / `typical_remedy`. If it's not found, the agent says the team will confirm — it never guesses. Every lookup is logged to `call_event`.

### Seed the knowledge base

A drafted starter KB ships in the repo at **`scripts/seed/ca_elevator_compliance.csv`** (topic entries + common CA code categories from CCR Title 8 / ASME A17.1):

```bash
bun run import-codes scripts/seed/ca_elevator_compliance.csv
# or without Bun:  npm run import-codes:node -- scripts/seed/ca_elevator_compliance.csv
```

Columns (header names are case/space-insensitive, aliases accepted): `code` (required — a topic key or a code), `jurisdiction`, `title`, `plain_summary`, `severity`, `typical_remedy`, `source_url`. Keys are normalized so they match how the agent queries. Upserts on `code`, so editing + re-running is safe.

> ⚠️ **The seed CSV is a DRAFT — Axxiom must review/verify it before live calls** (see `scripts/seed/README.md`). Until the table is seeded, `lookupViolationCode` safely returns "not found → the team will confirm."

---

## 3. The call flow: disclosure → consent → qualification

1. **Deterministic opener** (assistant speaks first): discloses the AI + recorded line, then the building's verified status. Stamps `disclosed_at` + a `disclosure` audit event (backfilled at end-of-call if needed).
2. **`confirmConsent`** the moment the person agrees (or declines) to continue on the recorded line — only an explicit "yes" writes `consent_captured`/`consent_at`. Declines are honored (wrap up / opt out).
3. **`qualifyLead`** — only after consent — captures the sales-ready fields below.
4. **`recordDisposition`** near the end sets the final outcome; `optOut` at any point suppresses the number.

If voicemail is reached (with `ENABLE_VOICEMAIL_DETECTION=true`), a short **AI-disclosed voicemail message** is left instead of the pitch. Keep detection **off** while testing conversations (false positives hang up on live humans), **on** for real campaigns.

### Qualification → sales-ready data

| Field | Set by | Meaning |
|-------|--------|---------|
| `decision_maker` | `qualifyLead` | Whether the person handles elevator-service decisions |
| `current_provider` | `qualifyLead` | Who services the elevator today |
| `timeline` | `qualifyLead` | Rough timeline in their words |
| `callback_name` / `callback_phone` / `callback_email` | `qualifyLead` | Best contact for follow-up |
| `consent_captured` / `consent_at` (call) | `confirmConsent` | Explicit recorded-line consent |
| `disposition` | `recordDisposition` | Final outcome (below) |
| `qualified_at` | `recordDisposition` | Timestamp when the lead became `qualified` |

In the dashboard, click a lead row to expand its qualification detail. Export sales-ready lists:

```
GET /outbound/export?disposition=qualified&format=xlsx&campaignId=<id>
GET /outbound/export?disposition=qualified,needs_followup&format=csv     # sales-ready (interested) set
```

### Dispositions

`new → queued/calling →` one of:

| Disposition | Meaning |
|-------------|---------|
| `qualified` | Interested, wants the survey/follow-up — **sales-ready** |
| `needs_followup` | Interested but reach someone else / call back |
| `not_interested` | Not now, keep on file |
| `remove` | Wrong number / no longer involved |
| `no_answer`, `voicemail` | Retryable (attempt cap + backoff) |
| `bad_number` | Toll-free-only / missing phone (flagged at import) |
| `dnc` | Opted out — suppressed, never dialed again |

If a call ends without the agent setting a disposition, the handler infers one from how the call ended (transferred → `qualified`, voicemail → `voicemail`, no-answer/busy → `no_answer`, else `needs_followup`). Every ended call also records **`ended_by`** (customer/agent/operator/system, derived from Vapi's `endedReason`) — shown as a badge in Recent calls.

---

## 4. Monitor it live

The console (login required) is built for running several campaigns at once:

- **Live campaigns** — one card per `running` campaign: dialed-this-run vs. budget, active calls, qualified count (Realtime + polling).
- **Live monitor** — in-flight calls with streaming transcripts (Realtime on `call` + `call_event`); an **End call** button drops a stuck/bad call via the per-call control URL (`ended_by='operator'`). If Vapi's control URL times out or rejects (the call usually already ended on Vapi's side), the row is **still marked ended** so the monitor clears — a late end-of-call webhook overwrites it with the real outcome if the call was somehow live.
- **Recent calls** — recording, summary, paginated transcript, `ended_by` badge.
- **Campaign controls** — start/pause with **Calls this run** + concurrency, rename/re-region, and the optional **Brand agent + caller ID** override ("Auto" = resolve from leads).
- **Stats bar / leads table / export** — disposition breakdown, filter/search + per-lead "call now", CSV/XLSX export presets.

## 5. Measure it — `/analytics`

The analytics page reads pre-aggregated SQL views (`GET /outbound/analytics`, `?days=7/30/90`) and shows: KPI row (leads/contacted/qualified/dials), **cost & reach** (total / per-call / per-qualified cost, connect rate, Vapi vs telephony split), the funnel, daily trends, **call quality** (connect rate, avg talk time, sentiment, transfer/no-answer, **who ended the call**, failed/stale), attempts-per-lead, **per-brand (≈ per-caller-ID) health**, and the **compliance audit card** (disclosure/consent coverage + recent-call audit table). A red banner surfaces unresolved dead-lettered writes (`failed_op`) — replay them with `POST /outbound/failed-ops/replay`.

**Telephony costs come from Twilio, not Vapi.** Vapi owns the conversation (transcript, recording, disposition, its own `vapi_cost`); **Twilio owns the authoritative carrier cost/status/answered-by**, reconciled onto call rows by Twilio Call SID — automatically every ~5 min while the worker runs, or on demand via the **"↻ Twilio costs"** button (`POST /outbound/twilio/sync`). Needs `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` on the server, else telephony cost stays empty.

> **Analysis runs in the background.** A batch analysis is a 1–2 minute Claude call, so both the auto-trigger and the **Analyze now** button run it **detached** — the worker never blocks dialing on it, and the dashboard polls for the finished `campaign_insight` row rather than holding the request open (which would time out as "Failed to fetch"). Analysis output is bounded at 8192 tokens and parsed leniently, so a long report + full proposed prompt won't truncate the result.

## 6. Improve it — AI campaign insights (human-gated self-learning)

`src/ai/campaignInsights.ts` reviews a campaign's recent transcripts + outcomes and writes a **`campaign_insight`** row containing (a) an improvement report (what's working, where calls die, objections) and (b) a **proposed improved system prompt** for that brand.

- **Triggers:** automatically after every `INSIGHT_EVERY_N_CALLS` ended calls (30-min cooldown, worker-throttled), or on demand — dashboard **Insights panel** / `POST /outbound/campaign/:id/analyze`. Needs `ANTHROPIC_API_KEY` and ≥3 transcripts.
- **Human-gated apply:** review the report + diff in the Insights panel, then **Approve** (`POST /outbound/insights/:id/approve`) to PATCH the live Vapi assistant's prompt and persist a `brand_prompt:<slug>` override in `app_setting` — re-runs of `create-brand-assistants` and redeploys keep the approved prompt. **Reject** discards it.
- **Compliance guardrail:** `checkPromptGuardrail` **blocks** approval of any prompt missing the AI-disclosure, recorded-line, consent, or opt-out language — self-learning can't optimize away compliance.

## 7. Test the agent

Use the **"Test the agent"** card: enter any phone number (plus optional contact/building/problem fields and a **brand** to test that brand's assistant + caller ID) and place the call; it streams into the live monitor like any other.

- Backend: `POST /outbound/test-call` `{ phone, name?, buildingName?, address?, city?, problemType?, violationCodes?, brand? }`.
- No lead row required (`lead_id = null`, `metadata.kind = "test"`); still honors DNC.
- Per-brand smoke test before a real campaign: one test call per brand — confirm the disclosure plays, `confirmConsent` fires on your "yes", and the caller ID shown is the brand's Twilio number (for `ameritex`, TX vs CA numbers by lead state).

> **Compliance:** only test against numbers you are authorized to call.

## 8. Data lifecycle

- **Retention:** `POST /outbound/retention/purge` nulls call content (transcript/recording/summary/raw + event payloads) older than `PII_RETAIN_DAYS` (default 90); metrics and dispositions are kept.
- **DSAR / right-to-erasure:** `POST /outbound/dsar/delete` `{ phone }` removes all lead + call data for that number, keeping **only** the DNC suppression entry so they're never re-dialed.
- Lead workbooks live in `data/` — gitignored + dockerignored, never committed.

---

## Compliance guardrails (enforced in code, not just the prompt)

These live in `src/outbound/dialer.ts` + `src/outbound/handlers.ts`, so they apply to the worker, "call now," and test calls:

- **Calling window** — TCPA 8am–9pm **in the lead's own timezone** (state → tz map, campaign tz fallback). "Call now"/test calls bypass the *window* (operator discretion) but **not** DNC.
- **Explicit consent** — deterministic AI/recorded-line opener, then `confirmConsent` before qualifying (all-party posture on every brand).
- **DNC suppression** — checked fail-closed before every dial; `optOut` suppresses + marks the lead.
- **Frequency + attempts** — per-number daily cap, per-lead attempt cap, retry backoff.
- **Append-only audit** — every status change, transcript line, tool call, disclosure, and consent moment in `outbound.call_event`; coverage on the `/analytics` compliance card.

See [compliance.md](compliance.md) for the full control map and the open legal items.
