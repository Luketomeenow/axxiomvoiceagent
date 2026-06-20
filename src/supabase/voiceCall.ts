/**
 * Writes one row per call to the `ax_voice_call` table in Supabase.
 * A Fabric PySpark notebook mirrors this table into the lakehouse for Power BI,
 * matching the pattern in axxiommarketinghub/fabric/notebooks.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assertSupabase, env } from "../config/env.ts";
import { log } from "../lib/logger.ts";

export interface VoiceCallRecord {
  call_id: string;
  contact_id?: string | null;
  campaign_type?: string; // cold | warm | inbound
  call_type?: string | null; // new_lead | existing_customer | other
  caller_number?: string | null;
  outcome?: string | null;
  ended_reason?: string | null;
  duration_seconds?: number | null;
  booked_appointment?: boolean;
  appointment_time?: string | null;
  transferred_to_human?: boolean;
  transcript?: string | null;
  summary?: string | null;
  sentiment_score?: number | null;
  objections?: string[] | null;
  next_best_action?: string | null;
  recording_url?: string | null;
  raw?: unknown;
}

let client: SupabaseClient | undefined;

function getClient(): SupabaseClient {
  assertSupabase();
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/** Upsert a call record (idempotent on call_id). Never throws into the webhook. */
export async function insertVoiceCall(record: VoiceCallRecord): Promise<void> {
  try {
    const row = { campaign_type: "inbound", ...record };
    const { error } = await getClient().from(env.voiceCallTable).upsert(row, { onConflict: "call_id" });
    if (error) {
      log.error("Supabase insert failed", { callId: record.call_id, error: error.message });
    } else {
      log.info("Logged call to Supabase", { callId: record.call_id });
    }
  } catch (err) {
    log.error("Supabase insert threw", { callId: record.call_id, err: String(err) });
  }
}
