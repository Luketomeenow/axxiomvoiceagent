/**
 * Builds the full Vapi assistant configuration for the OUTBOUND qualification
 * campaign. Used by scripts/create-outbound-assistant.ts.
 *
 * Same pipeline as inbound (Deepgram → Claude → ElevenLabs) but with the
 * qualification prompt, compliant opener, outbound tools, and live transcript
 * streaming enabled so the dashboard can follow calls in real time.
 */

import { env } from "../../config/env.ts";
import { buildOutboundFirstMessage, buildOutboundSystemPrompt } from "./prompt.ts";
import { buildOutboundTools } from "./tools.ts";

export function buildOutboundAssistantConfig() {
  const webhookUrl = env.serverUrl ? `${env.serverUrl.replace(/\/$/, "")}/vapi/webhook` : undefined;

  return {
    name: `${env.companyName} — Outbound Qualification`,
    firstMessage: buildOutboundFirstMessage(),
    firstMessageMode: "assistant-speaks-first",

    model: {
      provider: "anthropic",
      model: env.anthropicModel,
      // Slightly lower than inbound for more consistent qualifying.
      temperature: 0.3,
      messages: [{ role: "system", content: buildOutboundSystemPrompt() }],
      tools: buildOutboundTools(),
    },

    voice: {
      provider: "11labs",
      voiceId: env.elevenLabsVoiceId || "burt",
      model: "eleven_turbo_v2_5",
      stability: 0.5,
      similarityBoost: 0.8,
      useSpeakerBoost: true,
      // Trade a touch of quality for lower latency — matters on cold calls.
      optimizeStreamingLatency: 3,
    },

    transcriber: {
      provider: "deepgram",
      model: "nova-2",
      language: "en",
    },

    // Turn-taking: wait a beat so we don't talk over their "Hello?", and use
    // smart endpointing for more accurate detection of when they've finished.
    startSpeakingPlan: {
      waitSeconds: 0.6,
      smartEndpointingPlan: { provider: "livekit" },
    },
    // Require a couple of words before the agent yields, so background noise /
    // short backchannel ("uh huh") doesn't constantly cut it off.
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.3,
      backoffSeconds: 1,
    },
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
    voicemailMessage:
      "Hi, this is a call from Axxiom Elevator about the elevator inspection at your building. We'll try you again, or you can reach our team during business hours. Thank you.",
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
