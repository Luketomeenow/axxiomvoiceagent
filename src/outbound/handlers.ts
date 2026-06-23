/**
 * Vapi webhook handlers for OUTBOUND campaign calls. Mirrors the inbound flow
 * in src/vapi/handlers.ts but writes to the `outbound` schema and updates lead
 * dispositions. Lead/call linkage rides in call.metadata ({ leadId, callRowId })
 * that the dialer sets, with a fallback lookup by vapi_call_id.
 */

import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { db, recordEvent, suppressNumber, type Disposition } from "./db.ts";
import { OUTBOUND_TOOL_NAMES } from "../assistant/outbound/tools.ts";
import {
  callMetadata,
  callerNumber,
  toolArgs,
  toolCallsOf,
  toolName,
  type VapiMessage,
  type VapiToolResults,
} from "../vapi/types.ts";

/** Is this server message for an outbound campaign call? */
export function isOutboundCall(message: VapiMessage): boolean {
  const meta = callMetadata(message);
  if (meta.kind === "outbound") return true;
  const assistantId = message.call?.assistantId ?? message.assistantId;
  return !!env.outboundAssistantId && assistantId === env.outboundAssistantId;
}

/** Resolve the outbound.call row id for this message (metadata first, then lookup). */
async function resolveCallRowId(message: VapiMessage): Promise<string | undefined> {
  const meta = callMetadata(message);
  if (typeof meta.callRowId === "string") return meta.callRowId;

  const vapiCallId = message.call?.id;
  if (!vapiCallId) return undefined;
  const { data } = await db().from("call").select("id").eq("vapi_call_id", vapiCallId).maybeSingle();
  return data?.id as string | undefined;
}

function leadIdOf(message: VapiMessage): string | undefined {
  const meta = callMetadata(message);
  return typeof meta.leadId === "string" ? meta.leadId : undefined;
}

// --- Anti-loop guard -------------------------------------------------------
// The model sometimes re-fires the same tool over and over (seen as a qualifyLead
// loop with "one sec" fillers). We dedupe identical repeat calls and cap how many
// times any one tool runs per call — returning a firm "stop, move on" redirect
// instead of redoing the work. This breaks the loop and never spams the DB,
// regardless of why the model repeated itself.
const MAX_TOOL_REPEATS = 3;
interface ToolHistory {
  seen: Set<string>; // `${tool}:${argsHash}`
  counts: Map<string, number>; // tool -> times actually run
}
const toolHistoryByCall = new Map<string, ToolHistory>();

function callKeyOf(message: VapiMessage): string {
  const meta = callMetadata(message);
  return (message.call?.id as string) || (meta.callRowId as string) || "unknown";
}

function stableArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return Math.random().toString(36);
  }
}

/** Firm redirect when a tool is (re)called unnecessarily — what breaks the loop. */
function repeatRedirect(tool: string): string {
  switch (tool) {
    case OUTBOUND_TOOL_NAMES.qualifyLead:
      return "You already saved the lead's details — do NOT call qualifyLead again. Keep talking with the caller, and when you're ready to finish, call recordDisposition exactly once.";
    case OUTBOUND_TOOL_NAMES.lookupViolationCode:
      return "You already looked that up — use the answer you got. Do NOT call lookupViolationCode again for this.";
    case OUTBOUND_TOOL_NAMES.recordDisposition:
      return "The disposition is already recorded — do NOT call recordDisposition again. Wrap up in one sentence and call endCall.";
    case OUTBOUND_TOOL_NAMES.optOut:
      return "The opt-out is already handled — apologize briefly and end the call.";
    default:
      return "That's already been handled — do not repeat this tool call; just continue the conversation.";
  }
}

/** Drop a call's tool history once it ends (keeps the in-memory map small). */
export function clearToolHistory(message: VapiMessage): void {
  toolHistoryByCall.delete(callKeyOf(message));
}

// --- Tool implementations --------------------------------------------------

async function runQualifyLead(args: Record<string, unknown>, message: VapiMessage): Promise<string> {
  const leadId = leadIdOf(message);
  const callRowId = await resolveCallRowId(message);
  const interested = args.interested === true;

  const str = (v: unknown): string | undefined => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : undefined;
  };

  const noteParts = [
    args.currentProvider && `Current provider: ${args.currentProvider}`,
    args.timeline && `Timeline: ${args.timeline}`,
    args.bestCallbackName && `Best contact: ${args.bestCallbackName}`,
    args.bestCallbackPhone && `Callback: ${args.bestCallbackPhone}`,
    args.bestCallbackEmail && `Email: ${args.bestCallbackEmail}`,
    args.notes,
  ].filter(Boolean);
  const notes = noteParts.join(" | ");

  if (leadId) {
    // Write the structured, sales-ready fields (not just the free-text note),
    // so the sales team gets clean columns to act on.
    await db()
      .from("lead")
      .update({
        consent_recording: true,
        notes: notes || null,
        decision_maker: typeof args.decisionMaker === "boolean" ? args.decisionMaker : null,
        current_provider: str(args.currentProvider) ?? null,
        timeline: str(args.timeline) ?? null,
        callback_name: str(args.bestCallbackName) ?? null,
        callback_phone: str(args.bestCallbackPhone) ?? null,
        callback_email: str(args.bestCallbackEmail) ?? null,
        contact_phone: str(args.bestCallbackPhone),
        contact_email: str(args.bestCallbackEmail),
      })
      .eq("id", leadId);
  }
  await recordEvent({
    call_id: callRowId,
    vapi_call_id: message.call?.id,
    type: "tool-call",
    text: "qualifyLead",
    payload: args,
  });

  return interested
    ? "Saved. They're interested — confirm the next step and then call recordDisposition with 'qualified'."
    : "Saved. Note their hesitation; wrap up politely and call recordDisposition with the right outcome.";
}

async function runRecordDisposition(args: Record<string, unknown>, message: VapiMessage): Promise<string> {
  const leadId = leadIdOf(message);
  const callRowId = await resolveCallRowId(message);
  const disposition = String(args.disposition || "needs_followup") as Disposition;
  const notes = (args.notes as string) || null;

  if (leadId) {
    const update: Record<string, unknown> = { disposition, notes };
    // Stamp the moment a lead became sales-ready.
    if (disposition === "qualified") update.qualified_at = new Date().toISOString();
    await db().from("lead").update(update).eq("id", leadId);
  }
  if (callRowId) {
    await db().from("call").update({ disposition, outcome: disposition }).eq("id", callRowId);
  }
  await recordEvent({
    call_id: callRowId,
    vapi_call_id: message.call?.id,
    type: "tool-call",
    text: `recordDisposition: ${disposition}`,
    payload: args,
  });

  return `Disposition recorded as ${disposition}. Thank them and wrap up the call.`;
}

async function runOptOut(args: Record<string, unknown>, message: VapiMessage): Promise<string> {
  const leadId = leadIdOf(message);
  const callRowId = await resolveCallRowId(message);
  const phone = callerNumber(message) || (callMetadata(message).phone as string) || "";
  const reason = (args.reason as string) || "requested do not call";

  // Resolve the number from the lead if it wasn't on the message.
  let dialPhone = phone;
  if (!dialPhone && leadId) {
    const { data } = await db().from("lead").select("dial_phone").eq("id", leadId).maybeSingle();
    dialPhone = (data?.dial_phone as string) || "";
  }
  if (dialPhone) await suppressNumber(dialPhone, reason, "caller_request");
  if (leadId) await db().from("lead").update({ dnc: true, disposition: "dnc", notes: reason }).eq("id", leadId);
  if (callRowId) await db().from("call").update({ disposition: "dnc", outcome: "do_not_call" }).eq("id", callRowId);

  await recordEvent({
    call_id: callRowId,
    vapi_call_id: message.call?.id,
    type: "consent",
    text: `opt-out: ${reason}`,
    payload: { phone: dialPhone },
  });

  return "Understood. I've added them to our do-not-call list. Apologize briefly for the interruption and end the call.";
}

/**
 * Verified code lookup. Reads ONLY from outbound.code_reference so the agent
 * never invents what a citation means. Tries an exact match on the normalized
 * code, then a loose contains-match, then reports "not found" so the agent
 * stays honest and defers to the team.
 */
async function runLookupViolationCode(args: Record<string, unknown>, message: VapiMessage): Promise<string> {
  const callRowId = await resolveCallRowId(message);
  const raw = typeof args.code === "string" ? args.code.trim() : "";
  // Normalize for matching (must match scripts/import-codes.ts): uppercase, keep
  // alphanumerics/dots, and collapse spaces/punctuation to underscores so topic
  // keys like "overdue inspection" → "OVERDUE_INSPECTION" line up with the seed.
  const normalized = raw
    .toUpperCase()
    .replace(/[^A-Z0-9.]+/g, "_")
    .replace(/^_+|_+$/g, "");

  let found: Record<string, unknown> | null = null;
  if (normalized) {
    const exact = await db().from("code_reference").select("*").eq("code", normalized).maybeSingle();
    found = (exact.data as Record<string, unknown> | null) ?? null;
    if (!found) {
      const loose = await db()
        .from("code_reference")
        .select("*")
        .ilike("code", `%${normalized}%`)
        .limit(1)
        .maybeSingle();
      found = (loose.data as Record<string, unknown> | null) ?? null;
    }
  }

  await recordEvent({
    call_id: callRowId,
    vapi_call_id: message.call?.id,
    type: "tool-call",
    text: `lookupViolationCode: ${raw}${found ? "" : " (not found)"}`,
    payload: { query: raw, found: found?.code ?? null },
  });

  if (!found) {
    return `No verified entry for "${raw}" in our reference. Do NOT guess its meaning — tell them our team will confirm the exact code details, and continue.`;
  }

  const parts = [
    found.title && `Title: ${found.title}`,
    found.plain_summary && `Means: ${found.plain_summary}`,
    found.severity && `Severity: ${found.severity}`,
    found.typical_remedy && `Typically requires: ${found.typical_remedy}`,
  ].filter(Boolean);
  return `Verified code ${found.code}. ${parts.join(". ")}. Explain this briefly and plainly; do not add details beyond this.`;
}

// --- Message handlers ------------------------------------------------------

export async function handleOutboundToolCalls(message: VapiMessage): Promise<VapiToolResults> {
  const results: VapiToolResults["results"] = [];
  const key = callKeyOf(message);
  let history = toolHistoryByCall.get(key);
  if (!history) {
    history = { seen: new Set(), counts: new Map() };
    toolHistoryByCall.set(key, history);
  }

  for (const call of toolCallsOf(message)) {
    const name = toolName(call);
    const args = toolArgs(call);
    // Echo Vapi's tool-call id so the result is delivered back to the model.
    const toolCallId = call.id ?? `${name}-${results.length}`;
    log.info("Outbound tool call", { callId: message.call?.id, tool: name, args });

    // Anti-loop: an identical repeat, or too many runs of the same tool, gets a
    // firm redirect instead of re-running — no duplicate DB work, instant reply.
    const sig = `${name}:${stableArgs(args)}`;
    const count = history.counts.get(name) ?? 0;
    if (history.seen.has(sig) || count >= MAX_TOOL_REPEATS) {
      log.warn("Suppressed repeat tool call", { tool: name, count, callId: message.call?.id });
      results.push({ toolCallId, result: repeatRedirect(name) });
      continue;
    }

    let result: string;
    try {
      if (name === OUTBOUND_TOOL_NAMES.qualifyLead) {
        result = await runQualifyLead(args, message);
      } else if (name === OUTBOUND_TOOL_NAMES.recordDisposition) {
        result = await runRecordDisposition(args, message);
      } else if (name === OUTBOUND_TOOL_NAMES.optOut) {
        result = await runOptOut(args, message);
      } else if (name === OUTBOUND_TOOL_NAMES.lookupViolationCode) {
        result = await runLookupViolationCode(args, message);
      } else {
        result = `Unknown tool: ${name}`;
        log.warn("Unknown outbound tool called", { tool: name });
      }
    } catch (err) {
      log.error("Outbound tool execution failed", { tool: name, err: String(err) });
      result = "Sorry, I hit a problem saving that. Wrap up politely; the team will follow up.";
    }

    history.seen.add(sig);
    history.counts.set(name, count + 1);
    results.push({ toolCallId, result });
  }

  return { results };
}

export async function handleOutboundStatusUpdate(message: VapiMessage): Promise<void> {
  const callRowId = await resolveCallRowId(message);
  const status = message.status ?? "";
  if (!status) return;

  // Map Vapi statuses onto our call.status vocabulary.
  const map: Record<string, string> = {
    queued: "queued",
    ringing: "ringing",
    "in-progress": "in-progress",
    forwarding: "in-progress",
    ended: "ended",
  };
  const mapped = map[status] ?? status;
  if (callRowId) {
    await db().from("call").update({ status: mapped }).eq("id", callRowId);
  }
  await recordEvent({
    call_id: callRowId,
    vapi_call_id: message.call?.id,
    type: "status-update",
    text: status,
    payload: { status },
  });
}

export async function handleOutboundTranscript(message: VapiMessage): Promise<void> {
  // Only persist finalized lines to keep the live feed clean.
  if (message.transcriptType && message.transcriptType !== "final") return;
  const text = message.transcript;
  if (!text) return;
  const callRowId = await resolveCallRowId(message);
  await recordEvent({
    call_id: callRowId,
    vapi_call_id: message.call?.id,
    type: "transcript",
    role: message.role ?? null,
    text,
  });
}

export async function handleOutboundEndOfCall(message: VapiMessage): Promise<void> {
  clearToolHistory(message); // free this call's anti-loop history
  const callRowId = await resolveCallRowId(message);
  const leadId = leadIdOf(message);
  const transcript = message.transcript ?? message.artifact?.transcript ?? "";
  const transferred = (message.endedReason ?? "").toLowerCase().includes("transfer");
  const summary = message.analysis?.summary ?? message.summary ?? null;
  const recordingUrl = message.recordingUrl ?? message.artifact?.recordingUrl ?? null;

  if (callRowId) {
    const { data: existing } = await db().from("call").select("disposition").eq("id", callRowId).maybeSingle();
    const update: Record<string, unknown> = {
      status: "ended",
      ended_reason: message.endedReason ?? null,
      duration_seconds: message.durationSeconds ?? null,
      transcript: transcript || null,
      summary,
      recording_url: recordingUrl,
      transferred_to_human: transferred,
      ended_at: new Date().toISOString(),
      raw: message,
    };
    // If no tool set a disposition, infer one from how the call ended.
    if (!existing?.disposition) {
      const reason = (message.endedReason ?? "").toLowerCase();
      const fallback = transferred
        ? "qualified"
        : reason.includes("voicemail")
          ? "voicemail"
          : reason.includes("no-answer") || reason.includes("customer-did-not-answer") || reason.includes("busy")
            ? "no_answer"
            : "needs_followup";
      update.outcome = fallback;
      update.disposition = fallback;
      if (leadId) {
        // Don't overwrite a disposition a tool already set on the lead.
        const { data: lead } = await db().from("lead").select("disposition").eq("id", leadId).maybeSingle();
        if (lead && (lead.disposition === "calling" || lead.disposition === "queued" || lead.disposition === "new")) {
          await db().from("lead").update({ disposition: fallback }).eq("id", leadId);
        }
      }
    }
    await db().from("call").update(update).eq("id", callRowId);
  }

  await recordEvent({
    call_id: callRowId,
    vapi_call_id: message.call?.id,
    type: "end-of-call",
    text: message.endedReason ?? "ended",
    payload: { summary },
  });

  log.info("Outbound end-of-call processed", { callId: message.call?.id, leadId });
}
