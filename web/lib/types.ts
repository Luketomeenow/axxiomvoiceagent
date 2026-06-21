export type Disposition =
  | "new"
  | "queued"
  | "calling"
  | "qualified"
  | "needs_followup"
  | "remove"
  | "no_answer"
  | "voicemail"
  | "bad_number"
  | "not_interested"
  | "dnc";

export interface Lead {
  id: string;
  campaign_id: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  dial_phone: string | null;
  building_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  region: string | null;
  oem_match: string | null;
  problem_type: string | null;
  violation_codes: string | null;
  violation_count: number | null;
  cert_expiry_date: string | null;
  lead_score: number | null;
  lead_tier: string | null;
  disposition: Disposition;
  attempts: number;
  dnc: boolean;
  notes: string | null;
  // Sales-ready qualification fields captured on the call.
  decision_maker: boolean | null;
  current_provider: string | null;
  timeline: string | null;
  callback_name: string | null;
  callback_phone: string | null;
  callback_email: string | null;
  qualified_at: string | null;
}

export interface Call {
  id: string;
  lead_id: string | null;
  vapi_call_id: string | null;
  phone_number: string | null;
  status: string;
  outcome: string | null;
  disposition: string | null;
  summary: string | null;
  duration_seconds: number | null;
  recording_url: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface CallEvent {
  id: number;
  call_id: string | null;
  vapi_call_id: string | null;
  type: string;
  role: string | null;
  text: string | null;
  at: string;
}

export interface Campaign {
  id: string;
  name: string;
  region: string | null;
  status: "draft" | "running" | "paused" | "done";
  timezone: string;
  call_window_start: number;
  call_window_end: number;
  max_concurrent: number;
  max_attempts: number;
}
