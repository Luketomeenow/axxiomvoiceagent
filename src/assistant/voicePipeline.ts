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

/**
 * Deepgram nova-3 — latest, low-latency, accurate. `keyterm` boosts recall of
 * our domain vocabulary (proper nouns + jargon the model otherwise mishears),
 * which is the biggest lever for "the bot can't hear me" on real phone audio.
 * (keyterm is the nova-3 equivalent of nova-2's `keywords`.)
 */
export function buildTranscriber() {
  return {
    provider: "deepgram" as const,
    model: "nova-3",
    language: "en",
    keyterm: [
      "Axxiom Elevator",
      "elevator",
      "inspection",
      "overdue inspection",
      "permit",
      "certificate of operation",
      "modernization",
      "site survey",
      "property manager",
      "violation",
      "compliance",
      "decision maker",
    ],
  };
}

/**
 * Respond fast without talking over the caller. Smart (AI) endpointing predicts
 * when they've actually finished; the short waitSeconds trims the dead air Vapi
 * otherwise adds. transcriptionEndpointingPlan is only a fallback if smart
 * endpointing is unavailable.
 */
export function buildStartSpeakingPlan() {
  return {
    // A touch more patience than the floor so we don't clip people mid-thought
    // (the "it can't hear me" complaint is often the bot answering too early).
    waitSeconds: 0.5,
    smartEndpointingPlan: { provider: "livekit" }, // AI endpointing (English)
    transcriptionEndpointingPlan: {
      onPunctuationSeconds: 0.1,
      onNoPunctuationSeconds: 1.5,
      onNumberSeconds: 0.5,
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

/**
 * "On hold" handling via Vapi assistant hooks. If the caller goes quiet (e.g.
 * asked us to hold), check back in 3 times — at ~12s, 24s, and 36s of silence —
 * then end the call politely at ~48s. `triggerResetMode: onUserSpeech` resets
 * the timers the moment they speak, so an engaged caller never hears these.
 */
export function buildIdleHooks() {
  const checkIn = (timeoutSeconds: number, exact: string) => ({
    on: "customer.speech.timeout" as const,
    options: { timeoutSeconds, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" as const },
    do: [{ type: "say" as const, exact }],
  });
  return [
    checkIn(12, "Hey — are you still there?"),
    checkIn(24, "No rush, just making sure I didn't lose you."),
    checkIn(36, "I'll hang on a few more seconds in case you're still there."),
    {
      on: "customer.speech.timeout" as const,
      options: { timeoutSeconds: 48, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" as const },
      do: [
        { type: "say" as const, exact: "Looks like now's not a great time — I'll let you go, and we'll follow up. Take care!" },
        { type: "tool" as const, tool: { type: "endCall" as const } },
      ],
    },
  ];
}
