import type { LogLevel } from "../lib/logger.ts";

/**
 * How loudly to log a call ending, from Vapi's endedReason: carrier/pipeline/
 * account failures are errors (e.g. "twilio-failed-to-connect-call",
 * "pipeline-error-openai-llm-failed", "call.start.error-…"), limits are
 * warnings, and ordinary endings (hung up, no answer, voicemail) are info.
 */
export function endedReasonLevel(reason: string | null | undefined): LogLevel {
  const r = (reason ?? "").toLowerCase();
  if (/error|failed|fault|rejected|unavailable|invalid|not-found|insufficient|blocked/.test(r)) return "error";
  if (/exceeded|closed-websocket|stale-timeout/.test(r)) return "warn";
  return "info";
}
