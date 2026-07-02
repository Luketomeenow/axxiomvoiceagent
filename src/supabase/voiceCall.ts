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

/**
 * Upsert a call record (idempotent on call_id). Never throws into the webhook.
 * Retries transient failures so a single blip doesn't silently drop the inbound
 * call log (the webhook returns 200, so Vapi won't redeliver on its own).
 */
export async function insertVoiceCall(record: VoiceCallRecord): Promise<void> {
  const row = { campaign_type: "inbound", ...record };
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const { error } = await getClient().from(env.voiceCallTable).upsert(row, { onConflict: "call_id" });
      if (!error) {
        log.info("Logged call to Supabase", { callId: record.call_id, ...(attempt ? { attempt } : {}) });
        return;
      }
      log.warn("Supabase insert failed", { callId: record.call_id, attempt: attempt + 1, error: error.message });
    } catch (err) {
      log.warn("Supabase insert threw", { callId: record.call_id, attempt: attempt + 1, err: String(err) });
    }
  }
  log.error("Supabase insert exhausted retries — inbound call log lost", { callId: record.call_id });
}
