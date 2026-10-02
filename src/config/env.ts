/**
 * Central environment config. Bun auto-loads `.env` (Node: `--env-file=.env`;
 * on Azure App Service the values are app settings / Key Vault references), so
 * we just read `process.env` here, apply sane defaults, and expose typed helpers.
 *
 * The server is designed to BOOT even with missing keys (so the App Service
 * health check passes on first deploy). Feature modules call the `assert*`
 * helpers below and throw a clear error only when an unconfigured feature is used.
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

export type DataBackend = "azure" | "supabase";

/**
 * The Anthropic SDK appends /v1/messages itself, so the base must be
 * ".../anthropic", not ".../anthropic/v1/messages" (the old Railway value —
 * which doubled the path). Normalize either form.
 */
function anthropicBaseUrl(): string {
  return str("ANTHROPIC_BASE_URL")
    .replace(/\/+$/, "")
    .replace(/\/v1(\/messages)?$/, "");
}

/**
 * DATA_BACKEND=azure | supabase. Unset = auto: azure when AZURE_PG_USER is set,
 * otherwise the legacy Supabase project (kept only for the transition — remove
 * once Supabase is decommissioned).
 */
function dataBackend(): DataBackend {
  const v = str("DATA_BACKEND").toLowerCase();
  if (v === "azure" || v === "supabase") return v;
  return str("AZURE_PG_USER") ? "azure" : "supabase";
}

export const env = {
  // Server
  port: num("PORT", 3000),
  serverUrl: str("SERVER_URL"),

  // Database. Production is Azure Database for PostgreSQL (psql-axxiom-marketing
  // / axxiom_hub — the same server + database as axxiommarketinghub, which reads
  // these tables). The app logs in as its managed identity with an Entra token —
  // no password anywhere. Locally, AZURE_PG_USER is your own Entra email (az login).
  dataBackend: dataBackend(),
  azurePgHost: str("AZURE_PG_HOST", "psql-axxiom-marketing.postgres.database.azure.com"),
  azurePgPort: num("AZURE_PG_PORT", 5432),
  azurePgDatabase: str("AZURE_PG_DATABASE", "axxiom_hub"),
  azurePgUser: str("AZURE_PG_USER"),
  // Client id of the user-assigned managed identity (App Service only).
  azurePgClientId: str("AZURE_PG_CLIENT_ID"),
  // Static password + TLS off: ONLY for a local Postgres (dev/tests). Never in Azure.
  azurePgPassword: str("AZURE_PG_PASSWORD"),
  azurePgSsl: str("AZURE_PG_SSL"),
  azurePgPoolMax: num("AZURE_PG_POOL_MAX", 8),

  // Kill switch for everything that places calls (campaign worker, call-now,
  // test calls). Set false on any instance that must NOT dial — e.g. the Azure
  // app during the parallel run, while the old host still owns the campaign.
  // "Never two writers": two dialers against one lead list means double calls.
  dialerEnabled: bool("DIALER_ENABLED", true),

  // Vapi
  vapiApiKey: str("VAPI_API_KEY"),
  // Optional: the org JWT secret from the Vapi dashboard (Org Settings). Lets
  // the analytics page read the remaining Vapi credits — the org endpoint
  // rejects plain API keys.
  vapiJwtSecret: str("VAPI_JWT_SECRET"),
  vapiAssistantId: str("VAPI_ASSISTANT_ID"),
  vapiPhoneNumberId: str("VAPI_PHONE_NUMBER_ID"),
  vapiServerSecret: str("VAPI_SERVER_SECRET"),
  // Fail-closed by default: if VAPI_SERVER_SECRET is unset, /vapi/webhook is
  // refused (503) rather than served open. Set this true ONLY for local dev.
  allowInsecureWebhook: bool("ALLOW_INSECURE_WEBHOOK", false),

  // Twilio — used ONLY by the `import-twilio-numbers` CLI to register your
  // Twilio DIDs in Vapi as caller-ID numbers. The server never dials Twilio
  // itself; Vapi places the calls using the credentials stored at import time.
  twilioAccountSid: str("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: str("TWILIO_AUTH_TOKEN"),

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
  // Per-number frequency cap: max dials to one phone number in a rolling 24h
  // window, across ALL leads that share it (one phone can map to several
  // buildings/leads). Guards against over-calling one person. TCPA-adjacent.
  maxCallsPerNumberPerDay: num("MAX_CALLS_PER_NUMBER_PER_DAY", 3),
  // Data retention: after this many days, call transcripts/recordings/raw
  // payloads are purged by the retention job (structural rows + metrics stay).
  piiRetainDays: num("PII_RETAIN_DAYS", 90),
  outboundLeadTable: str("OUTBOUND_LEAD_TABLE", "lead"),
  outboundCallTable: str("OUTBOUND_CALL_TABLE", "call"),
  outboundSchema: str("OUTBOUND_SCHEMA", "outbound"),
  // Voicemail detection (Vapi's transcription-based provider — see
  // buildOutboundAssistantConfig). ON by default for the campaign: without it,
  // machine answers look like live conversations and reach analytics undercount
  // voicemail to zero. Set false while testing conversations if a live test
  // call ever gets misclassified and dropped.
  enableVoicemailDetection: bool("ENABLE_VOICEMAIL_DETECTION", true),

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
  // Server-side Claude (insights, system analysis, transcript analysis) runs on
  // Azure AI Foundry: ANTHROPIC_BASE_URL = the resource's Anthropic endpoint,
  // ANTHROPIC_API_KEY = the Foundry key, ANTHROPIC_MODEL = a Foundry DEPLOYMENT
  // name. Unset base URL = api.anthropic.com (local dev only).
  anthropicApiKey: str("ANTHROPIC_API_KEY"),
  anthropicBaseUrl: anthropicBaseUrl(),
  anthropicModel: str("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  // Where the Vapi voice agents think (pushed into every assistant by the
  // assistant sync — see src/assistant/voiceModel.ts):
  //   anthropic → Vapi calls Anthropic itself (outside Azure)
  //   foundry   → Vapi → this app's relay (/vapi/llm) → Azure AI Foundry
  voiceProvider: (str("VOICE_PROVIDER", "anthropic").toLowerCase() === "foundry" ? "foundry" : "anthropic") as
    | "anthropic"
    | "foundry",
  // The model / Foundry deployment for the voice agents. Separate from
  // ANTHROPIC_MODEL on purpose: changing the analysis deployment must never
  // silently change the live voice agents.
  voiceModel: str(
    "VOICE_MODEL",
    str("VOICE_PROVIDER").toLowerCase() === "foundry" ? "gpt-5.6-terra" : "claude-sonnet-4-6",
  ),
  // Foundry's OpenAI-compatible endpoint (the voice relay) + its key. The key is
  // the same Foundry key as ANTHROPIC_API_KEY unless FOUNDRY_API_KEY is set.
  foundryOpenAiUrl: str("FOUNDRY_OPENAI_URL", "https://axxiom-ai.openai.azure.com/openai/v1").replace(/\/+$/, ""),
  foundryApiKey: str("FOUNDRY_API_KEY") || str("ANTHROPIC_API_KEY"),
  enableTranscriptAnalysis: bool("ENABLE_TRANSCRIPT_ANALYSIS", false),
  // Per-campaign transcript analysis runs automatically every N ended calls
  // (and on demand). Produces an improvement report + a proposed improved prompt.
  insightEveryNCalls: num("INSIGHT_EVERY_N_CALLS", 25),
  // How many of the brand's most recent ended calls each analysis reads.
  insightCallsLimit: num("INSIGHT_CALLS_LIMIT", 50),

  // Supabase — legacy backend (DATA_BACKEND=supabase), transition only.
  supabaseUrl: str("SUPABASE_URL"),
  supabaseServiceRoleKey: str("SUPABASE_SERVICE_ROLE_KEY"),
  voiceCallTable: str("VOICE_CALL_TABLE", "ax_voice_call"),

  // Dashboard auth. Operators sign in with email + password (accounts in
  // outbound.dashboard_user, provisioned invite-only via `bun run dashboard-user`);
  // the session is an HMAC-signed, httpOnly cookie. The secret must be >= 32
  // characters — anything shorter is treated as unset and auth fails closed.
  dashboardSessionSecret: str("DASHBOARD_SESSION_SECRET"),
  // Session lifetime; renewed while the operator is active (sliding).
  dashboardSessionHours: num("DASHBOARD_SESSION_HOURS", 12),
  // Where the built dashboard (Next.js static export) lives; served at "/".
  dashboardDir: str("DASHBOARD_DIR", "public"),
  // Extra allowed cross-origin dashboard origins (comma-separated). Normally
  // EMPTY: the dashboard is served by this service, so it is same-origin.
  dashboardOrigin: str("DASHBOARD_ORIGIN"),

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

/** True when the active data backend has what it needs to connect. */
export function databaseConfigured(): boolean {
  if (env.dataBackend === "azure") return Boolean(env.azurePgUser);
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}

export function assertDatabase(): void {
  if (env.dataBackend === "azure") {
    require({ AZURE_PG_USER: env.azurePgUser });
    return;
  }
  require({
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: env.supabaseServiceRoleKey,
  });
}

/** The session-signing secret, or "" when unset/too short (auth then fails closed). */
export function sessionSecret(): string {
  return env.dashboardSessionSecret.length >= 32 ? env.dashboardSessionSecret : "";
}

export function assertVapi(): void {
  require({ VAPI_API_KEY: env.vapiApiKey });
}

export function assertTwilio(): void {
  require({
    VAPI_API_KEY: env.vapiApiKey,
    TWILIO_ACCOUNT_SID: env.twilioAccountSid,
    TWILIO_AUTH_TOKEN: env.twilioAuthToken,
  });
}

export function assertOutbound(): void {
  require({
    VAPI_API_KEY: env.vapiApiKey,
    VAPI_PHONE_NUMBER_ID: env.vapiPhoneNumberId,
    OUTBOUND_ASSISTANT_ID: env.outboundAssistantId,
  });
  assertDatabase();
}

export function assertAnthropic(): void {
  require({ ANTHROPIC_API_KEY: env.anthropicApiKey });
}

/** Log a one-time summary at boot of which features are wired up. */
export function logConfigSummary(log: (msg: string) => void): void {
  const ready = (ok: boolean) => (ok ? "ready" : "NOT configured");
  log(`Config — GHL: ${ready(!!env.ghlAccessToken && !!env.ghlLocationId)}`);
  log(
    `Config — Database: ${env.dataBackend} ${ready(databaseConfigured())}` +
      (env.dataBackend === "azure"
        ? ` (${env.azurePgHost}/${env.azurePgDatabase} as ${env.azurePgUser || "?"}, ${
            env.azurePgPassword ? "static password" : "Entra token"
          })`
        : ""),
  );
  log(`Config — Dashboard auth: ${ready(!!sessionSecret())}${sessionSecret() ? "" : " (DASHBOARD_SESSION_SECRET, >= 32 chars)"}`);
  log(`Config — Dialer: ${env.dialerEnabled ? "enabled" : "DISABLED on this instance (DIALER_ENABLED=false)"}`);
  log(`Config — Vapi webhook secret: ${ready(!!env.vapiServerSecret)}`);
  log(
    `Config — Voice agents' model: ${env.voiceModel} via ${
      env.voiceProvider === "foundry" ? `Azure AI Foundry relay (${env.foundryOpenAiUrl})` : "Anthropic (through Vapi)"
    }`,
  );
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
