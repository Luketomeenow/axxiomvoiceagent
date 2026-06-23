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
import { checkSuppression, db, recordEvent, type LeadRow } from "./db.ts";
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

/** "State" / "insurance (NEIS)" / "" from the raw inspection_type tag. */
function inspectionKind(lead: LeadRow): string {
  const t = (lead.inspection_type || "").toLowerCase();
  if (t.includes("neis") || t.includes("insurance")) return "insurance (NEIS)";
  if (t.includes("state")) return "State";
  return "";
}

/** Plain-English phrase for what's flagged on this building (accurate, no invented codes). */
function humanProblem(lead: LeadRow): string {
  const kind = inspectionKind(lead);
  const type = kind ? `${kind} elevator inspection` : "elevator inspection";
  const overdue = (lead.problem_type || "").toLowerCase().includes("overdue");
  return overdue ? `an overdue ${type}` : `an ${type} on file`;
}

/** Verified cert status sentence from cert_expiry_date vs. today, or "" if unknown. */
function certStatus(lead: LeadRow): string {
  const raw = (lead.cert_expiry_date || "").trim();
  if (!raw) return "";
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return `the certificate of operation on file shows ${raw}`;
  return when.getTime() < Date.now()
    ? `the certificate of operation on file expired on ${raw}`
    : `the certificate of operation on file is set to expire on ${raw}`;
}

/** Variable values injected into the assistant prompt + first message per call. */
function variableValuesFor(lead: LeadRow): Record<string, string> {
  return {
    contactName: lead.contact_name ?? "there",
    buildingName: lead.building_name || lead.address || "your building",
    address: lead.address ?? "",
    city: lead.city ?? "",
    oemMatch: lead.oem_match ?? "unknown",
    certExpiry: lead.cert_expiry_date ?? "unknown",
    // Verified, building-specific compliance status (the value-first hook). These
    // come straight from the public inspection/permit record on file.
    humanProblem: humanProblem(lead),
    inspectionType: inspectionKind(lead) || "inspection",
    lastInspectionDate: lead.last_inspection_date ?? "unknown",
    certStatus: certStatus(lead),
    // Specific cited deficiencies (usually empty today — leads are flagged by an
    // overdue inspection / expired permit, not by cited codes). The prompt only
    // references these when present; specifics are confirmed at the free survey.
    violationCodes: lead.violation_codes || "",
    violationDetails: lead.violation_details || "",
    violationCount: lead.violation_count != null ? String(lead.violation_count) : "0",
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
    // Vapi returns a per-call `monitor.controlUrl` we can POST to in order to
    // end (or otherwise control) the live call from the dashboard.
    const controlUrl =
      (result.monitor as { controlUrl?: string } | undefined)?.controlUrl ?? null;
    await db()
      .from("call")
      .update({
        vapi_call_id: vapiCallId,
        control_url: controlUrl,
        status: "ringing",
        started_at: new Date().toISOString(),
      })
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

  const sup = await checkSuppression(phone);
  if (sup.suppressed) {
    if (sup.reason === "lookup_error") {
      // Don't poison the lead as DNC for a connectivity/config problem.
      return { ok: false, reason: `DNC check failed (Supabase error): ${sup.error}` };
    }
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

/**
 * End an in-flight call from the dashboard. Uses Vapi's per-call control URL
 * (captured at dispatch). Falls back to a clear reason if it isn't available
 * (e.g. the call predates this feature or already ended).
 */
export async function endCall(callRowId: string): Promise<DialResult> {
  assertOutbound();

  const { data: call } = await db()
    .from("call")
    .select("id, control_url, vapi_call_id, status")
    .eq("id", callRowId)
    .maybeSingle();
  if (!call) return { ok: false, reason: "call not found" };
  if (call.status === "ended") return { ok: false, reason: "call already ended" };

  const controlUrl = call.control_url as string | null;
  if (!controlUrl) return { ok: false, reason: "no control URL for this call — cannot end remotely" };

  try {
    const res = await fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "end-call" }),
      // Bound the request so a hung control URL can't stall the API server.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text();
      // 4xx/5xx usually means the call already ended (nothing to route to);
      // treat it as effectively ended so the dashboard can move on.
      throw new Error(`control ${res.status}: ${text}`);
    }
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? "end-call timed out contacting Vapi (call may have already ended)"
        : String(err);
    log.error("End-call failed", { callRowId, err: reason });
    return { ok: false, reason, callRowId };
  }

  await recordEvent({
    call_id: callRowId,
    vapi_call_id: (call.vapi_call_id as string) ?? undefined,
    type: "status-update",
    text: "ended by operator",
    payload: { source: "dashboard" },
  });
  log.info("Call ended by operator", { callRowId });
  return { ok: true, callRowId };
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
  const sup = await checkSuppression(phone);
  if (sup.suppressed) {
    if (sup.reason === "lookup_error") {
      return { ok: false, reason: `DNC check failed (Supabase error): ${sup.error}` };
    }
    return { ok: false, reason: "number is suppressed (DNC)" };
  }

  const variableValues: Record<string, string> = {
    contactName: input.name || "there",
    buildingName: input.buildingName || "your building",
    address: input.address || "",
    city: input.city || "",
    oemMatch: "unknown",
    certExpiry: "unknown",
    // Mirror the live prompt variables so test calls behave like real ones.
    humanProblem: input.problemType || "an overdue State elevator inspection",
    inspectionType: "inspection",
    lastInspectionDate: "unknown",
    certStatus: "the certificate of operation on file has expired",
    violationCodes: input.violationCodes || "",
    violationDetails: "",
    violationCount: "0",
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
