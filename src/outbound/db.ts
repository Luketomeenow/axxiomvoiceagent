/**
 * Supabase access scoped to the `outbound` schema (separate from the inbound
 * `public.ax_voice_call` flow). Used by the dialer, webhook handlers, and the
 * Hono API routes. The Next.js dashboard talks to Supabase directly with the
 * anon key + Realtime; this client uses the service role for writes.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assertSupabase, env } from "../config/env.ts";
import { log } from "../lib/logger.ts";

let client: SupabaseClient | undefined;

/** Service-role client whose default schema is `outbound`. */
export function db(): SupabaseClient {
  assertSupabase();
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false },
      db: { schema: env.outboundSchema },
    }) as unknown as SupabaseClient;
  }
  return client;
}

// --- Domain types ----------------------------------------------------------

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

export interface LeadRow {
  id: string;
  campaign_id: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  owner_phone: string | null;
  dial_phone: string | null;
  building_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  region: string | null;
  oem_match: string | null;
  problem_type: string | null;
  violation_codes: string | null;
  violation_count: number | null;
  violation_details: string | null;
  last_inspection_date: string | null;
  cert_expiry_date: string | null;
  lead_score: number | null;
  lead_tier: string | null;
  disposition: Disposition;
  attempts: number;
  consent_recording: boolean | null;
  dnc: boolean;
  notes: string | null;
  // Structured, sales-ready qualification fields (captured by the agent tools).
  decision_maker: boolean | null;
  current_provider: string | null;
  timeline: string | null;
  callback_name: string | null;
  callback_phone: string | null;
  callback_email: string | null;
  qualified_at: string | null;
}

export interface CallRow {
  id: string;
  lead_id: string | null;
  campaign_id: string | null;
  vapi_call_id: string | null;
  phone_number: string | null;
  status: string;
  outcome: string | null;
  disposition: string | null;
  consent_captured: boolean | null;
  transferred_to_human: boolean | null;
  duration_seconds: number | null;
  ended_reason: string | null;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  raw: unknown;
  started_at: string | null;
  ended_at: string | null;
}

// --- Helpers ---------------------------------------------------------------

/** True if a number is on the suppression list. Fails closed (suppress) on error. */
export async function isSuppressed(phone: string): Promise<boolean> {
  if (!phone) return true;
  const { data, error } = await db().from("dnc_suppression").select("phone").eq("phone", phone).maybeSingle();
  if (error) {
    log.warn("DNC lookup failed — suppressing to be safe", { phone, error: error.message });
    return true;
  }
  return !!data;
}

/** Add a number to the suppression list and mark its lead as DNC. */
export async function suppressNumber(phone: string, reason: string, source = "caller_request"): Promise<void> {
  if (!phone) return;
  await db().from("dnc_suppression").upsert({ phone, reason, source }, { onConflict: "phone" });
  await db().from("lead").update({ dnc: true, disposition: "dnc" }).eq("dial_phone", phone);
}

/** Append a live/audit event for a call. Never throws into the caller. */
export async function recordEvent(event: {
  call_id?: string | null;
  vapi_call_id?: string | null;
  type: string;
  role?: string | null;
  text?: string | null;
  payload?: unknown;
}): Promise<void> {
  try {
    await db().from("call_event").insert({
      call_id: event.call_id ?? null,
      vapi_call_id: event.vapi_call_id ?? null,
      type: event.type,
      role: event.role ?? null,
      text: event.text ?? null,
      payload: event.payload ?? null,
    });
  } catch (err) {
    log.warn("recordEvent failed", { err: String(err) });
  }
}
