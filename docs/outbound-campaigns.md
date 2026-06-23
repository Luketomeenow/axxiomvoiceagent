# Outbound Campaigns

A compliant outbound calling system that dials elevator-violation leads **region by region**, qualifies whether they want Axxiom's help, looks up violation **codes** accurately, dispositions each lead into **sales-ready** data, and is monitored live from the dashboard. Everything lives in a dedicated Supabase **`outbound` schema** (separate from the inbound `ax_voice_call`).

```
Leads xlsx ──import (per region)──▶ outbound.lead
Worker / "call now" / test call ──POST /call──▶ Vapi ──status/transcript/tools/end-of-call──▶ /vapi/webhook
                                                              │
                          outbound.call + call_event + lead disposition + sales fields
                                                              │
Dashboard ◀── Supabase Realtime ──┘     ◀── start/pause, call-now, test-call, export ── Hono API
```

The outbound assistant is defined in `src/assistant/outbound/` (qualification prompt, compliant disclosure, tools) and pushed to Vapi with `bun run create-outbound-assistant`. The dialer, webhook handlers, and HTTP API live in `src/outbound/`.

---

## 1. Launch a campaign per region

**The model is one campaign per region.** Each region's workbook is imported into its own `outbound.campaign` row; the dialer scopes all calling to a single `campaign_id`, and the dashboard has a **region/campaign selector** that scopes the stats, leads table, and exports.

### Import a region's leads

```bash
bun run import-leads <path-to-xlsx> --region "CA — Bay Area" [--sheet "Tier A - Campaign Ready"] [--campaign "Custom name"]
```

- `--region` names (and creates/updates) the campaign and is stamped on every lead in that file. The campaign name defaults to the region; override with `--campaign`.
- Phones are normalized to E.164, deduped on `(device_id, contact_phone)`, and toll-free-only rows are flagged `bad_number`.
- Re-running the same region is safe — it upserts that campaign and its leads only.

Repeat for each region (Bay Area, LA, etc.). Each becomes a separately controllable campaign.

> Expected workbook columns (read leniently): `contact_name`, `contact_title`, `contact_email`, `contact_phone`, `owner_phone`, `building_name`, `address`, `city`, `state`, `zip`, `market`, `device_id`, `equipment_type`, `manufacturer`, `service_company`, `oem_match`, `problem_type`, `inspection_type`, `violation_codes`, `violation_count`, `violation_details`, `last_inspection_date`, `cert_expiry_date`, `lead_score`, `lead_tier`, `servicing_brand`, `source_url`, `date_scraped`.

### Start / pause

Pick the region in the dashboard's **Region / campaign** selector and hit **Start campaign** (or **Pause**). Under the hood:

- `POST /outbound/campaign/start` marks the campaign `running` and starts the worker.
- The worker (`runCampaignTick`, every 15s) dials eligible leads for that campaign — highest `lead_score` first, within the calling window, up to the concurrency cap and attempt cap, skipping DNC and missing-phone leads.

The calling window, concurrency, and max attempts come from the campaign row (falling back to env defaults: `CALL_WINDOW_START`/`END`, `MAX_CONCURRENT_CALLS`, `MAX_CALL_ATTEMPTS`, `OUTBOUND_TIMEZONE`).

---

## 2. Accuracy & value — what's wrong with their elevator

The agent's job is to **lead with value**: tell the prospect, accurately, what the public record shows about their building — then offer help. It must never invent specifics.

> **What the leads actually contain:** these leads are flagged by an **overdue State inspection and/or an expired permit (certificate of operation)** — *not* by specific cited code violations. In the current workbook the `violation_codes` / `violation_details` columns are empty. So the truthful, valuable hook is the **overdue/expired status with the real dates**, and any specific deficiencies are framed as "what the free survey identifies."

### (a) The verified status is spoken first

Each call injects the building's real compliance status into the prompt via Vapi `variableValues` (computed in `src/outbound/dialer.ts` → `variableValuesFor`): `{{humanProblem}}` (e.g. "an overdue State elevator inspection"), `{{lastInspectionDate}}`, `{{certStatus}}` (e.g. "the certificate of operation on file expired on 2025-05-02"), plus `{{buildingName}}`/`{{address}}`/`{{city}}`/`{{oemMatch}}`. The agent opens with this — accurate, from public records. `{{violationCodes}}` is only referenced when non-empty (i.e. once you have per-building citations).

### (b) A verified knowledge base for "what does that mean?"

The agent has a `lookupViolationCode` tool covering **compliance topics** (`overdue inspection`, `expired permit`, `permit to operate`, …) **and** specific code sections. Before explaining what any of these means — or confirming a code a caller cites — it calls the tool, which reads **only** from the curated `outbound.code_reference` table and returns the verified `plain_summary` / `severity` / `typical_remedy`. If it's not found, the agent says the team will confirm — it never guesses. Every lookup is logged to `call_event`.

### Seed the knowledge base

A drafted starter KB ships in the repo at **`scripts/seed/ca_elevator_compliance.csv`** (topic entries + common CA code categories from CCR Title 8 / ASME A17.1):

```bash
bun run import-codes scripts/seed/ca_elevator_compliance.csv
# or without Bun:  npm run import-codes:node -- scripts/seed/ca_elevator_compliance.csv
```

Columns (header names are case/space-insensitive, aliases accepted): `code` (required — a topic key or a code), `jurisdiction`, `title`, `plain_summary`, `severity`, `typical_remedy`, `source_url`. Keys are normalized (uppercased; spaces/punctuation → `_`; dots kept) so they match how the agent queries. Upserts on `code`, so editing + re-running is safe.

> ⚠️ **The seed CSV is a DRAFT — Axxiom must review/verify it before live calls** (see `scripts/seed/README.md`). Until the table is seeded, `lookupViolationCode` safely returns "not found → the team will confirm," and the agent still speaks accurately about each lead's own overdue/expired status.

---

## 3. Qualification → sales-ready data

The agent captures structured qualification fields into real `outbound.lead` columns (not just a free-text note), so the sales team gets clean, actionable data:

| Field | Set by | Meaning |
|-------|--------|---------|
| `decision_maker` | `qualifyLead` | Whether the person handles elevator-service decisions |
| `current_provider` | `qualifyLead` | Who services the elevator today |
| `timeline` | `qualifyLead` | Rough timeline in their words |
| `callback_name` / `callback_phone` / `callback_email` | `qualifyLead` | Best contact for follow-up |
| `disposition` | `recordDisposition` | Final outcome (below) |
| `qualified_at` | `recordDisposition` | Timestamp when the lead became `qualified` |

In the dashboard, click a lead row to expand its qualification detail. Export sales-ready lists (the export includes all the columns above plus building/contact/region/violation context):

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
| `no_answer`, `voicemail` | Retryable (subject to attempt cap) |
| `bad_number` | Toll-free-only / missing phone (flagged at import) |
| `dnc` | Opted out — added to the suppression list, never dialed again |

If a call ends without the agent setting a disposition, the handler infers one from how the call ended (transferred → `qualified`, voicemail → `voicemail`, no-answer/busy → `no_answer`, else `needs_followup`).

---

## 4. Test the agent

To hear the live outbound agent before (or during) a campaign, use the **"Test the agent"** card at the top of the dashboard: enter any phone number (plus optional contact / building / problem / violation-code fields to shape the script) and click **Place test call**. The call streams into the live monitor like any other.

- Backend: `POST /outbound/test-call` with `{ phone, name?, buildingName?, address?, city?, problemType?, violationCodes? }`.
- It dials the **real** outbound assistant with no lead row required (the `call` row has `lead_id = null`, `metadata.kind = "test"`).
- It still honors the DNC suppression list.

> **Compliance:** only test against numbers you are authorized to call.

---

## Compliance guardrails (enforced in code, not just the prompt)

These live in `src/outbound/dialer.ts` and the handlers, so they apply to the worker, "call now," and test calls:

- **Calling window** (TCPA 8am–9pm in the lead's timezone) — the worker won't dial outside it. "Call now" and test calls bypass the *window* (operator discretion) but **not** DNC.
- **DNC suppression** — `outbound.dnc_suppression` is checked before every dial; `optOut` adds the number and marks the lead `dnc`.
- **Append-only audit** — every status change, transcript line, tool call, consent moment, and code lookup is written to `outbound.call_event`.

See [compliance.md](compliance.md) for the full CA checklist and open legal items.
