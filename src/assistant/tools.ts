/**
 * Tool (function) schemas exposed to the LLM inside Vapi. When the model calls
 * one, Vapi POSTs a `tool-calls` server message to our webhook; we run it in
 * src/vapi/handlers.ts and return the result.
 */

import { env } from "../config/env.ts";

export const TOOL_NAMES = {
  lookupContact: "lookupContact",
  bookSurvey: "bookSurvey",
} as const;

export const lookupContactTool = {
  type: "function" as const,
  function: {
    name: TOOL_NAMES.lookupContact,
    description:
      "Look up an existing customer in the CRM by phone number (defaults to the caller's number) or email. Use this to confirm an existing customer's identity and pull their account context.",
    parameters: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Phone number to look up. Omit to use the caller's own number.",
        },
        email: { type: "string", description: "Email to look up, if the caller gives one." },
      },
      required: [],
    },
  },
};

export const bookSurveyTool = {
  type: "function" as const,
  function: {
    name: TOOL_NAMES.bookSurvey,
    description:
      "Create the lead in the CRM and book a site survey. Call this once you have at least the caller's name, phone number, and building address, and they've agreed to a survey.",
    parameters: {
      type: "object",
      properties: {
        fullName: { type: "string", description: "Caller's full name." },
        phone: { type: "string", description: "Best callback number." },
        email: { type: "string", description: "Email, if provided." },
        buildingName: { type: "string", description: "Building or property name." },
        buildingAddress: { type: "string", description: "Street address of the building." },
        numberOfElevators: { type: "number", description: "How many elevators at the site." },
        issueSummary: {
          type: "string",
          description: "Short summary of the problem or reason for the survey.",
        },
        preferredTime: {
          type: "string",
          description: "Caller's preferred day/time in plain words, e.g. 'Tuesday afternoon'.",
        },
      },
      required: ["fullName", "phone", "buildingAddress"],
    },
  },
};

/** Vapi built-in transfer tool, wired to the configured human/safety number. */
export function transferCallTool() {
  return {
    type: "transferCall" as const,
    destinations: [
      {
        type: "number" as const,
        number: env.transferPhoneNumber,
        message: "Alright, connecting you to the team now — one moment.",
      },
    ],
  };
}

/** All tools for the assistant. transferCall is only added when a number is set. */
export function buildTools(): unknown[] {
  const tools: unknown[] = [lookupContactTool, bookSurveyTool];
  if (env.transferPhoneNumber) tools.push(transferCallTool());
  return tools;
}
