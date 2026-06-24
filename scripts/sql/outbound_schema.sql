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
