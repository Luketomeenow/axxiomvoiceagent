-- Outbound qualification campaign — dedicated `outbound` schema.
-- Run in the Supabase SQL editor (same project as ax_voice_call / axxiommarketinghub).
-- Source of truth for the outbound elevator-violation calling campaign:
--   lead -> call (one row per attempt) -> call_event (live/audit feed)
-- plus campaign config and a DNC suppression list.
--
-- Safe to re-run: everything is `if not exists`.

create schema if not exists outbound;

-- Realtime + the Next.js dashboard read these tables with the anon key, so make
-- sure Realtime is enabled for the schema in Supabase (Database -> Replication).

-- ---------------------------------------------------------------------------
-- campaign — a named run over a lead segment, with calling guardrails.
-- ---------------------------------------------------------------------------
create table if not exists outbound.campaign (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  segment            text not null default 'tier_a_campaign_ready',
  status             text not null default 'draft',   -- draft | running | paused | done
  timezone           text not null default 'America/Los_Angeles',
  call_window_start  int  not null default 8,         -- local hour, inclusive (24h)
  call_window_end    int  not null default 21,        -- local hour, exclusive (24h)
  max_concurrent     int  not null default 1,
  max_attempts       int  not null default 3,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- lead — one row per device/contact imported from the leads workbook.
-- ---------------------------------------------------------------------------
create table if not exists outbound.lead (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid references outbound.campaign (id) on delete set null,

  -- Identity / dial target
  contact_name       text,
  contact_title      text,
  contact_email      text,
  contact_phone      text,            -- preferred dial number (E.164)
  owner_phone        text,            -- fallback / often a generic line
  dial_phone         text,            -- chosen E.164 number we actually dial

  -- Building / equipment context (drives the pitch)
  building_name      text,
  address            text,
  city               text,
  state              text,
  zip                text,
  market             text,
  device_id          text,
  equipment_type     text,
  manufacturer       text,
  service_company    text,
  oem_match          text,
  problem_type       text,
  inspection_type    text,
  violation_codes    text,
  violation_count    int,
  violation_details  text,
  last_inspection_date text,
  cert_expiry_date   text,

  -- Scoring from the workbook
  lead_score         int,
  lead_tier          text,
  servicing_brand    text,

  -- Campaign state
  disposition        text not null default 'new',
    -- new | queued | calling | qualified | needs_followup | remove
    -- | no_answer | voicemail | bad_number | not_interested | dnc
  attempts           int  not null default 0,
  last_attempt_at    timestamptz,
  consent_recording  boolean,         -- null=unknown, true/false captured on a call
  dnc                boolean not null default false,
  notes              text,

  source_url         text,
  date_scraped       text,
  raw                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (device_id, contact_phone)
);

create index if not exists outbound_lead_disposition_idx on outbound.lead (disposition);
create index if not exists outbound_lead_campaign_idx    on outbound.lead (campaign_id);
create index if not exists outbound_lead_phone_idx        on outbound.lead (dial_phone);

-- ---------------------------------------------------------------------------
-- call — one row per dial attempt (mirrors the inbound ax_voice_call shape).
-- ---------------------------------------------------------------------------
create table if not exists outbound.call (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid references outbound.lead (id) on delete cascade,
  campaign_id        uuid references outbound.campaign (id) on delete set null,
  vapi_call_id       text unique,
  phone_number       text,
  status             text not null default 'queued',  -- queued | ringing | in-progress | ended
  outcome            text,                            -- qualified | needs_followup | remove | no_answer | voicemail | not_interested | transferred | failed
  disposition        text,                            -- final disposition applied to the lead
  consent_captured   boolean,
  transferred_to_human boolean default false,
  duration_seconds   numeric,
  ended_reason       text,
  transcript         text,
  summary            text,
  sentiment_score    numeric,
  recording_url      text,
  raw                jsonb,
  started_at         timestamptz,
  ended_at           timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists outbound_call_lead_idx     on outbound.call (lead_id);
create index if not exists outbound_call_status_idx   on outbound.call (status);
create index if not exists outbound_call_created_idx  on outbound.call (created_at);

-- ---------------------------------------------------------------------------
-- call_event — append-only live feed + compliance audit (disclosure ordering,
-- consent moment, transcript deltas, status changes).
-- ---------------------------------------------------------------------------
create table if not exists outbound.call_event (
  id            bigint generated always as identity primary key,
  call_id       uuid references outbound.call (id) on delete cascade,
  vapi_call_id  text,
  type          text not null,        -- status-update | transcript | tool-call | consent | disclosure | end-of-call
  role          text,                 -- assistant | user | system
  text          text,
  payload       jsonb,
  at            timestamptz not null default now()
);

create index if not exists outbound_call_event_call_idx on outbound.call_event (call_id);
create index if not exists outbound_call_event_at_idx    on outbound.call_event (at);

-- ---------------------------------------------------------------------------
-- dnc_suppression — never dial these numbers (opt-outs, manual scrubs).
-- ---------------------------------------------------------------------------
create table if not exists outbound.dnc_suppression (
  phone       text primary key,        -- E.164
  reason      text,
  source      text,                    -- caller_request | manual | imported
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Realtime — let the dashboard stream live call status + transcript events.
-- (Also enable the `outbound` schema under Database -> Replication in the UI.)
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table outbound.call;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table outbound.call_event;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table outbound.lead;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table outbound.campaign;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- RLS — the dashboard reads with the anon key. These policies allow READ ONLY
-- for anon/authenticated; all writes go through the backend (service role, which
-- bypasses RLS). For production, tighten `anon` to `authenticated` and put the
-- dashboard behind auth so lead PII isn't exposed to anyone with the anon key.
-- Also expose the `outbound` schema in Settings -> API -> Exposed schemas.
-- ---------------------------------------------------------------------------
alter table outbound.lead       enable row level security;
alter table outbound.call       enable row level security;
alter table outbound.call_event enable row level security;
alter table outbound.campaign   enable row level security;

do $$
begin
  create policy "dashboard read lead"       on outbound.lead       for select using (true);
exception when duplicate_object then null; end $$;
do $$
begin
  create policy "dashboard read call"       on outbound.call       for select using (true);
exception when duplicate_object then null; end $$;
do $$
begin
  create policy "dashboard read call_event" on outbound.call_event for select using (true);
exception when duplicate_object then null; end $$;
do $$
begin
  create policy "dashboard read campaign"   on outbound.campaign   for select using (true);
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- Migrations (additive, safe to re-run) — region campaigns, code reference,
-- and structured sales-ready qualification fields.
-- ===========================================================================

-- Live call control: Vapi's per-call control URL, used to end a call remotely
-- from the dashboard ("End call" button).
alter table outbound.call add column if not exists control_url text;

-- Region tagging: one campaign per region, region stamped on every lead.
alter table outbound.campaign add column if not exists region text;
alter table outbound.campaign add column if not exists brand text;  -- brand slug → per-brand agent + caller ID
alter table outbound.lead     add column if not exists region text;
create index if not exists outbound_lead_region_idx on outbound.lead (region);

-- Structured qualification fields captured by the agent (qualifyLead /
-- recordDisposition). Previously these only lived inside the free-text `notes`.
alter table outbound.lead add column if not exists decision_maker   boolean;
alter table outbound.lead add column if not exists current_provider text;
alter table outbound.lead add column if not exists timeline         text;
alter table outbound.lead add column if not exists callback_name    text;
alter table outbound.lead add column if not exists callback_phone   text;
alter table outbound.lead add column if not exists callback_email   text;
alter table outbound.lead add column if not exists qualified_at     timestamptz;

-- ---------------------------------------------------------------------------
-- code_reference — curated, authoritative elevator inspection / violation
-- codes. The agent's lookupViolationCode tool reads ONLY from here so it never
-- invents code meanings. Seed via `bun run import-codes`.
-- ---------------------------------------------------------------------------
create table if not exists outbound.code_reference (
  code           text primary key,     -- normalized citation, e.g. "3.10.4"
  jurisdiction   text,                  -- e.g. "CA Title 8" / "ASME A17.1"
  title          text,                  -- short official title
  plain_summary  text,                  -- one-line plain-English meaning
  severity       text,                  -- informational | minor | major | critical
  typical_remedy text,                  -- what's usually required to clear it
  source_url     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table outbound.code_reference enable row level security;
do $$
begin
  create policy "dashboard read code_reference" on outbound.code_reference for select using (true);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- app_setting — small key/value store for runtime config the dashboard can
-- change (e.g. the selected outbound ElevenLabs voice id). Written by the
-- backend (service role); the env values remain the fallback defaults.
-- ---------------------------------------------------------------------------
create table if not exists outbound.app_setting (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);

-- ===========================================================================
-- API role grants — REQUIRED for PostgREST / supabase-js to reach this schema.
--
-- Two things are needed for the REST API to serve the `outbound` schema:
--   1) These grants (run as part of this SQL), AND
--   2) Adding `outbound` to Supabase -> Project Settings -> API ->
--      "Exposed schemas". Without (2) every query fails with
--      "Invalid schema: outbound" and the dialer fail-closes every number as DNC.
-- ===========================================================================
grant usage on schema outbound to anon, authenticated, service_role;

-- service_role (backend dialer/webhooks) needs full DML; anon/authenticated
-- (dashboard) get read access, gated by the RLS select policies above.
grant all privileges on all tables    in schema outbound to service_role;
grant all privileges on all sequences in schema outbound to service_role;
grant all privileges on all functions in schema outbound to service_role;
grant select on all tables in schema outbound to anon, authenticated;

-- Apply the same defaults to any tables/sequences created later.
alter default privileges in schema outbound
  grant all privileges on tables to service_role;
alter default privileges in schema outbound
  grant all privileges on sequences to service_role;
alter default privileges in schema outbound
  grant select on tables to anon, authenticated;

-- ===========================================================================
-- TRACKING + COMPLIANCE MIGRATION (additive, safe to re-run)
--
-- Adds the columns/tables/views the analytics dashboard reads and that close
-- the audit/resilience gaps in the agent:
--   * per-attempt + per-brand columns on call (so quality/funnel don't need
--     a campaign join, and we can chart attempts-to-qualify)
--   * compliance proof on call: disclosed_at / consent_at / structured_data /
--     success_evaluation (consent_captured + sentiment_score already existed
--     but were never written — the handlers now populate them)
--   * retry backoff (lead.next_attempt_after) so no-answer/voicemail leads
--     aren't re-dialed seconds later
--   * failed_op dead-letter table so DB writes that exhaust retries are
--     visible + recoverable instead of silently dropped
--   * analytics views consumed by /outbound/analytics and by Fabric/Power BI
-- ===========================================================================

-- Per-attempt + per-brand + compliance/quality columns on call.
alter table outbound.call add column if not exists attempt_number    int;
alter table outbound.call add column if not exists brand             text;   -- brand slug that serviced the call (denormalized for fast quality joins)
alter table outbound.call add column if not exists disclosed_at      timestamptz;  -- when the AI/recording disclosure was actually spoken
alter table outbound.call add column if not exists consent_at        timestamptz;  -- when recording consent was captured on this call
alter table outbound.call add column if not exists structured_data   jsonb;  -- Vapi end-of-call structured extraction
alter table outbound.call add column if not exists success_evaluation text;  -- Vapi PassFail success rubric result
create index if not exists outbound_call_campaign_idx on outbound.call (campaign_id);
create index if not exists outbound_call_brand_idx     on outbound.call (brand);

-- Lead-level consent timestamp + retry backoff gate.
alter table outbound.lead add column if not exists consent_recording_at timestamptz;
alter table outbound.lead add column if not exists next_attempt_after    timestamptz;  -- dialer won't retry before this time

-- Per-run call budget: the operator chooses how many calls to place in a run.
-- The worker counts call rows created since run_started_at and auto-pauses the
-- campaign once max_calls_per_run is reached. `null` budget = unlimited (legacy
-- behavior). Every Start resets run_started_at, so each Start is a fresh batch.
alter table outbound.campaign add column if not exists max_calls_per_run int;
alter table outbound.campaign add column if not exists run_started_at    timestamptz;

-- ---------------------------------------------------------------------------
-- failed_op — dead-letter for DB writes that exhausted in-process retries.
-- The webhook handlers + dialer record here instead of silently dropping a
-- lead/call/event write, so failures are queryable + replayable.
-- ---------------------------------------------------------------------------
create table if not exists outbound.failed_op (
  id          bigint generated always as identity primary key,
  kind        text not null,            -- lead.update | call.update | call_event | call.insert
  ref_id      text,                     -- lead id / call id the op targeted
  payload     jsonb,                    -- the patch/row we tried to write
  error       text,                     -- last error message
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists outbound_failed_op_unresolved_idx on outbound.failed_op (resolved, created_at);

alter table outbound.failed_op enable row level security;
do $$
begin
  create policy "dashboard read failed_op" on outbound.failed_op for select using (true);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Analytics views — pre-aggregated so the dashboard (and Fabric/Power BI) read
-- small result sets instead of pulling every lead/call client-side.
-- ---------------------------------------------------------------------------

-- Per-campaign funnel: leads -> contacted -> qualified, with attempt totals.
-- security_invoker: the view runs with the querying user's privileges + RLS, so
-- it can't be used to bypass the authenticated-only policies below.
create or replace view outbound.v_campaign_funnel with (security_invoker = on) as
select
  c.id          as campaign_id,
  c.name,
  c.region,
  c.brand,
  c.status,
  count(l.id)                                                                  as total_leads,
  -- "contacted" = a real dial outcome. Excludes bad_number (junk flagged at
  -- import, never dialed) and calling (in flight) so the funnel isn't inflated.
  count(l.id) filter (where l.disposition not in ('new', 'queued', 'bad_number', 'calling')) as contacted,
  count(l.id) filter (where l.disposition = 'qualified')                       as qualified,
  count(l.id) filter (where l.disposition = 'needs_followup')                  as needs_followup,
  count(l.id) filter (where l.disposition = 'not_interested')                  as not_interested,
  count(l.id) filter (where l.disposition in ('no_answer', 'voicemail'))       as no_contact,
  count(l.id) filter (where l.disposition in ('dnc', 'remove'))                as removed,
  count(l.id) filter (where l.dnc)                                             as dnc_flagged,
  coalesce(sum(l.attempts), 0)                                                 as total_attempts
from outbound.campaign c
left join outbound.lead l on l.campaign_id = c.id
group by c.id, c.name, c.region, c.brand, c.status;

-- Daily call metrics (by campaign), in Pacific time for reporting.
create or replace view outbound.v_daily_metrics with (security_invoker = on) as
select
  (started_at at time zone 'America/Los_Angeles')::date                        as day,
  campaign_id,
  count(*)                                                                     as calls,
  count(*) filter (where disposition = 'qualified')                           as qualified,
  count(*) filter (where transferred_to_human)                                as transferred,
  count(*) filter (where outcome = 'voicemail')                               as voicemail,
  count(*) filter (where outcome = 'no_answer')                               as no_answer,
  count(*) filter (where outcome = 'failed')                                  as failed,
  round(avg(duration_seconds) filter (where duration_seconds is not null), 1) as avg_duration_seconds
from outbound.call
where started_at is not null
group by 1, 2;

-- Call quality (by campaign + brand) is defined ONCE, near the end of this file
-- (it needs the ended_by/cost columns added below). NOTE: it must NOT also be
-- defined here — `create or replace view` cannot change existing column
-- names/positions (42P16), so two differing definitions break the whole run.

-- Attempts-to-outcome distribution: how many dials it takes per lead.
create or replace view outbound.v_attempt_distribution with (security_invoker = on) as
select
  campaign_id,
  attempts,
  count(*)                                          as leads,
  count(*) filter (where disposition = 'qualified') as qualified
from outbound.lead
group by campaign_id, attempts;

-- Per-call compliance audit: was the disclosure spoken + consent captured?
create or replace view outbound.v_compliance_audit with (security_invoker = on) as
select
  c.id            as call_id,
  c.campaign_id,
  c.lead_id,
  c.phone_number,
  c.brand,
  c.started_at,
  c.ended_at,
  c.duration_seconds,
  c.outcome,
  c.disposition,
  c.transferred_to_human,
  c.disclosed_at is not null                                                   as disclosure_logged,
  c.consent_captured,
  c.consent_at,
  exists (select 1 from outbound.call_event e where e.call_id = c.id and e.type = 'disclosure') as disclosure_event,
  exists (select 1 from outbound.call_event e where e.call_id = c.id and e.type = 'consent')    as consent_event
from outbound.call c;

-- (v_call_quality is granted where it is created, near the end of this file.)
grant select on outbound.v_campaign_funnel, outbound.v_daily_metrics,
               outbound.v_attempt_distribution, outbound.v_compliance_audit
  to authenticated, service_role;

-- ===========================================================================
-- SECURITY HARDENING (C2) — dashboard now signs in with Supabase Auth, so lock
-- ALL reads to the `authenticated` role. The browser-shipped anon key can no
-- longer read lead PII, transcripts, recordings, or per-call phone numbers.
-- Service role (backend) bypasses RLS and is unaffected. Safe/idempotent to re-run.
--
-- NOTE: this supersedes the permissive `for select using (true)` policies and the
-- `grant select ... to anon` above (kept earlier in the file for history). When
-- the whole script is run top-to-bottom, this block wins.
-- ===========================================================================

-- 1) Replace each permissive SELECT policy with an authenticated-only one.
do $$
declare t text;
begin
  foreach t in array array['lead','call','call_event','campaign','code_reference','failed_op'] loop
    execute format('drop policy if exists %I on outbound.%I', 'dashboard read ' || t, t);
    execute format('drop policy if exists %I on outbound.%I', t || ' authenticated read', t);
    execute format(
      'create policy %I on outbound.%I for select to authenticated using (true)',
      t || ' authenticated read', t);
  end loop;
end $$;

-- 2) Revoke anon's table + view read grants (existing objects + future defaults).
revoke select on all tables in schema outbound from anon;
alter default privileges in schema outbound revoke select on tables from anon;
-- (v_call_quality is revoked where it is created, near the end of this file.)
revoke select on outbound.v_campaign_funnel, outbound.v_daily_metrics,
               outbound.v_attempt_distribution, outbound.v_compliance_audit
  from anon;

-- ===========================================================================
-- CALL-QUALITY + CONTINUOUS-IMPROVEMENT MIGRATION (additive, safe to re-run)
--   * call.ended_by      — who ended the call (customer | agent | operator | system)
--   * campaign_insight   — per-campaign AI analysis: a human-readable improvement
--                          report + a paste-ready improved system prompt, with a
--                          suggest→approve→apply workflow and a compliance guardrail
-- ===========================================================================

alter table outbound.call add column if not exists ended_by text;  -- customer | agent | operator | system

create table if not exists outbound.campaign_insight (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid references outbound.campaign (id) on delete cascade,
  brand            text,
  created_at       timestamptz not null default now(),
  calls_analyzed   int not null default 0,
  window_from      timestamptz,
  window_to        timestamptz,
  report           text,          -- detailed, human-readable improvement suggestions
  suggested_prompt text,          -- ready-to-paste improved system prompt (self-learning proposal)
  guardrail_passed boolean,       -- did the suggested prompt keep the required disclosures?
  guardrail_notes  text,
  status           text not null default 'proposed',  -- proposed | approved | applied | rejected
  approved_by      text,
  approved_at      timestamptz,
  applied_at       timestamptz,
  model            text,
  raw              jsonb
);
create index if not exists outbound_campaign_insight_idx on outbound.campaign_insight (campaign_id, created_at desc);

-- Same auth posture as the rest: authenticated reads only; service role (backend) writes.
alter table outbound.campaign_insight enable row level security;
do $$
begin
  create policy "campaign_insight authenticated read" on outbound.campaign_insight for select to authenticated using (true);
exception when duplicate_object then null; end $$;
grant select on outbound.campaign_insight to authenticated, service_role;
grant all privileges on outbound.campaign_insight to service_role;

-- ===========================================================================
-- TELEPHONY + COST MIGRATION (additive, safe to re-run)
-- Twilio is now the carrier. Vapi reports its own platform cost (LLM/STT/TTS);
-- the authoritative telephony cost + carrier status + answered-by come from the
-- Twilio API (reconciled by src/outbound/twilioSync.ts via provider_call_id).
-- ===========================================================================
alter table outbound.call add column if not exists vapi_cost        numeric;  -- Vapi platform cost
alter table outbound.call add column if not exists telephony_cost   numeric;  -- Twilio per-call price (USD)
alter table outbound.call add column if not exists provider_call_id text;      -- Twilio Call SID (Vapi phoneCallProviderId)
alter table outbound.call add column if not exists provider_status  text;      -- Twilio status: completed|busy|no-answer|failed|canceled
alter table outbound.call add column if not exists answered_by      text;      -- Twilio AMD: human | machine_* | unknown
create index if not exists outbound_call_provider_idx on outbound.call (provider_call_id);

-- v_call_quality with connect/who-ended breakdown + cost. Placed AFTER the
-- columns above exist. Dropped first because an older deployed shape has
-- different column positions and create-or-replace can't rename them (42P16);
-- dropping a view loses no data and the grant is re-applied just below.
drop view if exists outbound.v_call_quality;
create view outbound.v_call_quality with (security_invoker = on) as
select
  campaign_id,
  brand,
  count(*)                                                                     as calls,
  count(*) filter (where status = 'ended')                                    as completed,
  -- connected = a real conversation happened (a person/agent ended it, or transfer)
  count(*) filter (where ended_by in ('customer', 'agent') or transferred_to_human) as connected,
  round(avg(duration_seconds) filter (where duration_seconds is not null), 1) as avg_duration_seconds,
  round(avg(duration_seconds) filter (where ended_by in ('customer', 'agent') or transferred_to_human), 1) as avg_talk_seconds,
  round(avg(sentiment_score) filter (where sentiment_score is not null), 3)   as avg_sentiment,
  count(*) filter (where transferred_to_human)                                as transferred,
  count(*) filter (where outcome = 'voicemail')                               as voicemail,
  count(*) filter (where outcome = 'no_answer')                               as no_answer,
  count(*) filter (where outcome = 'failed')                                  as failed,
  count(*) filter (where ended_reason = 'stale-timeout')                      as stale,
  count(*) filter (where ended_by = 'customer')                               as ended_customer,
  count(*) filter (where ended_by = 'agent')                                  as ended_agent,
  count(*) filter (where ended_by = 'operator')                               as ended_operator,
  count(*) filter (where ended_by = 'system')                                 as ended_system,
  round(sum(coalesce(vapi_cost, 0))::numeric, 4)                              as vapi_cost,
  round(sum(coalesce(telephony_cost, 0))::numeric, 4)                         as telephony_cost,
  round(sum(coalesce(vapi_cost, 0) + coalesce(telephony_cost, 0))::numeric, 4) as total_cost
from outbound.call
group by campaign_id, brand;

grant select on outbound.v_call_quality to authenticated, service_role;
revoke select on outbound.v_call_quality from anon;

-- Connect/qualify rate by hour-of-day (Pacific) — surfaces the best hours to
-- dial so retry timing + campaign windows can be tuned to when people answer.
create or replace view outbound.v_call_hourly with (security_invoker = on) as
select
  campaign_id,
  extract(hour from (started_at at time zone 'America/Los_Angeles'))::int      as hour_pt,
  count(*)                                                                     as calls,
  count(*) filter (where ended_by in ('customer', 'agent') or transferred_to_human) as connected,
  count(*) filter (where disposition = 'qualified')                           as qualified,
  count(*) filter (where disposition in ('voicemail', 'ivr'))                 as reached_machine
from outbound.call
where started_at is not null
group by campaign_id, hour_pt;

grant select on outbound.v_call_hourly to authenticated, service_role;
revoke select on outbound.v_call_hourly from anon;
