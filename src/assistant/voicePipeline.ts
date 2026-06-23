/**
 * Shared low-latency voice pipeline for both assistants (inbound + outbound).
 *
 * The single biggest levers for "fast + realistic" on Vapi:
 *  - TTS model: ElevenLabs Flash v2.5 (~75ms) vs Turbo v2.5 (~300ms).
 *  - Turn-taking: Vapi's default endpointing adds ~1.5s; smart (AI) endpointing
 *    + a short waitSeconds responds quickly without clipping the caller.
 *  - Interruptibility: a low stopSpeakingPlan so the agent yields the moment the
 *    human really talks (feels human), while ignoring pure noise/backchannel.
 *
 * Keeping these in one place means both assistants stay tuned the same way.
 * Re-run `create-assistant` / `create-outbound-assistant` after changing them.
 */

import { env } from "../config/env.ts";

/**
 * ElevenLabs Flash v2.5 — lowest-latency model, tuned for a warm, natural,
 * consistent phone voice. Lower stability = a touch more expressive/human; a
 * little style adds warmth without much latency or instability.
 */
export function buildVoice() {
  return {
    provider: "11labs" as const,
    voiceId: env.elevenLabsVoiceId || "burt",
    model: "eleven_flash_v2_5",
    stability: 0.45,
    similarityBoost: 0.75,
    style: 0.3,
    useSpeakerBoost: true,
    // Modest streaming optimization — Flash is already fast, so we don't crank
    // this (high values hurt pronunciation).
    optimizeStreamingLatency: 2,
  };
}

/** Deepgram nova-3 — latest, low-latency, accurate (fewer re-prompts = feels faster). */
export function buildTranscriber() {
  return { provider: "deepgram" as const, model: "nova-3", language: "en" };
}

/**
 * Respond fast without talking over the caller. Smart (AI) endpointing predicts
 * when they've actually finished; the short waitSeconds trims the dead air Vapi
 * otherwise adds. transcriptionEndpointingPlan is only a fallback if smart
 * endpointing is unavailable.
 */
export function buildStartSpeakingPlan() {
  return {
    waitSeconds: 0.4,
    smartEndpointingPlan: { provider: "livekit" }, // AI endpointing (English)
    transcriptionEndpointingPlan: {
      onPunctuationSeconds: 0.1,
      onNoPunctuationSeconds: 1.3,
      onNumberSeconds: 0.4,
    },
  };
}

/**
 * Let the caller barge in naturally. numWords:1 yields on a real word (not pure
 * VAD noise), with quick recovery — feels human without constant cut-offs from
 * background sound or short "uh huh" backchannel.
 */
export function buildStopSpeakingPlan() {
  return { numWords: 1, voiceSeconds: 0.2, backoffSeconds: 0.8 };
}
