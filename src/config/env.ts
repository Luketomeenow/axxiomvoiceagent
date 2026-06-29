/**
 * Central environment config. Bun auto-loads `.env`, so we just read
 * `process.env` here, apply sane defaults, and expose typed helpers.
 *
 * The server is designed to BOOT even with missing keys (so Railway health
 * checks pass on first deploy). Feature modules call the `assert*` helpers
 * below and throw a clear error only when an unconfigured feature is used.
 */

function str(key: string, fallback = ""): string {
  return (process.env[key] ?? "").trim() || fallback;
}

function bool(key: string, fallback = false): boolean {
  const v = (process.env[key] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

function num(key: string, fallback: number): number {
  const v = Number((process.env[key] ?? "").trim());
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const env = {
  // Server
  port: num("PORT", 3000),
  serverUrl: str("SERVER_URL"),

  // Vapi
  vapiApiKey: str("VAPI_API_KEY"),
  vapiAssistantId: str("VAPI_ASSISTANT_ID"),
  vapiPhoneNumberId: str("VAPI_PHONE_NUMBER_ID"),
  vapiServerSecret: str("VAPI_SERVER_SECRET"),

  // Outbound campaign (separate assistant + dialer)
  outboundAssistantId: str("OUTBOUND_ASSISTANT_ID"),
  outboundTimezone: str("OUTBOUND_TIMEZONE", "America/Los_Angeles"),
  callWindowStart: num("CALL_WINDOW_START", 8),
  callWindowEnd: num("CALL_WINDOW_END", 21),
  maxConcurrentCalls: num("MAX_CONCURRENT_CALLS", 1),
  maxCallAttempts: num("MAX_CALL_ATTEMPTS", 3),
  // Don't re-dial a no-answer/voicemail lead before this many minutes elapse
  // (avoids back-to-back harassment dials within the same calling window).
  retryBackoffMinutes: num("RETRY_BACKOFF_MINUTES", 60),
  outboundLeadTable: str("OUTBOUND_LEAD_TABLE", "lead"),
  outboundCallTable: str("OUTBOUND_CALL_TABLE", "call"),
  outboundSchema: str("OUTBOUND_SCHEMA", "outbound"),
  // Voicemail detection misclassifies live humans (esp. with background noise)
  // and hangs up. Off by default so test calls don't drop; enable for the campaign.
  enableVoicemailDetection: bool("ENABLE_VOICEMAIL_DETECTION", false),

  // GoHighLevel
  ghlAccessToken: str("GHL_ACCESS_TOKEN") || str("GHL_API_KEY"),
  ghlLocationId: str("GHL_LOCATION_ID"),
  ghlCalendarId: str("GHL_CALENDAR_ID"),
  ghlPipelineId: str("GHL_PIPELINE_ID"),
  ghlPipelineStageId: str("GHL_PIPELINE_STAGE_ID"),
  ghlTimezone: str("GHL_TIMEZONE", "America/New_York"),

  // Transfer / safety
  transferPhoneNumber: str("TRANSFER_PHONE_NUMBER"),
  emergencyInstruction: str("EMERGENCY_INSTRUCTION", "hang up and dial 911"),

  // Voice + LLM
  elevenLabsVoiceId: str("ELEVENLABS_VOICE_ID"),
  // Optional: lets the dashboard list your ElevenLabs account voices to switch
  // between them. The voice itself is keyed in the Vapi dashboard for calls;
  // this key is only used to fetch the voice catalog + previews.
  elevenLabsApiKey: str("ELEVENLABS_API_KEY"),
  // POC: an ElevenLabs Conversational AI agent to evaluate side-by-side with Vapi.
  elevenLabsAgentId: str("ELEVENLABS_AGENT_ID"),
  anthropicApiKey: str("ANTHROPIC_API_KEY"),
  anthropicModel: str("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  enableTranscriptAnalysis: bool("ENABLE_TRANSCRIPT_ANALYSIS", false),

  // Supabase
  supabaseUrl: str("SUPABASE_URL"),
  supabaseServiceRoleKey: str("SUPABASE_SERVICE_ROLE_KEY"),
  voiceCallTable: str("VOICE_CALL_TABLE", "ax_voice_call"),

  // Business config (prompt)
  companyName: str("COMPANY_NAME", "Axxiom Elevator"),
  agentName: str("AGENT_NAME", "Alex"),
  serviceArea: str("SERVICE_AREA", "the local metro area"),
  businessHours: str("BUSINESS_HOURS", "Monday through Friday, 8 AM to 5 PM"),
  bookingType: str("BOOKING_TYPE", "a free, no-obligation site survey"),
};

export type Env = typeof env;

/** Throw if any of the given env keys are empty. */
function require(features: Record<string, string>): void {
  const missing = Object.entries(features)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }
}

export function assertGhl(): void {
  require({
    GHL_ACCESS_TOKEN: env.ghlAccessToken,
    GHL_LOCATION_ID: env.ghlLocationId,
  });
}

export function assertSupabase(): void {
  require({
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: env.supabaseServiceRoleKey,
  });
}

export function assertVapi(): void {
  require({ VAPI_API_KEY: env.vapiApiKey });
}

export function assertOutbound(): void {
  require({
    VAPI_API_KEY: env.vapiApiKey,
    VAPI_PHONE_NUMBER_ID: env.vapiPhoneNumberId,
    OUTBOUND_ASSISTANT_ID: env.outboundAssistantId,
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: env.supabaseServiceRoleKey,
  });
}

export function assertAnthropic(): void {
  require({ ANTHROPIC_API_KEY: env.anthropicApiKey });
}

/** Log a one-time summary at boot of which features are wired up. */
export function logConfigSummary(log: (msg: string) => void): void {
  const ready = (ok: boolean) => (ok ? "ready" : "NOT configured");
  log(`Config — GHL: ${ready(!!env.ghlAccessToken && !!env.ghlLocationId)}`);
  log(`Config — Supabase: ${ready(!!env.supabaseUrl && !!env.supabaseServiceRoleKey)}`);
  log(`Config — Vapi webhook secret: ${ready(!!env.vapiServerSecret)}`);
  log(`Config — Transfer number: ${ready(!!env.transferPhoneNumber)}`);
  log(
    `Config — Outbound: ${ready(
      !!env.vapiApiKey && !!env.vapiPhoneNumberId && !!env.outboundAssistantId,
    )} (window ${env.callWindowStart}-${env.callWindowEnd} ${env.outboundTimezone}, concurrency ${env.maxConcurrentCalls})`,
  );
  log(
    `Config — Transcript analysis: ${
      env.enableTranscriptAnalysis ? (env.anthropicApiKey ? "on" : "ON but ANTHROPIC_API_KEY missing") : "off"
    }`,
  );
}
