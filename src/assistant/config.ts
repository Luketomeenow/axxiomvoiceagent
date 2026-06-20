/**
 * Builds the full Vapi assistant configuration object. Used by
 * scripts/create-assistant.ts to create/update the assistant via the Vapi API.
 *
 * Layers (per the architecture doc): Deepgram transcriber → Claude brain →
 * ElevenLabs voice, with our tools + this service as the server endpoint.
 */

import { env } from "../config/env.ts";
import { buildFirstMessage, buildSystemPrompt } from "./systemPrompt.ts";
import { buildTools } from "./tools.ts";

export function buildAssistantConfig() {
  const webhookUrl = env.serverUrl ? `${env.serverUrl.replace(/\/$/, "")}/vapi/webhook` : undefined;

  return {
    name: `${env.companyName} — Inbound`,
    firstMessage: buildFirstMessage(),
    // Let the agent speak first when the call connects.
    firstMessageMode: "assistant-speaks-first",

    model: {
      provider: "anthropic",
      model: env.anthropicModel,
      temperature: 0.4,
      messages: [{ role: "system", content: buildSystemPrompt() }],
      tools: buildTools(),
    },

    voice: {
      provider: "11labs",
      voiceId: env.elevenLabsVoiceId || "burt", // TODO: set ELEVENLABS_VOICE_ID
      model: "eleven_turbo_v2_5",
      stability: 0.5,
      similarityBoost: 0.75,
    },

    transcriber: {
      provider: "deepgram",
      model: "nova-2",
      language: "en",
    },

    // Where Vapi sends tool-calls + end-of-call reports.
    server: webhookUrl
      ? { url: webhookUrl, secret: env.vapiServerSecret || undefined }
      : undefined,
    serverMessages: ["tool-calls", "end-of-call-report", "status-update"],

    // Keep calls from running away if something goes wrong.
    maxDurationSeconds: 600,
    silenceTimeoutSeconds: 30,
    backgroundSound: "office",

    // Built-in post-call analysis (summary + structured data) from Vapi itself;
    // our optional Claude pass in src/ai/analyzeTranscript.ts adds to this.
    analysisPlan: {
      summaryPrompt: "Summarize this inbound call in 2-3 sentences: who called, why, and the outcome.",
    },
  };
}
