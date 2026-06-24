/**
 * Builds the full Vapi assistant configuration for the OUTBOUND qualification
 * campaign. Used by scripts/create-outbound-assistant.ts.
 *
 * Same pipeline as inbound (Deepgram → Claude → ElevenLabs) but with the
 * qualification prompt, compliant opener, outbound tools, and live transcript
 * streaming enabled so the dashboard can follow calls in real time.
 */

import { env } from "../../config/env.ts";
import { type Brand, defaultBrand } from "../brands.ts";
import { toE164 } from "../../outbound/phone.ts";
import {
  buildIdleHooks,
  buildStartSpeakingPlan,
  buildStopSpeakingPlan,
  buildTranscriber,
  buildVoice,
} from "../voicePipeline.ts";
import { buildOutboundFirstMessage, buildOutboundSystemPrompt } from "./prompt.ts";
import { buildOutboundTools } from "./tools.ts";

export function buildOutboundAssistantConfig(opts: { brand?: Brand; voiceId?: string } = {}) {
  const brand = opts.brand ?? defaultBrand();
  const webhookUrl = env.serverUrl ? `${env.serverUrl.replace(/\/$/, "")}/vapi/webhook` : undefined;

  return {
    name: `${brand.displayName} — Outbound`,
    firstMessage: buildOutboundFirstMessage(brand),
    firstMessageMode: "assistant-speaks-first",

    model: {
      provider: "anthropic",
      model: env.anthropicModel,
      // Slightly lower than inbound for more consistent qualifying.
      temperature: 0.3,
      // Cap the reply length so completions finish (and start speaking) fast —
      // the prompt already asks for one or two sentences.
      maxTokens: 250,
      messages: [{ role: "system", content: buildOutboundSystemPrompt(brand) }],
      // Warm-transfer to this brand's own human line (normalized to E.164 for Vapi).
      tools: buildOutboundTools(toE164(brand.localPhone) ?? undefined),
    },

    // Shared low-latency pipeline (Flash v2.5 voice, nova-3, smart endpointing).
    // Per-brand voice (dashboard override) wins over the brand registry default.
    voice: buildVoice(opts.voiceId ?? brand.voiceId),
    transcriber: buildTranscriber(),
    startSpeakingPlan: buildStartSpeakingPlan(),
    stopSpeakingPlan: buildStopSpeakingPlan(),
    // Check in if the caller goes quiet (e.g. on hold), then end gracefully.
    hooks: buildIdleHooks(),

    // Outbound should sound clean and clearly disclosed, not like a call center.
    backgroundSound: "off",
    // Filter ambient noise so the transcriber + endpointing behave on real calls.
    backgroundDenoisingEnabled: true,

    server: webhookUrl
      ? { url: webhookUrl, secret: env.vapiServerSecret || undefined }
      : undefined,
    // `transcript` is added so the dashboard can stream the conversation live.
    serverMessages: ["tool-calls", "end-of-call-report", "status-update", "transcript"],

    maxDurationSeconds: 480,
    silenceTimeoutSeconds: 30,
    // Detect voicemail so the dialer can disposition + retry instead of pitching a
    // machine — but it false-positives on live humans, so it's off for testing
    // (ENABLE_VOICEMAIL_DETECTION). `null` clears any existing setting on PATCH.
    voicemailDetection: env.enableVoicemailDetection ? { provider: "vapi" } : null,
    voicemailMessage: `Hi, this is a call from ${brand.displayName} about the elevator inspection at your building. We'll try you again, or you can reach our team during business hours. Thank you.`,
    endCallMessage: "Thanks so much for your time — take care.",

    // Record + transcribe every call (needed for the live dashboard + CIPA audit trail).
    artifactPlan: {
      recordingEnabled: true,
    },

    analysisPlan: {
      summaryPrompt:
        "Summarize this outbound qualification call in 2-3 sentences: who we reached, whether they're the decision maker, their interest level, and the agreed next step.",
      // Pull structured fields for the dashboard / reporting.
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: "object",
          properties: {
            interested: { type: "boolean", description: "Did they express interest in a site survey / help?" },
            decisionMaker: { type: "boolean", description: "Were we speaking with the decision-maker?" },
            currentProvider: { type: "string", description: "Who currently services their elevator, if mentioned." },
            timeline: { type: "string", description: "Rough timeline they mentioned, if any." },
            finalDisposition: {
              type: "string",
              enum: ["qualified", "needs_followup", "not_interested", "remove", "voicemail", "no_answer"],
              description: "Best-fit outcome for this call.",
            },
          },
        },
      },
      // A simple success signal for at-a-glance reporting.
      successEvaluationPlan: {
        rubric: "PassFail",
        // Pass = reached a decision-maker AND agreed a concrete next step (survey/follow-up).
      },
    },
  };
}
