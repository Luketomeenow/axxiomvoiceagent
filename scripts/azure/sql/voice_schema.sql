-- =============================================================================
-- Axxiom voice agents — schema for Azure Database for PostgreSQL.
--
-- Target: psql-axxiom-marketing / axxiom_hub (the marketing hub's server and
-- database — the hub's Voice page, report emails and agent service read these
-- tables, so they keep the exact names they had on Supabase):
--   outbound.*            outbound qualification campaign (+ analytics views)
--   outbound.dashboard_user  dashboard logins (replaces Supabase Auth)
--   public.ax_voice_call  inbound call log
--
-- This is the consolidated FINAL state of scripts/sql/outbound_schema.sql +
-- scripts/sql/ax_voice_call.sql, minus everything Supabase-specific: no
-- anon/authenticated/service_role roles, no RLS policies, no Realtime
-- publication. On Azure only this service connects to the database (the
-- dashboard reads through the API), so access is plain GRANTs to the app's
-- managed-identity role. Safe to re-run: everything is if-not-exists / or-replace.
--
-- Run in Azure Cloud Shell as your Entra login (Cloud Shell has no repo
-- checkout: upload this file with the Upload button, or paste it):
--   export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
--   psql "host=psql-axxiom-marketing.postgres.database.azure.com dbname=axxiom_hub user=luke.fernandez@axxiomelevator.com sslmode=require" \
--        -v ON_ERROR_STOP=1 -f voice_schema.sql
--
-- Gotchas (from the hub's migrations):
--   * Your login defaults to role dataservices@… — the `set role` below makes
--     YOU the owner of what this creates. Edit it if you are not Luke.
--   * `create schema` needs CREATE on axxiom_hub. If it fails with
--     "permission denied for database", Zach runs:
--       grant create on database axxiom_hub to "luke.fernandez@axxiomelevator.com";
--   * If public.ax_voice_call already exists and someone else owns it, the
--     grant on it is skipped with a WARNING. It never held real voice data on
--     Azure (the hub's cutover excluded it), so its owner drops it and you re-run.
-- =============================================================================

set role "luke.fernandez@axxiomelevator.com";

-- ---- Settings: the roles that get access (edit to match what Zach created) ---
-- app_role    = the voice app's managed identity (reads + writes everything here)
-- reader_role = read-only consumer (the marketing hub's identity); '' = none.
--               Never gets dashboard_user (password hashes).
select set_config('voice.app_role',    'umi-axxiom-voice',        false);
select set_config('voice.reader_role', 'umi-marketing-functions', false);

create schema if not exists outbound;

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
  updated_at         timestamptz not null default now(),
  region             text,
  brand              text,                            -- brand slug → per-brand agent + caller ID
  max_calls_per_run  int,                             -- null = unlimited
  run_started_at     timestamptz                      -- each Start = a fresh batch
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
    -- | no_answer | voicemail | ivr | bad_number | not_interested | dnc
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

  region             text,
  -- Structured, sales-ready qualification fields (qualifyLead / recordDisposition).
  decision_maker     boolean,
  current_provider   text,
  timeline           text,
  callback_name      text,
  callback_phone     text,
  callback_email     text,
  qualified_at       timestamptz,
  consent_recording_at timestamptz,
  next_attempt_after timestamptz,     -- dialer won't retry before this time

  unique (device_id, contact_phone)
);

create index if not exists outbound_lead_disposition_idx on outbound.lead (disposition);
create index if not exists outbound_lead_campaign_idx    on outbound.lead (campaign_id);
create index if not exists outbound_lead_phone_idx       on outbound.lead (dial_phone);
create index if not exists outbound_lead_region_idx      on outbound.lead (region);

-- ---------------------------------------------------------------------------
-- call — one row per dial attempt.
-- ---------------------------------------------------------------------------
create table if not exists outbound.call (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid references outbound.lead (id) on delete cascade,
  campaign_id        uuid references outbound.campaign (id) on delete set null,
  vapi_call_id       text unique,
  phone_number       text,
  status             text not null default 'queued',  -- queued | ringing | in-progress | ended
  outcome            text,
  disposition        text,
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
  created_at         timestamptz not null default now(),
  control_url        text,            -- Vapi live-call control URL ("End call")
  attempt_number     int,
  brand              text,            -- brand slug that serviced the call
  disclosed_at       timestamptz,     -- AI/recording disclosure spoken
  consent_at         timestamptz,     -- recording consent captured
  structured_data    jsonb,
  success_evaluation text,
  ended_by           text,            -- customer | agent | operator | system
  vapi_cost          numeric,         -- Vapi platform cost
  telephony_cost     numeric,         -- Twilio per-call price (USD)
  provider_call_id   text,            -- Twilio Call SID
  provider_status    text,            -- completed | busy | no-answer | failed | canceled
  answered_by        text             -- Twilio AMD: human | machine_* | unknown
);

create index if not exists outbound_call_lead_idx     on outbound.call (lead_id);
create index if not exists outbound_call_status_idx   on outbound.call (status);
create index if not exists outbound_call_created_idx  on outbound.call (created_at);
create index if not exists outbound_call_campaign_idx on outbound.call (campaign_id);
create index if not exists outbound_call_brand_idx    on outbound.call (brand);
create index if not exists outbound_call_provider_idx on outbound.call (provider_call_id);

-- ---------------------------------------------------------------------------
-- call_event — append-only live feed + compliance audit.
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
create index if not exists outbound_call_event_at_idx   on outbound.call_event (at);

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
-- code_reference — curated inspection / violation codes (lookupViolationCode).
-- ---------------------------------------------------------------------------
create table if not exists outbound.code_reference (
  code           text primary key,
  jurisdiction   text,
  title          text,
  plain_summary  text,
  severity       text,                  -- informational | minor | major | critical
  typical_remedy text,
  source_url     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- app_setting — runtime config the dashboard can change (voices, brand
-- assistant ids, approved prompt overrides).
-- ---------------------------------------------------------------------------
create table if not exists outbound.app_setting (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- failed_op — dead-letter for writes that exhausted in-process retries.
-- ---------------------------------------------------------------------------
create table if not exists outbound.failed_op (
  id          bigint generated always as identity primary key,
  kind        text not null,            -- lead.update | call.update | call_event | dnc_suppression
  ref_id      text,
  payload     jsonb,
  error       text,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists outbound_failed_op_unresolved_idx on outbound.failed_op (resolved, created_at);

-- ---------------------------------------------------------------------------
-- campaign_insight — AI analysis (brand_prompt | system), human-gated apply.
-- ---------------------------------------------------------------------------
create table if not exists outbound.campaign_insight (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid references outbound.campaign (id) on delete cascade,
  brand            text,
  created_at       timestamptz not null default now(),
  calls_analyzed   int not null default 0,
  window_from      timestamptz,
  window_to        timestamptz,
  report           text,
  suggested_prompt text,
  guardrail_passed boolean,
  guardrail_notes  text,
  status           text not null default 'proposed',  -- proposed | approved | applied | rejected
  approved_by      text,
  approved_at      timestamptz,
  applied_at       timestamptz,
  model            text,
  raw              jsonb,
  kind             text not null default 'brand_prompt'
);
create index if not exists outbound_campaign_insight_idx      on outbound.campaign_insight (campaign_id, created_at desc);
create index if not exists outbound_campaign_insight_kind_idx on outbound.campaign_insight (kind, created_at desc);

-- ---------------------------------------------------------------------------
-- dashboard_user — operator logins (replaces Supabase Auth). Invite-only:
-- rows are created with `bun run dashboard-user add <email> --sql` and pasted
-- here in Cloud Shell. password_hash is scrypt (src/lib/passwords.ts).
-- ---------------------------------------------------------------------------
create table if not exists outbound.dashboard_user (
  id               uuid primary key default gen_random_uuid(),
  email            text not null unique check (email = lower(email)),
  name             text,
  password_hash    text not null,
  role             text not null default 'operator',   -- operator | admin
  disabled         boolean not null default false,
  session_version  int  not null default 1,            -- bump to sign out every session
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_login_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- public.ax_voice_call — inbound call log (one row per call).
-- ---------------------------------------------------------------------------
create table if not exists public.ax_voice_call (
  id                   uuid primary key default gen_random_uuid(),
  call_id              text unique not null,
  contact_id           text,
  campaign_type        text not null default 'inbound',   -- cold | warm | inbound
  call_type            text,                              -- new_lead | existing_customer | other
  caller_number        text,
  outcome              text,
  ended_reason         text,
  duration_seconds     numeric,
  booked_appointment   boolean default false,
  appointment_time     timestamptz,
  transferred_to_human boolean default false,
  transcript           text,
  summary              text,
  sentiment_score      numeric,                           -- -1 .. 1
  objections           text[],
  next_best_action     text,
  recording_url        text,
  lead_score_change    numeric,
  campaign_id          text,
  raw                  jsonb,
  created_at           timestamptz not null default now()
);
create index if not exists ax_voice_call_contact_idx  on public.ax_voice_call (contact_id);
create index if not exists ax_voice_call_created_idx  on public.ax_voice_call (created_at);
create index if not exists ax_voice_call_campaign_idx on public.ax_voice_call (campaign_type);

-- ===========================================================================
-- Analytics views — identical to the Supabase definitions (the dashboard, the
-- marketing hub and Fabric/Power BI read them).
-- ===========================================================================

create or replace view outbound.v_campaign_funnel with (security_invoker = on) as
select
  c.id          as campaign_id,
  c.name,
  c.region,
  c.brand,
  c.status,
  count(l.id)                                                                  as total_leads,
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

create or replace view outbound.v_attempt_distribution with (security_invoker = on) as
select
  campaign_id,
  attempts,
  count(*)                                          as leads,
  count(*) filter (where disposition = 'qualified') as qualified
from outbound.lead
group by campaign_id, attempts;

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

create or replace view outbound.v_call_quality with (security_invoker = on) as
select
  campaign_id,
  brand,
  count(*)                                                                     as calls,
  count(*) filter (where status = 'ended')                                    as completed,
  count(*) filter (where (ended_by in ('customer', 'agent') or transferred_to_human)
                     and coalesce(outcome, '') not in ('voicemail', 'ivr'))    as connected,
  round(avg(duration_seconds) filter (where duration_seconds is not null), 1) as avg_duration_seconds,
  round(avg(duration_seconds) filter (where (ended_by in ('customer', 'agent') or transferred_to_human)
                                        and coalesce(outcome, '') not in ('voicemail', 'ivr')), 1) as avg_talk_seconds,
  round(avg(sentiment_score) filter (where sentiment_score is not null), 3)   as avg_sentiment,
  count(*) filter (where transferred_to_human)                                as transferred,
  count(*) filter (where outcome = 'voicemail')                               as voicemail,
  count(*) filter (where outcome = 'no_answer')                               as no_answer,
  count(*) filter (where outcome = 'ivr')                                     as ivr,
  count(*) filter (where outcome = 'failed')                                  as failed,
  count(*) filter (where ended_reason = 'stale-timeout')                      as stale,
  count(*) filter (where ended_by = 'customer')                               as ended_customer,
  count(*) filter (where ended_by = 'agent')                                  as ended_agent,
  count(*) filter (where ended_by = 'operator')                               as ended_operator,
  count(*) filter (where ended_by = 'system')                                 as ended_system,
  count(*) filter (where answered_by = 'human')                               as answered_human,
  count(*) filter (where answered_by like 'machine%')                         as answered_machine,
  count(*) filter (where answered_by = 'fax')                                 as answered_fax,
  count(*) filter (where provider_status = 'completed')                       as status_completed,
  count(*) filter (where provider_status = 'busy')                            as status_busy,
  count(*) filter (where provider_status = 'no-answer')                       as status_no_answer,
  count(*) filter (where provider_status = 'failed')                          as status_failed,
  count(*) filter (where provider_status = 'canceled')                        as status_canceled,
  round(sum(coalesce(vapi_cost, 0))::numeric, 4)                              as vapi_cost,
  round(sum(coalesce(telephony_cost, 0))::numeric, 4)                         as telephony_cost,
  round(sum(coalesce(vapi_cost, 0) + coalesce(telephony_cost, 0))::numeric, 4) as total_cost
from outbound.call
group by campaign_id, brand;

create or replace view outbound.v_call_hourly with (security_invoker = on) as
select
  campaign_id,
  extract(hour from (started_at at time zone 'America/Los_Angeles'))::int      as hour_pt,
  count(*)                                                                     as calls,
  count(*) filter (where (ended_by in ('customer', 'agent') or transferred_to_human)
                     and coalesce(outcome, '') not in ('voicemail', 'ivr'))    as connected,
  count(*) filter (where disposition = 'qualified')                           as qualified,
  count(*) filter (where disposition in ('voicemail', 'ivr'))                 as reached_machine
from outbound.call
where started_at is not null
group by campaign_id, hour_pt;

create or replace view outbound.v_lead_disposition_counts with (security_invoker = on) as
select campaign_id, disposition, count(*)::int as leads
from outbound.lead
group by campaign_id, disposition;

create or replace view outbound.v_lead_brand_counts with (security_invoker = on) as
select campaign_id, servicing_brand, count(*)::int as leads
from outbound.lead
where servicing_brand is not null and servicing_brand <> ''
group by campaign_id, servicing_brand;

create or replace view outbound.v_campaign_live with (security_invoker = on) as
select
  c.id as campaign_id,
  (select count(*)::int from outbound.call k
    where k.campaign_id = c.id and c.run_started_at is not null
      and k.created_at >= c.run_started_at)                          as dialed_this_run,
  (select count(*)::int from outbound.call k
    where k.campaign_id = c.id
      and k.status in ('queued', 'ringing', 'in-progress'))          as active_calls,
  (select count(*)::int from outbound.lead l
    where l.campaign_id = c.id and l.disposition = 'qualified')      as qualified
from outbound.campaign c
where c.status = 'running';

-- ===========================================================================
-- Grants. Each one is attempted separately so a missing role or a table owned
-- by someone else skips with a WARNING instead of aborting the whole file.
-- ===========================================================================
do $$
declare
  app    text := nullif(current_setting('voice.app_role', true), '');
  reader text := nullif(current_setting('voice.reader_role', true), '');
  stmt   text;
begin
  if app is not null and not exists (select 1 from pg_roles where rolname = app) then
    raise warning 'app role "%" does not exist yet — Zach creates it (pgaadauth_create_principal), then re-run this file', app;
    app := null;
  end if;
  if reader is not null and not exists (select 1 from pg_roles where rolname = reader) then
    raise warning 'reader role "%" does not exist — skipping read grants', reader;
    reader := null;
  end if;

  if app is not null then
    foreach stmt in array array[
      format('grant usage on schema outbound to %I', app),
      format('grant select, insert, update, delete on all tables in schema outbound to %I', app),
      format('grant usage, select, update on all sequences in schema outbound to %I', app),
      format('alter default privileges in schema outbound grant select, insert, update, delete on tables to %I', app),
      format('alter default privileges in schema outbound grant usage, select, update on sequences to %I', app),
      format('grant select, insert, update, delete on public.ax_voice_call to %I', app)
    ] loop
      begin
        execute stmt;
      exception when insufficient_privilege then
        raise warning 'skipped (not owner — ask the owner to run it): %', stmt;
      end;
    end loop;
  end if;

  if reader is not null then
    foreach stmt in array array[
      format('grant usage on schema outbound to %I', reader),
      format('grant select on all tables in schema outbound to %I', reader),
      format('revoke all on outbound.dashboard_user from %I', reader),
      format('grant select on public.ax_voice_call to %I', reader)
    ] loop
      begin
        execute stmt;
      exception when insufficient_privilege then
        raise warning 'skipped (not owner — ask the owner to run it): %', stmt;
      end;
    end loop;
  end if;
end $$;

-- Quick check: every table this service needs, and who owns it.
select n.nspname as schema, c.relname as name, case c.relkind when 'v' then 'view' else 'table' end as kind,
       pg_get_userbyid(c.relowner) as owner
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'outbound' and c.relkind in ('r', 'v')) or (n.nspname = 'public' and c.relname = 'ax_voice_call')
order by 1, 3, 2;
