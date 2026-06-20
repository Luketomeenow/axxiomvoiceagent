/**
 * Minimal types for the Vapi server messages we consume. Vapi wraps every
 * webhook in `{ message: { type, ... } }`. We model only the fields we use and
 * stay permissive about the rest (shapes shift across Vapi versions).
 */

export interface VapiCall {
  id?: string;
  assistantId?: string;
  customer?: { number?: string };
  phoneNumber?: { number?: string };
  metadata?: Record<string, unknown>;
}

export interface VapiToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
  // some payloads nest the same fields one level up
  name?: string;
  arguments?: string | Record<string, unknown>;
}

export interface VapiMessage {
  type: string;
  call?: VapiCall;
  customer?: { number?: string };
  assistantId?: string;

  // tool-calls
  toolCalls?: VapiToolCall[];
  toolCallList?: VapiToolCall[];

  // status-update
  status?: string;

  // transcript (live)
  role?: string; // "assistant" | "user"
  transcriptType?: string; // "partial" | "final"

  // end-of-call-report
  endedReason?: string;
  durationSeconds?: number;
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
  artifact?: { transcript?: string; recordingUrl?: string; messages?: unknown[] };
  analysis?: { summary?: string; structuredData?: Record<string, unknown> };
}

/** Pull per-call metadata we attach when placing outbound calls. */
export function callMetadata(message: VapiMessage): Record<string, unknown> {
  return (message.call?.metadata ?? {}) as Record<string, unknown>;
}

export interface VapiWebhookBody {
  message: VapiMessage;
}

/** Vapi expects tool results in this exact shape. */
export interface VapiToolResults {
  results: Array<{ toolCallId: string; result: string }>;
}

/** Pull the caller's phone number from whichever field carries it. */
export function callerNumber(message: VapiMessage): string {
  return message.call?.customer?.number ?? message.customer?.number ?? "";
}

/** Normalize the tool-call list across payload variants. */
export function toolCallsOf(message: VapiMessage): VapiToolCall[] {
  return message.toolCalls ?? message.toolCallList ?? [];
}

/** Tool args may arrive as a JSON string or an object. */
export function toolArgs(call: VapiToolCall): Record<string, unknown> {
  const raw = call.function?.arguments ?? call.arguments ?? {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

export function toolName(call: VapiToolCall): string {
  return call.function?.name ?? call.name ?? "";
}
