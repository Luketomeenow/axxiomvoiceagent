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
import { checkSuppression, db, recordEvent, updateCall, updateLead, type LeadRow } from "./db.ts";
import { toE164 } from "./phone.ts";
import { timezoneForState } from "./timezone.ts";
import { maskPhone } from "../lib/redact.ts";
import { type Brand, brandForState, brandByName, getBrand, resolveBrand } from "../assistant/brands.ts";
import { getBrandAssistantId } from "./brandStore.ts";

interface BrandRouting {
  assistantId?: string;
  phoneNumberId?: string;
  brand?: string; // resolved brand slug (denormalized onto the call row)
}

/** A resolved brand → its assistant id + caller-ID number (empty if no brand).
 *  For multi-region brands, dial from the number local to the lead's state. */
async function routingForBrand(brand?: Brand, state?: string | null): Promise<BrandRouting> {
  if (!brand) return {};
  const byState = state ? brand.phoneNumberByState?.[state.trim().toUpperCase()] : undefined;
  return {
    assistantId: (await getBrandAssistantId(brand.slug)) || undefined,
    phoneNumberId: byState || brand.vapiPhoneNumberId,
    brand: brand.slug,
  };
}

/** Resolve a brand slug → its assistant id + caller-ID number (empty if unknown). */
async function brandRoutingBySlug(slug?: string | null): Promise<BrandRouting> {
  const s = slug?.trim();
  if (!s) return {};
  return routingForBrand(getBrand(s));
}

/**
 * Auto-assign a campaign's brand (and its calling-hours timezone) from its
 * leads when none is set yet, so the operator never has to choose. Picks the
 * most common brand resolved from each lead's servicing_brand/state. No-op if a
 * brand is already set (manual override) or no confident match is found.
 * Returns the resolved slug, or null.
 */
export async function autoAssignCampaignBrand(campaignId: string | null): Promise<string | null> {
  if (!campaignId) return null;
  const { data: camp } = await db()
    .from("campaign")
    .select("id, brand, region, name")
    .eq("id", campaignId)
    .maybeSingle();
  if (!camp) return null;
  if (camp.brand) return camp.brand as string; // already set — respect it

  const { data: leads } = await db()
    .from("lead")
    .select("servicing_brand, state")
    .eq("campaign_id", campaignId)
    .limit(2000);

  // Tally the brand each lead resolves to (servicing_brand wins, else state).
  const tally = new Map<string, number>();
  for (const l of leads ?? []) {
    const b =
      brandByName((l as { servicing_brand: string | null }).servicing_brand) ??
      ((l as { state: string | null }).state ? brandForState((l as { state: string | null }).state as string) : undefined);
    if (b) tally.set(b.slug, (tally.get(b.slug) ?? 0) + 1);
  }

  // Most common brand across leads, else fall back to the campaign's own
  // region/name (e.g. "Quality — MD" → quality, "MD" → quality).
  let slug = tally.size ? [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0] : undefined;
  if (!slug) {
    const region = (camp.region as string | null) ?? "";
    const name = (camp.name as string | null) ?? "";
    const fb =
      brandByName(name) ??
      brandByName(region) ??
      (region ? brandForState(region) : undefined);
    slug = fb?.slug;
  }
  if (!slug) return null;

  const brand = getBrand(slug);
  await db()
    .from("campaign")
    .update({ brand: slug, timezone: brand?.timezone, updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  log.info("Auto-assigned campaign brand from leads", { campaignId, brand: slug });
  return slug;
}

const VAPI_API = "https://api.vapi.ai";

// Leads in these states are still callable (subject to attempt cap). ivr =
// reached an automated menu with no path to a human; retried like voicemail.
const RETRYABLE_DISPOSITIONS = ["new", "queued", "no_answer", "voicemail", "ivr"];

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

/** Verified cert status sentence from cert_expiry_date vs. today. Never returns
 *  "" — an empty clause left a dangling ". ." in the prompt's status sentence. */
function certStatus(lead: LeadRow): string {
  const raw = (lead.cert_expiry_date || "").trim();
  if (!raw) return "the certificate of operation status isn't listed in the record";
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return `the certificate of operation on file shows ${raw}`;
  return when.getTime() < Date.now()
    ? `the certificate of operation on file expired on ${raw}`
    : `the certificate of operation on file is set to expire on ${raw}`;
}

/** A field only counts if it has an actual letter/number — guards against
 *  placeholder junk ("-", ".", "N/A", zero-width) that would voice as a blank
 *  in the opener ("the elevator at ___ is showing…"). */
function meaningful(s: string | null | undefined): string | undefined {
  const t = (s ?? "").trim();
  return /[a-z0-9]/i.test(t) ? t : undefined;
}

/** Variable values injected into the assistant prompt + first message per call. */
function variableValuesFor(lead: LeadRow): Record<string, string> {
  return {
    contactName: meaningful(lead.contact_name) ?? "there",
    buildingName: meaningful(lead.building_name) ?? meaningful(lead.address) ?? "your building",
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
  assistantId?: string; // per-brand override (else the env default)
  phoneNumberId?: string; // per-brand caller-ID override (else the env default)
  brand?: string | null; // resolved brand slug (denormalized for analytics)
  attemptNumber?: number | null; // which attempt this is for the lead (1-based)
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
      brand: opts.brand ?? null,
      attempt_number: opts.attemptNumber ?? null,
    })
    .select("id")
    .single();
  if (callErr || !callRow) {
    return { ok: false, reason: `could not create call row: ${callErr?.message}` };
  }
  const callRowId = callRow.id as string;

  try {
    const result = await vapiPost("/call", {
      phoneNumberId: opts.phoneNumberId || env.vapiPhoneNumberId,
      assistantId: opts.assistantId || env.outboundAssistantId,
      assistantOverrides: { variableValues: opts.variableValues },
      customer: { number: opts.phone },
      metadata: { ...opts.metadata, callRowId },
    });

    const vapiCallId = result.id;
    // Vapi returns a per-call `monitor.controlUrl` we can POST to in order to
    // end (or otherwise control) the live call from the dashboard.
    const controlUrl =
      (result.monitor as { controlUrl?: string } | undefined)?.controlUrl ?? null;
    // Resilient write (retry + dead-letter): losing this silently would strand the
    // call row without its vapi_call_id/control_url (no "End call", webhook linkage
    // falls back to metadata.callRowId only).
    await updateCall(callRowId, {
      vapi_call_id: vapiCallId,
      control_url: controlUrl,
      status: "ringing",
      started_at: new Date().toISOString(),
    });

    await recordEvent({
      call_id: callRowId,
      vapi_call_id: vapiCallId,
      type: "status-update",
      text: "dialing",
      payload: { phone: opts.phone, kind: opts.metadata.kind ?? "outbound" },
    });

    log.info("Outbound call placed", { leadId: opts.leadId ?? null, vapiCallId, phone: maskPhone(opts.phone) });
    return { ok: true, vapiCallId, callRowId };
  } catch (err) {
    await updateCall(callRowId, {
      status: "ended",
      outcome: "failed",
      ended_reason: String(err),
      ended_at: new Date().toISOString(),
    });
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

  // Per-lead concurrency guard: never place a second call for a lead that
  // already has one in flight (the global concurrency cap doesn't prevent the
  // same lead being picked twice, e.g. campaign tick + manual call-now).
  const { count: inFlight } = await db()
    .from("call")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", lead.id)
    .in("status", ["queued", "ringing", "in-progress"]);
  if ((inFlight ?? 0) > 0) return { ok: false, reason: "lead already has a call in flight" };

  const sup = await checkSuppression(phone);
  if (sup.suppressed) {
    if (sup.reason === "lookup_error") {
      // Don't poison the lead as DNC for a connectivity/config problem.
      return { ok: false, reason: `DNC check failed (Supabase error): ${sup.error}` };
    }
    await updateLead(lead.id, { dnc: true, disposition: "dnc" });
    return { ok: false, reason: "number is suppressed (DNC)" };
  }

  // Fetch the campaign once for BOTH the calling-window check and brand routing.
  let campaignBrand: string | null = null;
  let tz = env.outboundTimezone;
  let winStart = env.callWindowStart;
  let winEnd = env.callWindowEnd;
  if (lead.campaign_id) {
    const { data: camp } = await db()
      .from("campaign")
      .select("brand, timezone, call_window_start, call_window_end")
      .eq("id", lead.campaign_id)
      .maybeSingle();
    if (camp) {
      campaignBrand = (camp.brand as string | null) ?? null;
      tz = (camp.timezone as string) ?? tz;
      winStart = (camp.call_window_start as number) ?? winStart;
      winEnd = (camp.call_window_end as number) ?? winEnd;
    }
  }

  // Enforce the calling window in the LEAD's own timezone (from its state) when
  // known, falling back to the campaign tz. TCPA is about the called party's
  // local time — a multi-tz brand (e.g. AmeriTex spanning TX+CA on Central) must
  // not dial a CA lead on Central hours. Manual call-now bypasses the window.
  const windowTz = timezoneForState(lead.state) ?? tz;
  if (!opts.ignoreWindow && !isWithinCallingWindow(windowTz, winStart, winEnd)) {
    return { ok: false, reason: "outside calling window" };
  }

  // Per-number frequency cap across ALL leads sharing this phone (one number can
  // map to several buildings). Prevents over-calling one person. Manual call-now
  // bypasses it (operator's discretion). Back the lead off so we don't re-check
  // it every tick once capped.
  if (!opts.ignoreWindow) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { count: recentToNumber } = await db()
      .from("call")
      .select("id", { count: "exact", head: true })
      .eq("phone_number", phone)
      .gte("created_at", dayAgo);
    if ((recentToNumber ?? 0) >= env.maxCallsPerNumberPerDay) {
      await updateLead(lead.id, { next_attempt_after: new Date(Date.now() + 6 * 60 * 60_000).toISOString() });
      return { ok: false, reason: "per-number daily frequency cap reached" };
    }
  }

  // Automatic routing: brand (→ voice + caller-ID + compliance assistant) is
  // resolved from the campaign override → lead's servicing_brand → lead's state.
  const brand = resolveBrand({ campaignBrand, servicingBrand: lead.servicing_brand, state: lead.state });
  const routing = await routingForBrand(brand, lead.state);
  const attemptNumber = (lead.attempts ?? 0) + 1;

  const result = await dispatchCall({
    phone,
    variableValues: variableValuesFor(lead),
    metadata: { leadId: lead.id, campaignId: lead.campaign_id, kind: "outbound" },
    leadId: lead.id,
    campaignId: lead.campaign_id,
    assistantId: routing.assistantId,
    phoneNumberId: routing.phoneNumberId,
    brand: routing.brand,
    attemptNumber,
  });

  if (result.ok) {
    // Resilient write (retry + dead-letter): this is the attempts increment. If it
    // were dropped silently, `attempts` would under-count and the lead could be
    // dialed past its cap (a frequency/compliance risk), so never write it raw.
    await updateLead(lead.id, {
      disposition: "calling",
      attempts: attemptNumber,
      last_attempt_at: new Date().toISOString(),
    });
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

  // Mark it ended immediately so it leaves the live monitor even if Vapi's
  // end-of-call webhook is delayed or never arrives (resilient write).
  await updateCall(callRowId, {
    status: "ended",
    ended_reason: "ended-by-operator",
    ended_by: "operator",
    ended_at: new Date().toISOString(),
  });

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
  brand?: string; // optional brand slug → test that brand's agent (voice + caller ID)
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

  // If a brand is chosen, test THAT brand's agent (its assistant = voice + prompt)
  // and dial from its caller ID; otherwise the env-default outbound assistant.
  const routing = await brandRoutingBySlug(input.brand);

  return dispatchCall({
    phone,
    variableValues,
    metadata: { kind: "test", brand: input.brand ?? null },
    assistantId: routing.assistantId,
    phoneNumberId: routing.phoneNumberId,
    brand: routing.brand ?? input.brand ?? null,
  });
}

// --- Campaign worker -------------------------------------------------------

let timer: ReturnType<typeof setInterval> | undefined;
const TICK_MS = 15_000;

// A call can't legitimately stay live longer than maxDurationSeconds (480s) plus
// ring time. If an end-of-call webhook is ever missed, the call would otherwise
// sit "ringing" forever and permanently consume a concurrency slot — so we sweep.
const STALE_CALL_MS = 15 * 60_000;

/**
 * Close calls stuck in a live state past the max plausible duration. Without
 * this, a single missed end-of-call webhook leaves a call "ringing" forever and
 * blocks the concurrency slot, so the campaign silently stops dialing.
 */
async function sweepStaleCalls(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CALL_MS).toISOString();
  const { data, error } = await db()
    .from("call")
    .update({ status: "ended", ended_reason: "stale-timeout", ended_by: "system", ended_at: new Date().toISOString() })
    .in("status", ["queued", "ringing", "in-progress"])
    .lt("created_at", cutoff)
    .select("id, lead_id");
  if (error) {
    log.warn("Stale-call sweep failed", { err: error.message });
    return;
  }
  if (!data?.length) return;
  log.info("Swept stale calls", { count: data.length });

  // Recover any lead pinned in `calling` by a swept call (the missed end-of-call
  // webhook this sweeper exists for). Without this the lead is never re-dialed —
  // `calling` isn't a retryable disposition — so it's silently dropped. Return it
  // to a retryable state with the normal backoff, but only if it has no other
  // call still in flight. The conditional `.eq("disposition","calling")` makes it
  // atomic + a no-op if a late webhook already resolved the lead; raw (not
  // updateLead) is fine here — the sweeper re-runs every tick, so it self-heals.
  const leadIds = [
    ...new Set(data.map((r) => (r as { lead_id: string | null }).lead_id).filter(Boolean)),
  ] as string[];
  for (const leadId of leadIds) {
    const { count } = await db()
      .from("call")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .in("status", ["queued", "ringing", "in-progress"]);
    if ((count ?? 0) > 0) continue; // still has a live call — leave it
    const nextAttempt = new Date(Date.now() + env.retryBackoffMinutes * 60_000).toISOString();
    const { error: leadErr } = await db()
      .from("lead")
      .update({ disposition: "no_answer", next_attempt_after: nextAttempt })
      .eq("id", leadId)
      .eq("disposition", "calling");
    if (leadErr) log.warn("Stale-lead recovery failed", { leadId, err: leadErr.message });
  }
}

/** Count calls currently in flight. Scoped to one campaign so multiple running
 *  campaigns each get their own concurrency budget (one can't starve another). */
async function activeCallCount(campaignId?: string): Promise<number> {
  let q = db()
    .from("call")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "ringing", "in-progress"]);
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { count } = await q;
  return count ?? 0;
}

/**
 * One scheduling pass. Sweeps stale calls, then dials EVERY running campaign
 * independently (multiple campaigns can run at the same time, each with its own
 * window, concurrency, and per-run budget). Self-idles the worker when nothing
 * is running.
 */
// Re-entrancy guard: a tick can take longer than TICK_MS (sweep + N Vapi POSTs),
// and setInterval doesn't await, so ticks could otherwise overlap and race on
// activeCallCount / lead selection (concurrency + per-run budget overrun, and
// double-dialing the same lead). One instance only — see CLAUDE.md before scaling.
let ticking = false;

export async function runCampaignTick(): Promise<void> {
  if (ticking) {
    log.warn("Skipping campaign tick — previous tick still running");
    return;
  }
  ticking = true;
  const analyzeIds: string[] = [];
  try {
    await sweepStaleCalls();

    const { data: campaigns } = await db().from("campaign").select("*").eq("status", "running");
    if (!campaigns?.length) {
      // Nothing to do — stop the timer; start/boot-resume re-arms it.
      stopCampaignWorker();
      return;
    }

    for (const campaign of campaigns) {
      const campaignId = (campaign as { id?: string }).id;
      try {
        await tickCampaign(campaign as Record<string, unknown>);
        if (campaignId) analyzeIds.push(campaignId);
      } catch (err) {
        log.error("Campaign tick failed", { campaignId, err: String(err) });
      }
    }
  } finally {
    ticking = false;
  }

  // Background maintenance runs AFTER the re-entrancy guard is released, detached
  // (not awaited), so a slow Claude analysis or Twilio sync can NEVER block the
  // next dialing tick — that blocking was starving the dialer ("only 1 call at a
  // time / nothing calling"). Both self-throttle (cooldown / interval) and
  // swallow their own errors, so fire-and-forget is safe.
  for (const id of analyzeIds) void maybeAutoAnalyze(id);
  void maybeSyncTwilio();
}

/** Dial one running campaign up to its concurrency cap + remaining per-run budget. */
async function tickCampaign(campaign: Record<string, unknown>): Promise<void> {
  const campaignId = campaign.id as string;
  const tz = (campaign.timezone as string) ?? env.outboundTimezone;
  const start = (campaign.call_window_start as number) ?? env.callWindowStart;
  const end = (campaign.call_window_end as number) ?? env.callWindowEnd;
  if (!isWithinCallingWindow(tz, start, end)) return;

  const maxConcurrent = (campaign.max_concurrent as number) ?? env.maxConcurrentCalls;
  const maxAttempts = (campaign.max_attempts as number) ?? env.maxCallAttempts;

  // Per-run call budget ("dial N this run, then auto-pause"). We count call rows
  // created since the run started — i.e. dial attempts, DB-derived so it's exact
  // across restarts/boot-resume. `null` budget = unlimited (legacy behavior).
  const budget = campaign.max_calls_per_run as number | null;
  const runStart = campaign.run_started_at as string | null;
  let remaining = Infinity;
  if (budget != null && runStart) {
    const { count } = await db()
      .from("call")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .gte("created_at", runStart);
    const placed = count ?? 0;
    if (placed >= budget) {
      log.info("Campaign hit per-run call budget — auto-pausing", { campaignId, placed, budget });
      // Pause ONLY this campaign; other running campaigns keep dialing.
      await db()
        .from("campaign")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", campaignId);
      return;
    }
    remaining = budget - placed;
  }

  // Per-campaign concurrency so one campaign can't starve the others.
  const active = await activeCallCount(campaignId);
  const slots = Math.min(Math.max(0, maxConcurrent - active), remaining);
  if (slots <= 0) return;

  // Respect the retry backoff: skip leads whose next_attempt_after is still in
  // the future (set on no-answer/voicemail). `null` means immediately eligible.
  const nowIso = new Date().toISOString();
  const { data: leads } = await db()
    .from("lead")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("dnc", false)
    .not("dial_phone", "is", null)
    .in("disposition", RETRYABLE_DISPOSITIONS)
    .lt("attempts", maxAttempts)
    .or(`next_attempt_after.is.null,next_attempt_after.lte.${nowIso}`)
    // Best leads first. `nullsFirst: false` is critical — PostgREST defaults to
    // NULLS FIRST on descending, which would float unscored leads ABOVE high
    // scorers. Tiebreak by fewest attempts so fresh leads beat oft-retried ones.
    .order("lead_score", { ascending: false, nullsFirst: false })
    .order("attempts", { ascending: true })
    .limit(slots)
    .returns<LeadRow[]>();

  if (!leads?.length) return;

  for (const lead of leads) {
    const r = await placeCall(lead);
    if (r.ok) continue;
    log.warn("Skipped lead", { leadId: lead.id, campaignId, reason: r.reason });
    // A systemic/account-level Vapi error (daily-number cap, billing, suspension)
    // will reject EVERY call — so auto-pause this campaign instead of hammering
    // the same lead each tick and burning the quota. The reason is logged + kept
    // on the failed call rows for the operator.
    if (isSystemicDialError(r.reason)) {
      log.error("Systemic dial error — auto-pausing campaign", { campaignId, reason: r.reason });
      await db()
        .from("campaign")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", campaignId);
      return;
    }
  }
}

// --- Auto transcript analysis (continuous improvement) ---------------------
// After every INSIGHT_EVERY_N_CALLS ended calls, analyze the batch once. Tracked
// by comparing ended-call count to existing insight count, with an in-memory
// cooldown so a persistent failure can't re-hit Claude every tick (single
// instance, like the rest of the worker state).
const AUTO_ANALYZE_COOLDOWN_MS = 30 * 60_000;
const lastAutoAnalyze = new Map<string, number>();
// Guards against a detached analysis for a campaign overlapping itself across
// ticks (it now runs un-awaited, so a slow Claude call could still be in flight
// when the next tick fires).
const analyzeInFlight = new Set<string>();

async function maybeAutoAnalyze(campaignId: string): Promise<void> {
  if (!env.anthropicApiKey) return;
  if (analyzeInFlight.has(campaignId)) return;
  const n = env.insightEveryNCalls;
  const [{ count: ended }, { count: insights }] = await Promise.all([
    db().from("call").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("status", "ended"),
    db().from("campaign_insight").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId),
  ]);
  const endedCount = ended ?? 0;
  const insightCount = insights ?? 0;
  // Not enough new ended calls since the last insight to warrant another pass.
  if (endedCount < (insightCount + 1) * n) return;

  const now = Date.now();
  if (now - (lastAutoAnalyze.get(campaignId) ?? 0) < AUTO_ANALYZE_COOLDOWN_MS) return;
  lastAutoAnalyze.set(campaignId, now);

  analyzeInFlight.add(campaignId);
  log.info("Auto-analyzing campaign transcripts", { campaignId, endedCount, insightCount, n });
  const { analyzeCampaign } = await import("../ai/campaignInsights.ts");
  await analyzeCampaign(campaignId)
    .catch((err) => log.warn("Auto-analyze failed", { campaignId, err: String(err) }))
    .finally(() => analyzeInFlight.delete(campaignId));
}

// Periodically reconcile Twilio telephony cost/status onto recent calls. Twilio
// finalizes price shortly after a call ends, so a few-minute cadence is plenty.
const TWILIO_SYNC_INTERVAL_MS = 5 * 60_000;
let lastTwilioSync = 0;

async function maybeSyncTwilio(): Promise<void> {
  if (!env.twilioAccountSid || !env.twilioAuthToken) return;
  const now = Date.now();
  if (now - lastTwilioSync < TWILIO_SYNC_INTERVAL_MS) return;
  lastTwilioSync = now;
  const { syncTwilioCosts } = await import("./twilioSync.ts");
  await syncTwilioCosts({ limit: 200 }).catch((err) => log.warn("Twilio auto-sync failed", { err: String(err) }));
}

/** True if a dial failure is account/telephony-level (will fail every call), not
 *  specific to one lead — e.g. Vapi's daily outbound cap on Vapi-bought numbers. */
function isSystemicDialError(reason?: string): boolean {
  const s = (reason ?? "").toLowerCase();
  return (
    s.includes("daily outbound call limit") ||
    s.includes("couldn't start call") ||
    s.includes("subscriptionlimits") ||
    s.includes("concurrencyblocked\":true") ||
    s.includes("billing") ||
    s.includes("insufficient") ||
    s.includes("suspend")
  );
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
