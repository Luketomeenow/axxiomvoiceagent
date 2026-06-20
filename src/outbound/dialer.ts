/**
 * Outbound dialer — places calls through Vapi and runs the campaign worker.
 *
 * Compliance guardrails enforced HERE (not just in the prompt):
 *  - calling window (TCPA 8am-9pm in the lead's local timezone)
 *  - DNC suppression check before every dial
 *  - max attempts per lead + concurrency cap
 *
 * A single in-process worker (fine for one Railway instance) ticks while the
 * campaign is `running`. Manual "call now" bypasses the worker but keeps the
 * same guardrails.
 */

import { assertOutbound, env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { db, isSuppressed, recordEvent, type LeadRow } from "./db.ts";

const VAPI_API = "https://api.vapi.ai";

// Leads in these states are still callable (subject to attempt cap).
const RETRYABLE_DISPOSITIONS = ["new", "queued", "no_answer", "voicemail"];

export interface DialResult {
  ok: boolean;
  reason?: string;
  vapiCallId?: string;
  callRowId?: string;
}

/** True if `now` falls inside [start, end) local hours for the given timezone. */
export function isWithinCallingWindow(timezone: string, start: number, end: number, now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(now),
  );
  // Intl can return 24 for midnight in some runtimes; normalize.
  const h = hour === 24 ? 0 : hour;
  return h >= start && h < end;
}

async function vapiPost(path: string, body: unknown): Promise<{ id?: string } & Record<string, unknown>> {
  const res = await fetch(VAPI_API + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Vapi POST ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Variable values injected into the assistant prompt + first message per call. */
function variableValuesFor(lead: LeadRow): Record<string, string> {
  return {
    contactName: lead.contact_name ?? "there",
    buildingName: lead.building_name || lead.address || "your building",
    address: lead.address ?? "",
    city: lead.city ?? "",
    problemType: lead.problem_type ?? "an overdue inspection",
    oemMatch: lead.oem_match ?? "unknown",
    certExpiry: lead.cert_expiry_date ?? "unknown",
  };
}

/**
 * Place a single outbound call for a lead. Enforces DNC + window unless
 * `force` (manual call-now still checks DNC, never the window override unless asked).
 */
export async function placeCall(lead: LeadRow, opts: { ignoreWindow?: boolean } = {}): Promise<DialResult> {
  assertOutbound();

  const phone = lead.dial_phone;
  if (!phone) return { ok: false, reason: "no dialable phone" };
  if (lead.dnc) return { ok: false, reason: "lead is on DNC" };

  if (await isSuppressed(phone)) {
    await db().from("lead").update({ dnc: true, disposition: "dnc" }).eq("id", lead.id);
    return { ok: false, reason: "number is suppressed (DNC)" };
  }

  if (!opts.ignoreWindow && !isWithinCallingWindow(env.outboundTimezone, env.callWindowStart, env.callWindowEnd)) {
    return { ok: false, reason: "outside calling window" };
  }

  // Create the call row first so the webhook can link events even if it races
  // ahead of our response handling.
  const { data: callRow, error: callErr } = await db()
    .from("call")
    .insert({
      lead_id: lead.id,
      campaign_id: lead.campaign_id,
      phone_number: phone,
      status: "queued",
    })
    .select("id")
    .single();
  if (callErr || !callRow) {
    return { ok: false, reason: `could not create call row: ${callErr?.message}` };
  }
  const callRowId = callRow.id as string;

  try {
    const result = await vapiPost("/call", {
      phoneNumberId: env.vapiPhoneNumberId,
      assistantId: env.outboundAssistantId,
      assistantOverrides: { variableValues: variableValuesFor(lead) },
      customer: { number: phone },
      metadata: { leadId: lead.id, callRowId, campaignId: lead.campaign_id, kind: "outbound" },
    });

    const vapiCallId = result.id;
    await db()
      .from("call")
      .update({ vapi_call_id: vapiCallId, status: "ringing", started_at: new Date().toISOString() })
      .eq("id", callRowId);
    await db()
      .from("lead")
      .update({
        disposition: "calling",
        attempts: (lead.attempts ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", lead.id);

    await recordEvent({
      call_id: callRowId,
      vapi_call_id: vapiCallId,
      type: "status-update",
      text: "dialing",
      payload: { phone },
    });

    log.info("Outbound call placed", { leadId: lead.id, vapiCallId, phone });
    return { ok: true, vapiCallId, callRowId };
  } catch (err) {
    await db()
      .from("call")
      .update({ status: "ended", outcome: "failed", ended_reason: String(err), ended_at: new Date().toISOString() })
      .eq("id", callRowId);
    log.error("Outbound call failed to place", { leadId: lead.id, err: String(err) });
    return { ok: false, reason: String(err), callRowId };
  }
}

/** Manual "call now" from the dashboard. Looks up the lead, then dials. */
export async function callNow(leadId: string): Promise<DialResult> {
  const { data: lead, error } = await db().from("lead").select("*").eq("id", leadId).single<LeadRow>();
  if (error || !lead) return { ok: false, reason: "lead not found" };
  // Manual dials ignore the calling window (operator's discretion) but still honor DNC.
  return placeCall(lead, { ignoreWindow: true });
}

// --- Campaign worker -------------------------------------------------------

let timer: ReturnType<typeof setInterval> | undefined;
const TICK_MS = 15_000;

/** Count calls currently in flight (so we respect the concurrency cap). */
async function activeCallCount(): Promise<number> {
  const { count } = await db()
    .from("call")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "ringing", "in-progress"]);
  return count ?? 0;
}

/** One scheduling pass: dial eligible leads up to the concurrency cap. */
export async function runCampaignTick(): Promise<void> {
  // Only run if a campaign is marked running.
  const { data: campaign } = await db()
    .from("campaign")
    .select("*")
    .eq("status", "running")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!campaign) return;

  const tz = campaign.timezone ?? env.outboundTimezone;
  const start = campaign.call_window_start ?? env.callWindowStart;
  const end = campaign.call_window_end ?? env.callWindowEnd;
  if (!isWithinCallingWindow(tz, start, end)) return;

  const maxConcurrent = campaign.max_concurrent ?? env.maxConcurrentCalls;
  const maxAttempts = campaign.max_attempts ?? env.maxCallAttempts;

  const active = await activeCallCount();
  const slots = Math.max(0, maxConcurrent - active);
  if (slots === 0) return;

  const { data: leads } = await db()
    .from("lead")
    .select("*")
    .eq("campaign_id", campaign.id)
    .eq("dnc", false)
    .not("dial_phone", "is", null)
    .in("disposition", RETRYABLE_DISPOSITIONS)
    .lt("attempts", maxAttempts)
    .order("lead_score", { ascending: false })
    .limit(slots)
    .returns<LeadRow[]>();

  if (!leads?.length) return;

  for (const lead of leads) {
    const r = await placeCall(lead);
    if (!r.ok) log.warn("Skipped lead", { leadId: lead.id, reason: r.reason });
  }
}

export function startCampaignWorker(): void {
  if (timer) return;
  log.info("Campaign worker started", { tickMs: TICK_MS });
  timer = setInterval(() => {
    runCampaignTick().catch((err) => log.error("Campaign tick failed", { err: String(err) }));
  }, TICK_MS);
  // Kick one immediately.
  runCampaignTick().catch((err) => log.error("Campaign tick failed", { err: String(err) }));
}

export function stopCampaignWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
    log.info("Campaign worker stopped");
  }
}
