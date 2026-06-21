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
import { toE164 } from "./phone.ts";

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
    // The building's own inspection record — so the agent speaks accurately
    // about THIS building's codes (and verifies any specifics via lookupViolationCode).
    violationCodes: lead.violation_codes || "none on file",
    violationDetails: lead.violation_details || "",
    violationCount: lead.violation_count != null ? String(lead.violation_count) : "0",
    lastInspectionDate: lead.last_inspection_date ?? "unknown",
  };
}

/**
 * Core dial primitive: create the call row, place the Vapi call, link them.
 * Used by both `placeCall` (campaign/lead dialing) and `testCall` (ad-hoc, no
 * lead row). Callers are responsible for DNC / calling-window guards first.
 */
async function dispatchCall(opts: {
  phone: string;
  variableValues: Record<string, string>;
  metadata: Record<string, unknown>;
  leadId?: string | null;
  campaignId?: string | null;
}): Promise<DialResult> {
  assertOutbound();

  // Create the call row first so the webhook can link events even if it races
  // ahead of our response handling.
  const { data: callRow, error: callErr } = await db()
    .from("call")
    .insert({
      lead_id: opts.leadId ?? null,
      campaign_id: opts.campaignId ?? null,
      phone_number: opts.phone,
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
      assistantOverrides: { variableValues: opts.variableValues },
      customer: { number: opts.phone },
      metadata: { ...opts.metadata, callRowId },
    });

    const vapiCallId = result.id;
    await db()
      .from("call")
      .update({ vapi_call_id: vapiCallId, status: "ringing", started_at: new Date().toISOString() })
      .eq("id", callRowId);

    await recordEvent({
      call_id: callRowId,
      vapi_call_id: vapiCallId,
      type: "status-update",
      text: "dialing",
      payload: { phone: opts.phone, kind: opts.metadata.kind ?? "outbound" },
    });

    log.info("Outbound call placed", { leadId: opts.leadId ?? null, vapiCallId, phone: opts.phone });
    return { ok: true, vapiCallId, callRowId };
  } catch (err) {
    await db()
      .from("call")
      .update({ status: "ended", outcome: "failed", ended_reason: String(err), ended_at: new Date().toISOString() })
      .eq("id", callRowId);
    log.error("Outbound call failed to place", { leadId: opts.leadId ?? null, err: String(err) });
    return { ok: false, reason: String(err), callRowId };
  }
}

/**
 * Place a single outbound call for a lead. Enforces DNC + calling window
 * (manual call-now passes `ignoreWindow` but still checks DNC).
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

  const result = await dispatchCall({
    phone,
    variableValues: variableValuesFor(lead),
    metadata: { leadId: lead.id, campaignId: lead.campaign_id, kind: "outbound" },
    leadId: lead.id,
    campaignId: lead.campaign_id,
  });

  if (result.ok) {
    await db()
      .from("lead")
      .update({
        disposition: "calling",
        attempts: (lead.attempts ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", lead.id);
  }

  return result;
}

/** Manual "call now" from the dashboard. Looks up the lead, then dials. */
export async function callNow(leadId: string): Promise<DialResult> {
  const { data: lead, error } = await db().from("lead").select("*").eq("id", leadId).single<LeadRow>();
  if (error || !lead) return { ok: false, reason: "lead not found" };
  // Manual dials ignore the calling window (operator's discretion) but still honor DNC.
  return placeCall(lead, { ignoreWindow: true });
}

/** Fields an operator can set when test-calling the agent at an arbitrary number. */
export interface TestCallInput {
  phone: string;
  name?: string;
  buildingName?: string;
  address?: string;
  city?: string;
  problemType?: string;
  violationCodes?: string;
}

/**
 * Dial an arbitrary number to test the agent — no lead row required. Still
 * honors DNC. The call appears in the live monitor (metadata.kind = "test").
 */
export async function testCall(input: TestCallInput): Promise<DialResult> {
  assertOutbound();

  const phone = toE164(input.phone) ?? input.phone.trim();
  if (!phone) return { ok: false, reason: "no phone number provided" };
  if (await isSuppressed(phone)) return { ok: false, reason: "number is suppressed (DNC)" };

  const variableValues: Record<string, string> = {
    contactName: input.name || "there",
    buildingName: input.buildingName || "your building",
    address: input.address || "",
    city: input.city || "",
    problemType: input.problemType || "an overdue inspection",
    oemMatch: "unknown",
    certExpiry: "unknown",
    violationCodes: input.violationCodes || "none on file",
    violationDetails: "",
    violationCount: "0",
    lastInspectionDate: "unknown",
  };

  return dispatchCall({ phone, variableValues, metadata: { kind: "test" } });
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
