/**
 * System-level AI analysis — reviews the OPERATION, not one brand's prompt.
 * Where campaignInsights.ts improves what the agent says, this reviews how the
 * whole machine performs: reach/deliverability per brand, funnel conversion,
 * failure reasons, best calling hours, cost efficiency, and the dialer's
 * configuration — and produces a prioritized improvement report.
 *
 * Advisory only: there is nothing to auto-apply, so there's no approve/apply
 * workflow or guardrail. Rows share the campaign_insight table with
 * kind='system' (brand + campaign_id null, no suggested_prompt).
 * Triggered on demand from the dashboard (POST /outbound/system/analyze).
 */

import type Anthropic from "@anthropic-ai/sdk";

import { assertAnthropic, env } from "../config/env.ts";
import { anthropicClient } from "./client.ts";
import { log } from "../lib/logger.ts";
import { db } from "../outbound/db.ts";

let anthropic: Anthropic | undefined;

export interface SystemRecommendation {
  area: string; // reach | dialer | lead-data | agent | compliance | cost | analytics
  title: string;
  detail: string;
  impact: "high" | "medium" | "low";
  effort: "low" | "medium" | "high";
}

const SYSTEM = `You are a voice-AI operations analyst reviewing an outbound phone-qualification system for an elevator service company.
The system: a dialer places calls via Vapi (Deepgram STT -> Claude -> ElevenLabs/Vapi TTS) over Twilio, one AI assistant per brand, with compliance guardrails (AI + recording disclosure, consent, DNC, per-timezone calling windows). You are given aggregated operational metrics, NOT transcripts — conversation quality is reviewed separately per brand.

Study the numbers for systemic problems and leverage: connect/reach rates per brand (a brand whose connect rate lags may have a spam-flagged caller ID), machine vs. human answer mix, failure/ended reasons, funnel conversion (contacted -> qualified), best calling hours vs. the configured window, retry/attempt efficiency, cost per call and per qualified lead, lead-data quality (bad numbers, IVR-heavy lists), and anything the config makes worse.

Return ONLY a JSON object (no prose, no markdown) with exactly these keys:
- "report": a detailed, plainly-written operational analysis (multi-paragraph). Lead with the 2-3 highest-leverage problems and quantify them from the data.
- "recommendations": an array of {"area","title","detail","impact","effort"} — area one of reach|dialer|lead-data|agent|compliance|cost|analytics, impact and effort one of high|medium|low. Concrete and specific to THIS data, ordered by impact. 5-10 items.`;

/** Tolerant parse: strip accidental code fences, recover report if truncated. */
function parseReply(raw: string): { report?: string; recommendations?: SystemRecommendation[] } | null {
  let t = (raw ?? "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(t.slice(start, t.lastIndexOf("}") + 1)) as {
      report?: string;
      recommendations?: SystemRecommendation[];
    };
  } catch {
    const m = t.match(/"report"\s*:\s*"((?:[^"\\]|\\.)*)/s);
    if (!m) return null;
    try {
      return { report: JSON.parse(`"${m[1]}"`) as string };
    } catch {
      return { report: m[1] };
    }
  }
}

/** Snapshot of aggregated operational data for the analyst. */
async function gatherMetrics(): Promise<Record<string, unknown>> {
  const [quality, funnel, hourly, reasons, failedOps] = await Promise.all([
    db().from("v_call_quality").select("*"),
    db().from("v_campaign_funnel").select("*"),
    db().from("v_call_hourly").select("*"),
    db()
      .from("call")
      .select("ended_reason")
      .eq("status", "ended")
      .order("created_at", { ascending: false })
      .limit(1000),
    db().from("failed_op").select("id", { count: "exact", head: true }).eq("resolved", false),
  ]);

  // Top ended-reasons across the most recent ~1000 ended calls.
  const reasonTally = new Map<string, number>();
  for (const r of reasons.data ?? []) {
    // Collapse verbose dial-error strings into one bucket.
    const key = ((r.ended_reason as string) ?? "unknown").startsWith("Error:")
      ? "dial-error"
      : ((r.ended_reason as string) ?? "unknown").slice(0, 80);
    reasonTally.set(key, (reasonTally.get(key) ?? 0) + 1);
  }
  const endedReasons = [...reasonTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  return {
    generatedAt: new Date().toISOString(),
    config: {
      voicemailDetection: env.enableVoicemailDetection,
      defaultCallWindow: `${env.callWindowStart}:00-${env.callWindowEnd}:00`,
      defaultTimezone: env.outboundTimezone,
      defaultMaxConcurrent: env.maxConcurrentCalls,
      maxAttemptsPerLead: env.maxCallAttempts,
      retryBackoffMinutes: env.retryBackoffMinutes,
      maxCallsPerNumberPerDay: env.maxCallsPerNumberPerDay,
      model: env.anthropicModel,
    },
    callQualityByBrand: quality.data ?? [],
    campaignFunnels: funnel.data ?? [],
    connectRateByHourPT: hourly.data ?? [],
    topEndedReasons: endedReasons,
    unresolvedFailedWrites: failedOps.count ?? 0,
  };
}

/**
 * Run the system analysis and store a campaign_insight row (kind='system').
 * Returns the inserted row id, or null if it couldn't run.
 */
export async function analyzeSystem(): Promise<{ insightId: string; callsConsidered: number } | null> {
  if (!env.anthropicApiKey) {
    log.warn("systemInsights: ANTHROPIC_API_KEY not set — skipping analysis");
    return null;
  }
  try {
    const metrics = await gatherMetrics();
    const totalCalls = (metrics.callQualityByBrand as Array<{ calls?: number }>).reduce(
      (s, r) => s + (Number(r.calls) || 0),
      0,
    );
    if (totalCalls < 3) {
      log.info("systemInsights: too few calls to analyze", { totalCalls });
      return null;
    }

    assertAnthropic();
    if (!anthropic) anthropic = anthropicClient();
    const res = await anthropic.messages.create({
      model: env.anthropicModel,
      max_tokens: 8192,
      system: SYSTEM,
      messages: [{ role: "user", content: `OPERATIONAL METRICS:\n${JSON.stringify(metrics, null, 1)}` }],
    });

    const text = res.content.find((b) => b.type === "text")?.text ?? "";
    if (res.stop_reason === "max_tokens") log.warn("systemInsights: response hit max_tokens — output truncated");
    const parsed = parseReply(text);
    const report = (parsed?.report ?? "").trim() || null;
    if (!report) {
      log.error("systemInsights: could not parse model reply", { sample: text.slice(0, 200) });
      return null;
    }

    const { data: inserted, error } = await db()
      .from("campaign_insight")
      .insert({
        kind: "system",
        campaign_id: null,
        brand: null,
        calls_analyzed: totalCalls,
        report,
        suggested_prompt: null,
        status: "proposed",
        model: env.anthropicModel,
        raw: { recommendations: parsed?.recommendations ?? [] },
      })
      .select("id")
      .single();
    if (error || !inserted) {
      log.error("systemInsights: insert failed", { err: error?.message });
      return null;
    }
    log.info("systemInsights: analysis stored", { insightId: inserted.id, totalCalls });
    return { insightId: inserted.id as string, callsConsidered: totalCalls };
  } catch (err) {
    log.error("systemInsights: analysis failed", { err: String(err) });
    return null;
  }
}
