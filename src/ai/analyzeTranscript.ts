/**
 * Optional post-call analysis with Claude — sentiment, objections,
 * next-best-action, and a clean call-type classification. Gated by
 * ENABLE_TRANSCRIPT_ANALYSIS so it never blocks the core call log.
 */

import Anthropic from "@anthropic-ai/sdk";

import { assertAnthropic, env } from "../config/env.ts";
import { log } from "../lib/logger.ts";

export interface TranscriptAnalysis {
  sentiment_score: number | null; // -1 (negative) .. 1 (positive)
  objections: string[];
  next_best_action: string | null;
  call_type: "new_lead" | "existing_customer" | "other" | null;
}

let anthropic: Anthropic | undefined;

const SYSTEM = `You analyze transcripts of inbound phone calls to an elevator service company.
Return ONLY a JSON object with these keys:
- sentiment_score: number from -1 (frustrated/negative) to 1 (delighted/positive)
- objections: array of short strings naming any concerns or objections the caller raised (empty array if none)
- next_best_action: one short sentence on what the team should do next
- call_type: one of "new_lead", "existing_customer", or "other"
No prose, no markdown — JSON only.`;

export async function analyzeTranscript(transcript: string): Promise<TranscriptAnalysis | null> {
  if (!env.enableTranscriptAnalysis) return null;
  if (!transcript?.trim()) return null;

  try {
    assertAnthropic();
    if (!anthropic) anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

    const res = await anthropic.messages.create({
      model: env.anthropicModel,
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: "user", content: `Transcript:\n\n${transcript}` }],
    });

    const text = res.content.find((b) => b.type === "text")?.text ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as TranscriptAnalysis;
    return {
      sentiment_score: typeof parsed.sentiment_score === "number" ? parsed.sentiment_score : null,
      objections: Array.isArray(parsed.objections) ? parsed.objections : [],
      next_best_action: parsed.next_best_action ?? null,
      call_type: parsed.call_type ?? null,
    };
  } catch (err) {
    log.error("Transcript analysis failed", { err: String(err) });
    return null;
  }
}
