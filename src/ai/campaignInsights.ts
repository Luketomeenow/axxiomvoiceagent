/**
 * Per-campaign continuous improvement. After every N calls (or on demand) this
 * pulls a batch of that campaign's ended-call transcripts + outcomes and asks
 * Claude for two things:
 *   (a) report          — a detailed, human-readable improvement analysis
 *   (b) suggestedPrompt — a ready-to-paste IMPROVED outbound system prompt
 *
 * The suggested prompt is a *proposal* (self-learning is suggest → human approve
 * → apply, in handlers/routes). Before it can be applied, checkPromptGuardrail
 * verifies it still carries the required compliance language (AI + recorded-line
 * disclosure, consent, opt-out) — a rewrite that drops those is blocked.
 */

import Anthropic from "@anthropic-ai/sdk";

import { assertAnthropic, env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { db } from "../outbound/db.ts";
import { getBrandAssistantId, setBrandPromptOverride } from "../outbound/brandStore.ts";
import { buildOutboundSystemPrompt } from "../assistant/outbound/prompt.ts";
import { buildOutboundAssistantConfig } from "../assistant/outbound/config.ts";
import { defaultBrand, getBrand } from "../assistant/brands.ts";

let anthropic: Anthropic | undefined;

const MAX_TRANSCRIPT_CHARS = 2200; // cap per call so the batch fits the context

export interface GuardrailResult {
  passed: boolean;
  notes: string;
}

/**
 * Compliance guardrail on a proposed system prompt: it must retain the AI +
 * recorded-line disclosure, the consent step, and opt-out/DNC handling. Missing
 * any of these blocks the proposal from being applied (default posture).
 */
export function checkPromptGuardrail(prompt: string): GuardrailResult {
  const p = (prompt ?? "").toLowerCase();
  const missing: string[] = [];
  if (!/\bai\b|a\.i\.|artificial intelligence|virtual assistant/.test(p)) missing.push("AI disclosure");
  if (!p.includes("record")) missing.push("recorded-line disclosure");
  if (!/consent|confirmconsent/.test(p)) missing.push("recording consent");
  if (!/opt.?out|do.?not.?call|dnc/.test(p)) missing.push("opt-out / do-not-call");
  return missing.length
    ? { passed: false, notes: `Proposed prompt is missing required compliance language: ${missing.join(", ")}.` }
    : { passed: true, notes: "All required compliance elements present." };
}

interface BatchCall {
  transcript: string | null;
  disposition: string | null;
  outcome: string | null;
  ended_by: string | null;
  sentiment_score: number | null;
  created_at: string;
}

const SYSTEM = `You are a conversation-quality analyst improving an OUTBOUND phone agent for an elevator service company.
You are given the agent's CURRENT system prompt and a batch of real call transcripts with their outcomes.
Study what actually happens on the calls — where the agent loses people, misses qualification, sounds robotic, mishandles objections, or fails to disclose/gain consent — and return improvements.

Return ONLY a JSON object (no prose, no markdown) with exactly these keys:
- "report": a detailed, plainly-written improvement analysis (multi-paragraph is fine). Cover: what's working, the top failure patterns you see in the transcripts (with brief examples), objection themes, and concrete, specific changes to make.
- "suggestedPrompt": a complete, ready-to-use REPLACEMENT system prompt that applies your improvements. It MUST preserve every compliance rule from the current prompt verbatim in intent: the AI + recorded-line disclosure, calling confirmConsent before qualifying, honoring opt-out/do-not-call immediately, no price/timeline/guarantees, and the anti-manipulation guardrails. Never weaken or remove compliance language.`;

/**
 * Analyze a campaign's recent transcripts and store a campaign_insight proposal.
 * Returns the inserted row id, or null if it couldn't run (no key / too few calls).
 */
export async function analyzeCampaign(
  campaignId: string,
  opts: { limit?: number } = {},
): Promise<{ insightId: string; callsAnalyzed: number; guardrail: GuardrailResult } | null> {
  if (!env.anthropicApiKey) {
    log.warn("campaignInsights: ANTHROPIC_API_KEY not set — skipping analysis", { campaignId });
    return null;
  }
  const limit = opts.limit ?? env.insightEveryNCalls;

  const { data: campaign } = await db()
    .from("campaign")
    .select("id, brand, name")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) return null;
  const brandSlug = (campaign.brand as string | null) ?? null;

  const { data: rows } = await db()
    .from("call")
    .select("transcript, disposition, outcome, ended_by, sentiment_score, created_at")
    .eq("campaign_id", campaignId)
    .eq("status", "ended")
    .not("transcript", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<BatchCall[]>();

  const calls = (rows ?? []).filter((c) => (c.transcript ?? "").trim().length > 0);
  if (calls.length < 3) {
    log.info("campaignInsights: too few transcripts to analyze", { campaignId, have: calls.length });
    return null;
  }

  const brand = brandSlug ? getBrand(brandSlug) ?? defaultBrand() : defaultBrand();
  const currentPrompt = buildOutboundSystemPrompt(brand);

  const transcriptBlock = calls
    .map((c, i) => {
      const t = (c.transcript ?? "").slice(0, MAX_TRANSCRIPT_CHARS);
      return `--- Call ${i + 1} | disposition=${c.disposition ?? "?"} outcome=${c.outcome ?? "?"} endedBy=${c.ended_by ?? "?"} sentiment=${c.sentiment_score ?? "?"} ---\n${t}`;
    })
    .join("\n\n");

  const user = `CURRENT SYSTEM PROMPT:\n"""\n${currentPrompt}\n"""\n\nCALL BATCH (${calls.length} calls):\n${transcriptBlock}`;

  try {
    assertAnthropic();
    if (!anthropic) anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

    const res = await anthropic.messages.create({
      model: env.anthropicModel,
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });

    const text = res.content.find((b) => b.type === "text")?.text ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { report?: string; suggestedPrompt?: string };
    const report = (parsed.report ?? "").trim() || null;
    const suggestedPrompt = (parsed.suggestedPrompt ?? "").trim() || null;

    const guardrail: GuardrailResult = suggestedPrompt
      ? checkPromptGuardrail(suggestedPrompt)
      : { passed: false, notes: "No suggested prompt was produced." };

    const windowFrom = calls[calls.length - 1]?.created_at ?? null;
    const windowTo = calls[0]?.created_at ?? null;

    const { data: inserted, error } = await db()
      .from("campaign_insight")
      .insert({
        campaign_id: campaignId,
        brand: brandSlug,
        calls_analyzed: calls.length,
        window_from: windowFrom,
        window_to: windowTo,
        report,
        suggested_prompt: suggestedPrompt,
        guardrail_passed: guardrail.passed,
        guardrail_notes: guardrail.notes,
        status: "proposed",
        model: env.anthropicModel,
      })
      .select("id")
      .single();

    if (error || !inserted) {
      log.error("campaignInsights: insert failed", { campaignId, err: error?.message });
      return null;
    }
    log.info("campaignInsights: analysis stored", {
      campaignId,
      insightId: inserted.id,
      calls: calls.length,
      guardrailPassed: guardrail.passed,
    });
    return { insightId: inserted.id as string, callsAnalyzed: calls.length, guardrail };
  } catch (err) {
    log.error("campaignInsights: analysis failed", { campaignId, err: String(err) });
    return null;
  }
}

// --- Self-learning: approve/apply + reject -------------------------------

interface InsightRow {
  id: string;
  brand: string | null;
  suggested_prompt: string | null;
  guardrail_passed: boolean | null;
  status: string;
}

async function vapiPatch(path: string, body: unknown): Promise<void> {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vapi PATCH ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * Approve + APPLY a proposed prompt improvement (the human-in-the-loop step).
 * Blocked if the compliance guardrail failed. On success it stores the prompt as
 * the brand's override (survives redeploys) and PATCHes the live Vapi assistant.
 */
export async function applyInsight(
  insightId: string,
  approvedBy?: string,
): Promise<{ ok: boolean; reason?: string; blocked?: boolean }> {
  if (!env.vapiApiKey) return { ok: false, reason: "VAPI_API_KEY not set" };

  const { data } = await db()
    .from("campaign_insight")
    .select("id, brand, suggested_prompt, guardrail_passed, status")
    .eq("id", insightId)
    .maybeSingle<InsightRow>();
  if (!data) return { ok: false, reason: "insight not found" };
  if (data.status === "applied") return { ok: false, reason: "already applied" };
  if (!data.suggested_prompt) return { ok: false, reason: "insight has no suggested prompt" };
  // Guardrail = block: never apply a prompt that dropped a required disclosure.
  if (data.guardrail_passed === false) {
    return { ok: false, blocked: true, reason: "blocked by compliance guardrail — proposed prompt is missing required disclosures" };
  }

  const slug = data.brand ?? "default";
  const brand = data.brand ? getBrand(data.brand) ?? defaultBrand() : defaultBrand();
  const assistantId = (await getBrandAssistantId(slug)) || env.outboundAssistantId;
  if (!assistantId) return { ok: false, reason: `no Vapi assistant id for brand "${slug}"` };

  try {
    // Swap only the system prompt; keep the brand's model/voice/tools intact.
    const cfg = buildOutboundAssistantConfig({ brand, promptOverride: data.suggested_prompt });
    await vapiPatch(`/assistant/${assistantId}`, { model: cfg.model });
    await setBrandPromptOverride(slug, data.suggested_prompt);
    await db()
      .from("campaign_insight")
      .update({
        status: "applied",
        approved_by: approvedBy ?? null,
        approved_at: new Date().toISOString(),
        applied_at: new Date().toISOString(),
      })
      .eq("id", insightId);
    log.info("campaignInsights: applied improvement", { insightId, brand: slug, assistantId });
    return { ok: true };
  } catch (err) {
    log.error("campaignInsights: apply failed", { insightId, err: String(err) });
    return { ok: false, reason: String(err) };
  }
}

/** Reject a proposal (no change to the live agent). */
export async function rejectInsight(insightId: string, by?: string): Promise<{ ok: boolean; reason?: string }> {
  const { error } = await db()
    .from("campaign_insight")
    .update({ status: "rejected", approved_by: by ?? null, approved_at: new Date().toISOString() })
    .eq("id", insightId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
