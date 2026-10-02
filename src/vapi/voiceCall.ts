/**
 * Writes one row per inbound call to `public.ax_voice_call` — in axxiom_hub on
 * Azure Postgres, next to the marketing hub's tables (its Voice page and the
 * agent service read it), and mirrored to Fabric for Power BI.
 */

import { env } from "../config/env.ts";
import { dataClient } from "../lib/dataClient.ts";
import { scopedLog } from "../lib/logger.ts";

const log = scopedLog("inbound-call");

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

/**
 * Upsert a call record (idempotent on call_id). Never throws into the webhook.
 * Retries transient failures so a single blip doesn't silently drop the inbound
 * call log (the webhook returns 200, so Vapi won't redeliver on its own).
 */
export async function insertVoiceCall(record: VoiceCallRecord): Promise<void> {
  const row = { campaign_type: "inbound", ...record };
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const { error } = await dataClient("public").from(env.voiceCallTable).upsert(row, { onConflict: "call_id" });
      if (!error) {
        log.info("Logged inbound call", { callId: record.call_id, ...(attempt ? { attempt } : {}) });
        return;
      }
      log.warn("Inbound call-log write failed", { callId: record.call_id, attempt: attempt + 1, error: error.message });
    } catch (err) {
      log.warn("Inbound call-log write threw", { callId: record.call_id, attempt: attempt + 1, err: String(err) });
    }
  }
  log.error("Inbound call-log write exhausted retries — call log lost", { callId: record.call_id });
}
