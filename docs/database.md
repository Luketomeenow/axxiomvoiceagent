# Database

**Azure Database for PostgreSQL** — server `psql-axxiom-marketing`, database `axxiom_hub` (the marketing hub's warehouse; the hub's Voice page, report emails and agent service read these tables, so names and columns are a shared contract). Two areas: the inbound call log in `public`, and the outbound campaign in its own `outbound` schema. The DDL is **`scripts/azure/sql/voice_schema.sql`** — idempotent, applied from Azure Cloud Shell; re-run it after pulling schema changes. (`scripts/sql/*.sql` are the legacy Supabase versions of the same tables.)

Only this service connects: it logs in as its **managed identity** (`umi-axxiom-voice`, an Entra token as the password — see [azure.md](azure.md)) through `src/lib/dataClient.ts`. The dashboard never touches the database; it reads through the API.

## Inbound — `public.ax_voice_call`

One row per inbound call, written by `src/vapi/voiceCall.ts` and mirrored to Fabric. Table name overridable via `VOICE_CALL_TABLE`. Key columns: `call_id (unique), caller_number, call_type, outcome, ended_reason, duration_seconds, booked_appointment, appointment_time, transferred_to_human, transcript, summary, sentiment_score, objections[], next_best_action, recording_url, raw`.

**Access:** read/write for the app's role; read-only for the hub's identity (`voice.reader_role` in the schema file). Nothing else.

## Outbound — `outbound` schema

Read and written only by the backend (`db()` in `src/outbound/db.ts`, default schema `outbound`). `/ready` checks it's reachable with the app's grants.

### `campaign`
A named run over a region's leads, with calling guardrails.
`id, name, region, brand, segment, status (draft|running|paused|done), timezone, call_window_start (8), call_window_end (21), max_concurrent (1), max_attempts (3), max_calls_per_run, run_started_at, created_at, updated_at`.
- `brand` = a brand slug (see [brands.md](brands.md)) — routes calls to that brand's assistant + Twilio caller ID. Auto-assigned from the leads on import/start; setting it also sets `timezone` from the brand.
- `max_calls_per_run` + `run_started_at` = the **per-run call budget**: each Start stamps `run_started_at`; the worker counts dials since then and auto-pauses the campaign at the budget. `null` = unlimited.

### `lead`
One row per imported device/contact. Grouped by `campaign_id`; unique on `(device_id, contact_phone)`.

- **Identity / dial:** `contact_name, contact_title, contact_email, contact_phone, owner_phone, dial_phone`
- **Building / equipment:** `building_name, address, city, state, zip, region, market, device_id, equipment_type, manufacturer, service_company, oem_match, problem_type, inspection_type`
- **Inspection record (drives code accuracy):** `violation_codes, violation_count, violation_details, last_inspection_date, cert_expiry_date`
- **Scoring:** `lead_score, lead_tier, servicing_brand`
- **Campaign state:** `disposition, attempts, last_attempt_at, next_attempt_after (retry backoff / frequency-cap cooldown), consent_recording, consent_recording_at, dnc, notes`
- **Sales-ready qualification (captured on the call):** `decision_maker, current_provider, timeline, callback_name, callback_phone, callback_email, qualified_at`
- **Provenance:** `source_url, date_scraped, raw (jsonb)`

### `call`
One row per dial attempt: `lead_id (nullable — null for test calls), campaign_id, vapi_call_id (unique), phone_number, status (queued|ringing|in-progress|ended), outcome, disposition, brand, attempt_number, control_url (live end-call), consent_captured, consent_at, disclosed_at, transferred_to_human, duration_seconds, ended_reason, ended_by (customer|agent|operator|system), transcript, summary, sentiment_score, structured_data, success_evaluation, recording_url, vapi_cost, telephony_cost, provider_call_id (Twilio Call SID), provider_status, answered_by (Twilio AMD), raw, started_at, ended_at`.
- **Compliance stamps:** `disclosed_at` (deterministic opener spoken; backfilled at end-of-call) + `consent_at`/`consent_captured` (the `confirmConsent` tool).
- **Attribution:** `ended_by` is derived from Vapi's `endedReason` — who hung up.
- **Costs:** `vapi_cost` from Vapi's end-of-call report; `telephony_cost`/`provider_status`/`answered_by` reconciled from **Twilio** by `provider_call_id` (see [outbound-campaigns.md](outbound-campaigns.md)).

### `call_event`
Append-only live feed + compliance audit: `call_id, vapi_call_id, type (status-update | transcript | tool-call | consent | disclosure | end-of-call), role, text, payload, at`. Includes every `lookupViolationCode` call.

### `dnc_suppression`
Numbers never to dial (the call blocker): `phone (E.164, pk), reason, source (caller_request | manual | imported), created_at`. Checked fail-closed before every dial; DSAR deletion keeps this entry.

### `code_reference`
Curated, authoritative violation codes + compliance topics the agent's `lookupViolationCode` reads from. Seeded via `bun run import-codes`.
`code (pk, normalized), jurisdiction, title, plain_summary, severity, typical_remedy, source_url, created_at, updated_at`.

### `failed_op`
Dead-letter queue for resilient writes: `kind (lead.update | call.update | call_event | call.insert | dnc_suppression), ref_id, payload, error, resolved, created_at`. Outbound writes go through `updateLead`/`updateCall`/`recordEvent` (retry ×2 → dead-letter, never throw); replay via `POST /outbound/failed-ops/replay`. The `/analytics` page shows the unresolved count — keep it at 0.

### `campaign_insight`
AI campaign-improvement proposals (see self-learning in [outbound-campaigns.md](outbound-campaigns.md)): `campaign_id, brand, calls_analyzed, window_from/to, report, suggested_prompt, guardrail_passed, guardrail_notes, status (proposed|approved|applied|rejected), approved_by, approved_at, applied_at, model, raw`.

### `app_setting`
Small key/value store for runtime config. Keys in use:
- `brand_assistant:<slug>` → that brand's Vapi assistant id (written by `create-brand-assistants`).
- `brand_prompt:<slug>` → an **approved** prompt override from a campaign insight (honored by `create-brand-assistants` on re-runs).
- `brand_voice:<slug>` → a brand's chosen voice (optional override).
- `vapi_voice_id` / `elevenlabs_voice_id` → the env-default Vapi / Convai POC voices (the dashboard voice picker).

### Analytics views (`v_*`, all `security_invoker`)
Read by `GET /outbound/analytics` + `/analytics/compliance` and the dashboard `/analytics` page:
- **`v_campaign_funnel`** — per-campaign totals: leads, contacted, qualified, needs_followup, not_interested, no-contact, removed, DNC, attempts.
- **`v_daily_metrics`** — per-day (Pacific) calls, qualified, transferred, voicemail, no-answer, failed, avg duration.
- **`v_call_quality`** — per campaign **and brand** (≈ per caller ID): calls, completed, connected, avg duration/talk, avg sentiment, transferred, voicemail, no-answer, failed, stale, `ended_customer/agent/operator/system`, `vapi_cost`, `telephony_cost`, `total_cost`.
- **`v_attempt_distribution`** — leads + qualified by attempt count.
- **`v_compliance_audit`** — per call: disclosure logged, consent captured/at, and whether the audit events exist.

### `dashboard_user`
Dashboard logins (replaced Supabase Auth): `email` (unique, lowercase), `name`, `password_hash` (scrypt — `src/lib/passwords.ts`), `role`, `disabled`, `session_version` (bumped on password change/disable → every session for that user is signed out), `last_login_at`. Rows are created with `bun run dashboard-user` (see [azure.md](azure.md#dashboard-accounts)). **Never granted to the hub's reader role.**

## Live updates & access

- **Live updates** (formerly Supabase Realtime): every successful write the backend makes through `dataClient()` publishes one change event per statement (`src/lib/changes.ts`); `GET /outbound/events` streams the `campaign`, `call`, `call_event`, `lead` and `campaign_insight` ones to the dashboard as server-sent events. No database publication or trigger is involved — the backend is the only writer.
- **Access**: plain GRANTs, no RLS layer (no browser ever connects). `voice.app_role` = read/write on `outbound.*` + `public.ax_voice_call`; `voice.reader_role` = read-only, minus `dashboard_user`. Both set at the top of `voice_schema.sql`.
- **No laptop access**: the server firewall allows Azure services only — admin SQL runs in Cloud Shell. Your login defaults to role `dataservices@…`; `set role "<your email>"` first so you own what you create (the schema file does this).
