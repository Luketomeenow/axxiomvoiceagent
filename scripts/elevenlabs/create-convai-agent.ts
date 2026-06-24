/**
 * POC: create (or update) an ElevenLabs Conversational AI agent that mirrors the
 * outbound qualification agent — so we can compare it side-by-side with Vapi.
 *
 *   bun run create-convai-agent          (or: npm run create-convai-agent:node)
 *
 * Isolated from the Vapi setup: this only touches ElevenLabs and prints an
 * ELEVENLABS_AGENT_ID to add to .env. Re-running with that id set PATCHes it.
 * Needs ELEVENLABS_API_KEY (Conversational AI enabled).
 */

import { env } from "../../src/config/env.ts";
import { buildOutboundFirstMessage, buildOutboundSystemPrompt } from "../../src/assistant/outbound/prompt.ts";

const EL = "https://api.elevenlabs.io/v1";

// The Vapi prompt uses {{vars}} injected per-call. For a standalone POC agent we
// substitute readable defaults so nothing renders as a literal "{{...}}".
const VAR_DEFAULTS: Record<string, string> = {
  contactName: "there",
  buildingName: "your building",
  address: "",
  city: "",
  humanProblem: "an overdue State elevator inspection",
  lastInspectionDate: "on file",
  certStatus: "the certificate of operation on file has expired",
  oemMatch: "unknown",
  violationCodes: "",
  violationDetails: "",
  violationCount: "0",
  inspectionType: "State",
};

function fill(text: string): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => VAR_DEFAULTS[k] ?? "");
}

async function el(path: string, method: string, body?: unknown) {
  const res = await fetch(EL + path, {
    method,
    headers: { "xi-api-key": env.elevenLabsApiKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`ElevenLabs ${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 600)}`);
  return json;
}

/** Use the configured voice if it actually exists on this account, else the first one. */
async function resolveVoiceId(): Promise<string> {
  const voices = (await el("/voices", "GET")) as { voices?: Array<{ voice_id?: string; name?: string }> };
  const list = voices.voices ?? [];
  if (!list.length) throw new Error("No ElevenLabs voices found on the account.");
  if (env.elevenLabsVoiceId && list.some((v) => v.voice_id === env.elevenLabsVoiceId)) {
    return env.elevenLabsVoiceId;
  }
  if (env.elevenLabsVoiceId) {
    console.warn(`⚠️  ELEVENLABS_VOICE_ID (${env.elevenLabsVoiceId}) isn't on this account — using "${list[0].name}" instead.`);
  }
  return list[0].voice_id as string;
}

async function main() {
  if (!env.elevenLabsApiKey) {
    console.error("ELEVENLABS_API_KEY is not set in .env");
    process.exit(1);
  }

  const voiceId = await resolveVoiceId();
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();

  const conversation_config = {
    agent: {
      first_message: fill(buildOutboundFirstMessage()),
      language: "en",
      prompt: {
        prompt: fill(buildOutboundSystemPrompt()),
      },
    },
    tts: {
      voice_id: voiceId,
      // Convai requires flash/turbo v2 for English agents (not v2_5).
      model_id: "eleven_flash_v2",
    },
  };

  const payload = { name: `${env.companyName} — Outbound (ElevenLabs POC)`, conversation_config };

  if (agentId) {
    console.log(`Updating ElevenLabs agent ${agentId}…`);
    await el(`/convai/agents/${agentId}`, "PATCH", payload);
    console.log("✅ Updated. Voice:", voiceId);
  } else {
    console.log("Creating ElevenLabs Conversational AI agent…");
    const created = (await el("/convai/agents/create", "POST", payload)) as { agent_id?: string };
    console.log(`✅ Created agent: ${created.agent_id}`);
    console.log(`   Add to .env:  ELEVENLABS_AGENT_ID=${created.agent_id}`);
    console.log(`   Voice: ${voiceId}`);
    console.log("\nTest it now in the ElevenLabs dashboard → Agents → this agent → Test.");
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
