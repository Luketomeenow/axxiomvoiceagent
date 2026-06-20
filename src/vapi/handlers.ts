/**
 * Handlers for the Vapi server messages we care about:
 *  - "tool-calls"          → run lookupContact / bookSurvey, return results
 *  - "end-of-call-report"  → log the call to GHL + Supabase (+ optional analysis)
 */

import { env } from "../config/env.ts";
import {
  addTags,
  bookAppointment,
  createOpportunity,
  findContactByPhone,
  getFreeSlots,
  upsertContact,
} from "../ghl/api.ts";
import { analyzeTranscript } from "../ai/analyzeTranscript.ts";
import { insertVoiceCall } from "../supabase/voiceCall.ts";
import { log } from "../lib/logger.ts";
import { TOOL_NAMES } from "../assistant/tools.ts";
import {
  callerNumber,
  toolArgs,
  toolCallsOf,
  toolName,
  type VapiMessage,
  type VapiToolResults,
} from "./types.ts";

/**
 * Per-call working state, keyed by Vapi call id. In-memory only — fine for a
 * single Railway instance. TODO: move to Supabase/Redis if we scale to >1 replica.
 */
interface CallState {
  contactId?: string;
  callType?: "new_lead" | "existing_customer" | "other";
  booked?: boolean;
  appointmentTime?: string;
}
const callState = new Map<string, CallState>();

function stateFor(callId: string): CallState {
  let s = callState.get(callId);
  if (!s) {
    s = {};
    callState.set(callId, s);
  }
  return s;
}

function friendlyTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: env.ghlTimezone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// --- Tool implementations --------------------------------------------------

async function runLookupContact(args: Record<string, unknown>, message: VapiMessage): Promise<string> {
  const phone = (args.phone as string) || callerNumber(message);
  const callId = message.call?.id;
  if (!phone) return "No phone number was available to look up. Please ask the caller for their number.";

  const contact = await findContactByPhone(phone);
  if (!contact) {
    if (callId) stateFor(callId).callType = "new_lead";
    return "No existing customer record was found for this number. Treat them as a new prospect.";
  }

  if (callId) {
    const s = stateFor(callId);
    s.contactId = contact.id;
    s.callType = "existing_customer";
  }

  const name = contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "this customer";
  const tags = contact.tags?.length ? ` Tags: ${contact.tags.join(", ")}.` : "";
  const company = contact.companyName ? ` Building/company: ${contact.companyName}.` : "";
  return `Found an existing customer: ${name}.${company}${tags} Greet them by name and help with their request.`;
}

async function runBookSurvey(args: Record<string, unknown>, message: VapiMessage): Promise<string> {
  const callId = message.call?.id;
  const fullName = (args.fullName as string) || "";
  const phone = (args.phone as string) || callerNumber(message);
  const buildingAddress = (args.buildingAddress as string) || "";
  const buildingName = (args.buildingName as string) || "";
  const issueSummary = (args.issueSummary as string) || "";
  const preferredTime = (args.preferredTime as string) || "";

  // 1) Always capture the lead — this is the part we never want to lose.
  const contact = await upsertContact({
    fullName,
    phone,
    email: args.email as string,
    buildingName,
    buildingAddress,
    tags: ["voice-inbound", "voice-lead", "site-survey-requested"],
  });
  if (callId) {
    const s = stateFor(callId);
    s.contactId = contact.id;
    s.callType = s.callType ?? "new_lead";
  }

  const oppName = `${buildingName || fullName || "Inbound lead"} — site survey`;
  await createOpportunity({ contactId: contact.id, name: oppName }).catch((err) =>
    log.warn("createOpportunity failed", { err: String(err) }),
  );

  // 2) Try to book a real slot from the calendar's availability.
  let bookedTime: string | undefined;
  try {
    const slots = await getFreeSlots(14);
    if (slots.length > 0) {
      const slot = slots[0];
      const appt = await bookAppointment({
        contactId: contact.id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        title: oppName,
        notes: [issueSummary, preferredTime && `Caller preferred: ${preferredTime}`].filter(Boolean).join(" | "),
      });
      bookedTime = appt?.startTime || slot.startTime;
      if (callId) {
        const s = stateFor(callId);
        s.booked = true;
        s.appointmentTime = bookedTime;
      }
    }
  } catch (err) {
    log.warn("Calendar booking failed; lead still captured", { err: String(err) });
  }

  if (bookedTime) {
    return `Booked. The survey is set for ${friendlyTime(bookedTime)}. Confirm this time with the caller and let them know they'll get a text confirmation. If it doesn't work, offer to have the team reschedule.`;
  }
  return "The caller's details and survey request are saved in the CRM. Tell them the team will reach out shortly to confirm the exact survey time — do not invent a specific time.";
}

// --- Message handlers ------------------------------------------------------

export async function handleToolCalls(message: VapiMessage): Promise<VapiToolResults> {
  const results: VapiToolResults["results"] = [];

  for (const call of toolCallsOf(message)) {
    const name = toolName(call);
    const args = toolArgs(call);
    log.info("Tool call", { callId: message.call?.id, tool: name, args });

    let result: string;
    try {
      if (name === TOOL_NAMES.lookupContact) {
        result = await runLookupContact(args, message);
      } else if (name === TOOL_NAMES.bookSurvey) {
        result = await runBookSurvey(args, message);
      } else {
        result = `Unknown tool: ${name}`;
        log.warn("Unknown tool called", { tool: name });
      }
    } catch (err) {
      log.error("Tool execution failed", { tool: name, err: String(err) });
      result =
        "Sorry, I hit a problem completing that just now. Apologize briefly and offer to take the caller's details so the team can follow up.";
    }

    results.push({ toolCallId: call.id, result });
  }

  return { results };
}

export async function handleEndOfCallReport(message: VapiMessage): Promise<void> {
  const callId = message.call?.id ?? `unknown-${Date.now()}`;
  const state = callState.get(callId) ?? {};
  const transcript = message.transcript ?? message.artifact?.transcript ?? "";
  const transferred = (message.endedReason ?? "").toLowerCase().includes("transfer");

  const analysis = await analyzeTranscript(transcript);

  await insertVoiceCall({
    call_id: callId,
    contact_id: state.contactId ?? null,
    campaign_type: "inbound",
    call_type: analysis?.call_type ?? state.callType ?? "other",
    caller_number: callerNumber(message) || null,
    outcome: state.booked ? "booked_survey" : transferred ? "transferred" : "completed",
    ended_reason: message.endedReason ?? null,
    duration_seconds: message.durationSeconds ?? null,
    booked_appointment: !!state.booked,
    appointment_time: state.appointmentTime ?? null,
    transferred_to_human: transferred,
    transcript: transcript || null,
    summary: message.analysis?.summary ?? message.summary ?? null,
    sentiment_score: analysis?.sentiment_score ?? null,
    objections: analysis?.objections ?? null,
    next_best_action: analysis?.next_best_action ?? null,
    recording_url: message.recordingUrl ?? message.artifact?.recordingUrl ?? null,
    raw: message,
  });

  // Tag the contact so GHL automations (e.g. missed-call text-back) can react.
  if (state.contactId) {
    const tag = state.booked ? "voice-booked" : transferred ? "voice-transferred" : "voice-handled";
    await addTags(state.contactId, [tag]).catch((err) => log.warn("addTags failed", { err: String(err) }));
  }

  callState.delete(callId);
  log.info("End-of-call processed", { callId, outcome: state.booked ? "booked" : transferred ? "transferred" : "completed" });
}
