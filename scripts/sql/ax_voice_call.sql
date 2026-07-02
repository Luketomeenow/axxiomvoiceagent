-- ax_voice_call — one row per voice call.
-- Run in the Supabase SQL editor (same project as axxiommarketinghub).
-- A Fabric PySpark notebook mirrors this table into the lakehouse for Power BI,
-- matching the ax_VoiceCall design in the architecture doc.

create table if not exists public.ax_voice_call (
  id                   uuid primary key default gen_random_uuid(),
  call_id              text unique not null,
  contact_id           text,
  campaign_type        text not null default 'inbound',   -- cold | warm | inbound
  call_type            text,                              -- new_lead | existing_customer | other
  caller_number        text,
  outcome              text,                              -- booked_survey | transferred | completed
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
  campaign_id          text,                              -- links to marketing attribution
  raw                  jsonb,
  created_at           timestamptz not null default now()
);

create index if not exists ax_voice_call_contact_idx     on public.ax_voice_call (contact_id);
create index if not exists ax_voice_call_created_idx      on public.ax_voice_call (created_at);
create index if not exists ax_voice_call_campaign_idx     on public.ax_voice_call (campaign_type);

-- ---------------------------------------------------------------------------
-- Security: this table holds full inbound transcripts, recording URLs, caller
-- numbers, and raw webhook payloads. Enable RLS with NO anon/authenticated
-- policy, so it's reachable ONLY by the service role (the backend writer + the
-- Fabric mirror) — never via the public anon key exposed to browsers. The
-- service role bypasses RLS, so the app keeps working. Safe/idempotent to re-run.
-- ---------------------------------------------------------------------------
alter table public.ax_voice_call enable row level security;
revoke select on public.ax_voice_call from anon, authenticated;
