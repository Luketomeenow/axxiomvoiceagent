# Database

Supabase Postgres. Two areas: the inbound call log in `public`, and the outbound campaign in its own `outbound` schema. DDL lives in `scripts/sql/` and is safe to re-run (`if not exists` / additive `alter`s).

## Inbound — `ax_voice_call` (`scripts/sql/ax_voice_call.sql`)

One row per inbound call (transcript, summary, outcome, disposition, recording, etc.), written by `src/supabase/voiceCall.ts` and mirrored to Fabric. Table name overridable via `VOICE_CALL_TABLE`.

## Outbound — `outbound` schema (`scripts/sql/outbound_schema.sql`)

Accessed by the backend with the service-role key (default schema set to `outbound` in `src/outbound/db.ts`); read by the dashboard with the anon key + Realtime.

### `campaign`
A named run over a region's leads, with calling guardrails.
`id, name, region, brand, segment, status (draft|running|paused|done), timezone, call_window_start, call_window_end, max_concurrent, max_attempts, created_at, updated_at`.
- `brand` = a brand slug (see [brands.md](brands.md)); routes the campaign's calls to that brand's assistant + caller ID. Assigning it also sets `timezone` from the brand.

### `lead`
One row per imported device/contact. Grouped by `campaign_id`; unique on `(device_id, contact_phone)`.

- **Identity / dial:** `contact_name, contact_title, contact_email, contact_phone, owner_phone, dial_phone`
- **Building / equipment:** `building_name, address, city, state, zip, region, market, device_id, equipment_type, manufacturer, service_company, oem_match, problem_type, inspection_type`
- **Inspection record (drives code accuracy):** `violation_codes, violation_count, violation_details, last_inspection_date, cert_expiry_date`
- **Scoring:** `lead_score, lead_tier, servicing_brand`
- **Campaign state:** `disposition, attempts, last_attempt_at, consent_recording, dnc, notes`
- **Sales-ready qualification (captured on the call):** `decision_maker, current_provider, timeline, callback_name, callback_phone, callback_email, qualified_at`
- **Provenance:** `source_url, date_scraped, raw (jsonb)`

### `call`
One row per dial attempt: `lead_id (nullable — null for test calls), campaign_id, vapi_call_id, phone_number, status, outcome, disposition, consent_captured, transferred_to_human, duration_seconds, ended_reason, transcript, summary, recording_url, raw, started_at, ended_at`.

### `call_event`
Append-only live feed + compliance audit: `call_id, vapi_call_id, type (status-update | transcript | tool-call | consent | disclosure | end-of-call), role, text, payload, at`. Includes every `lookupViolationCode` call.

### `dnc_suppression`
Numbers never to dial: `phone (E.164, pk), reason, source (caller_request | manual | imported), created_at`.

### `code_reference`
Curated, authoritative violation codes + compliance topics the agent's `lookupViolationCode` reads from. Seeded via `bun run import-codes`.
`code (pk, normalized), jurisdiction, title, plain_summary, severity, typical_remedy, source_url, created_at, updated_at`.

### `app_setting`
Small key/value store for runtime config the dashboard/scripts change. Keys in use:
- `brand_assistant:<slug>` → that brand's Vapi assistant id (written by `create-brand-assistants`).
- `brand_voice:<slug>` → a brand's chosen voice (optional override).
- `vapi_voice_id` / `elevenlabs_voice_id` → the env-default Vapi / Convai POC voices (the dashboard voice picker).
`key (pk), value, updated_at`.

## Realtime & RLS

The script adds `lead`, `call`, `call_event`, `campaign` to the `supabase_realtime` publication and enables RLS with **read-only** policies for everyone (so the anon dashboard can read). `code_reference` also has a read policy. **All writes go through the backend** (service role, bypasses RLS).

> **Production hardening:** put the dashboard behind auth and change the read policies from `using (true)` to `authenticated`, so lead PII isn't exposed to anyone holding the anon key. Also expose the `outbound` schema under Settings → API → Exposed schemas, and enable Realtime under Database → Replication.
