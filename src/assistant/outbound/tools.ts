/**
 * Tool (function) schemas for the OUTBOUND qualification assistant. When the
 * model calls one, Vapi POSTs a `tool-calls` server message to our webhook; we
 * run it in src/vapi/handlers.ts and update the lead in the outbound schema.
 */

import { env } from "../../config/env.ts";

export const OUTBOUND_TOOL_NAMES = {
  qualifyLead: "qualifyLead",
  recordDisposition: "recordDisposition",
  optOut: "optOut",
  lookupViolationCode: "lookupViolationCode",
} as const;

export const lookupViolationCodeTool = {
  type: "function" as const,
  function: {
    name: OUTBOUND_TOOL_NAMES.lookupViolationCode,
    description:
      "Look up the official, verified meaning of an elevator compliance topic OR a specific code in our reference database. ALWAYS call this before explaining what an overdue inspection / expired permit means, what the law requires, or a code the caller cites — never guess or invent meanings. Returns the plain-English summary, severity, and typical remedy, or tells you it's not found (then say the team will confirm the details).",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "A compliance topic or code to verify. Topics: 'overdue inspection', 'expired permit', 'permit to operate'. Codes: e.g. '3.10.4' or 'A17.1 2.7.6'. Pass what's relevant to what was said.",
        },
      },
      required: ["code"],
    },
  },
};

export const qualifyLeadTool = {
  type: "function" as const,
  function: {
    name: OUTBOUND_TOOL_NAMES.qualifyLead,
    description:
      "Save what you learned while qualifying this lead. Call this once you understand whether they're the decision-maker and whether they're interested in a site survey.",
    parameters: {
      type: "object",
      properties: {
        interested: { type: "boolean", description: "Are they interested in Axxiom's help / a site survey?" },
        decisionMaker: {
          type: "boolean",
          description: "Is this person responsible for elevator service/maintenance decisions?",
        },
        currentProvider: { type: "string", description: "Who currently services their elevator(s), if mentioned." },
        bestCallbackName: { type: "string", description: "Name of the right contact, if it's not this person." },
        bestCallbackPhone: { type: "string", description: "Best callback number, if provided." },
        bestCallbackEmail: { type: "string", description: "Email, if provided." },
        timeline: { type: "string", description: "Rough timeline in plain words, e.g. 'next month'." },
        notes: { type: "string", description: "Any other useful context from the conversation." },
      },
      required: ["interested"],
    },
  },
};

export const recordDispositionTool = {
  type: "function" as const,
  function: {
    name: OUTBOUND_TOOL_NAMES.recordDisposition,
    description:
      "Set the final outcome for this lead before the call ends. Always call this exactly once near the end of the call.",
    parameters: {
      type: "object",
      properties: {
        disposition: {
          type: "string",
          enum: ["qualified", "needs_followup", "not_interested", "remove"],
          description:
            "qualified = interested, wants survey/follow-up; needs_followup = interested but reach someone else or call back; not_interested = not now but keep on file; remove = wrong number / no longer involved / take off the list.",
        },
        notes: { type: "string", description: "One-line reason for the disposition." },
      },
      required: ["disposition"],
    },
  },
};

export const optOutTool = {
  type: "function" as const,
  function: {
    name: OUTBOUND_TOOL_NAMES.optOut,
    description:
      "Call this immediately if the person asks not to be called again, declines the recorded call, or requests removal from the list. This adds them to the do-not-call suppression list.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason, e.g. 'requested do not call'." },
      },
      required: [],
    },
  },
};

/** Vapi built-in transfer tool, wired to the configured human number. */
export function transferToHumanTool() {
  return {
    type: "transferCall" as const,
    destinations: [
      {
        type: "number" as const,
        number: env.transferPhoneNumber,
        message: "Sure — let me connect you with someone on the team now, one moment.",
      },
    ],
  };
}

/**
 * Vapi built-in end-call tool, so the agent can hang up cleanly itself after
 * dispositioning or an opt-out instead of waiting for the caller to drop.
 */
export function endCallTool() {
  return { type: "endCall" as const };
}

/** All outbound tools. transferCall is only added when a number is configured. */
export function buildOutboundTools(): unknown[] {
  const tools: unknown[] = [
    qualifyLeadTool,
    recordDispositionTool,
    optOutTool,
    lookupViolationCodeTool,
    endCallTool(),
  ];
  if (env.transferPhoneNumber) tools.push(transferToHumanTool());
  return tools;
}
