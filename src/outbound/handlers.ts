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

// --- Tool implementations --------------------------------------------------

async function runQualifyLead(args: Record<string, unknown>, message: VapiMessage): Promise<string> {
  const leadId = leadIdOf(message);
  const callRowId = await resolveCallRowId(message);
  const interested = args.interested === true;

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
    await db()
      .from("lead")
      .update({
        consent_recording: true,
        notes: notes || null,
        contact_phone: (args.bestCallbackPhone as string) || undefined,
        contact_email: (args.bestCallbackEmail as string) || undefined,
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
    await db().from("lead").update({ disposition, notes }).eq("id", leadId);
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

// --- Message handlers ------------------------------------------------------

export async function handleOutboundToolCalls(message: VapiMessage): Promise<VapiToolResults> {
  const results: VapiToolResults["results"] = [];

  for (const call of toolCallsOf(message)) {
    const name = toolName(call);
    const args = toolArgs(call);
    log.info("Outbound tool call", { callId: message.call?.id, tool: name, args });

    let result: string;
    try {
      if (name === OUTBOUND_TOOL_NAMES.qualifyLead) {
        result = await runQualifyLead(args, message);
      } else if (name === OUTBOUND_TOOL_NAMES.recordDisposition) {
        result = await runRecordDisposition(args, message);
      } else if (name === OUTBOUND_TOOL_NAMES.optOut) {
        result = await runOptOut(args, message);
      } else {
        result = `Unknown tool: ${name}`;
        log.warn("Unknown outbound tool called", { tool: name });
      }
    } catch (err) {
      log.error("Outbound tool execution failed", { tool: name, err: String(err) });
      result = "Sorry, I hit a problem saving that. Wrap up politely; the team will follow up.";
    }

    results.push({ toolCallId: call.id, result });
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
