/**
 * Hono routes for the outbound campaign, consumed by the Next.js dashboard:
 *   GET  /outbound/campaigns          list campaigns + live counts
 *   GET  /outbound/stats              disposition breakdown
 *   POST /outbound/campaign/start     mark a campaign running + start the worker
 *   POST /outbound/campaign/pause     pause campaigns + stop the worker
 *   POST /outbound/campaign/:id/update   rename / re-region a campaign
 *   POST /outbound/campaign/:id/delete   delete a campaign + its leads
 *   GET  /outbound/voices             list ElevenLabs voices + current selection
 *   POST /outbound/voice              switch the outbound assistant's voice
 *   POST /outbound/call-now/:leadId   manually dial one lead
 *   POST /outbound/test-call          dial an arbitrary number to test the agent
 *   GET  /outbound/export             download leads as csv/xlsx by disposition
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import * as XLSX from "xlsx";

import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { requireAuth } from "../lib/auth.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { maskPhone } from "../lib/redact.ts";

// Reject uploads larger than this (leads workbooks are small; this bounds abuse).
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
import {
  autoAssignCampaignBrand,
  callNow,
  endCall,
  startCampaignWorker,
  stopCampaignWorker,
  testCall,
  type TestCallInput,
} from "./dialer.ts";
import { db, deleteLeadDataByPhone, purgeOldPii, replayFailedOps } from "./db.ts";
import { campaignWindowStatus } from "./windowStatus.ts";
import { toE164 } from "./phone.ts";
import { syncTwilioCosts } from "./twilioSync.ts";
import { guessCampaignReadySheet, importLeads, listSheets } from "./import.ts";
import { getCurrentVoices, listElevenLabsVoices, setAgentVoice, type VoiceTarget } from "./voice.ts";
import { BRANDS, getBrand } from "../assistant/brands.ts";
import { analyzeCampaign, applyInsight, rejectInsight } from "../ai/campaignInsights.ts";

export const outbound = new Hono();

// CORS locked to the dashboard origin(s) (DASHBOARD_ORIGIN, comma-separated).
// Empty = no cross-origin allowed (fail closed) — set it in production.
const allowedOrigins = env.dashboardOrigin
  ? env.dashboardOrigin.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// Order matters: CORS first (so preflight gets headers + downstream lets OPTIONS
// through), then rate limit (cheap, in front of the auth network call), then
// auth on every /outbound/* request.
outbound.use(
  "/outbound/*",
  cors({
    origin: allowedOrigins,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  }),
);
outbound.use("/outbound/*", rateLimit({ windowMs: 60_000, max: 120 }));
outbound.use("/outbound/*", requireAuth);

outbound.get("/outbound/campaigns", async (c) => {
  const { data, error } = await db().from("campaign").select("*").order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ campaigns: data ?? [] });
});

// Distinct servicing brands present in the leads (for the export brand picker),
// each with a lead count. Optionally scoped to one campaign.
outbound.get("/outbound/brands", async (c) => {
  const campaignId = c.req.query("campaignId");
  let q = db().from("lead").select("servicing_brand");
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const brand = (row as { servicing_brand: string | null }).servicing_brand?.trim();
    if (brand) counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }
  const brands = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ brands, total: data?.length ?? 0 });
});

outbound.get("/outbound/stats", async (c) => {
  const campaignId = c.req.query("campaignId");
  let q = db().from("lead").select("disposition");
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const d = (row as { disposition: string }).disposition || "new";
    counts[d] = (counts[d] ?? 0) + 1;
  }
  return c.json({ counts, total: data?.length ?? 0 });
});

// --- Analytics (tracking dashboard) ---------------------------------------
// Reads the pre-aggregated views (outbound.v_*) so the dashboard pulls small
// result sets instead of every lead/call. All scoped to one campaign via
// ?campaignId; the daily series honors ?days (default 30).

outbound.get("/outbound/analytics", async (c) => {
  const campaignId = c.req.query("campaignId");
  const days = Math.min(180, Math.max(1, Number(c.req.query("days")) || 30));
  // Cutoff date (YYYY-MM-DD) for the daily series.
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const funnelQ = db().from("v_campaign_funnel").select("*");
  const qualityQ = db().from("v_call_quality").select("*");
  const dailyQ = db().from("v_daily_metrics").select("*").gte("day", cutoff).order("day", { ascending: true });
  const attemptsQ = db().from("v_attempt_distribution").select("*").order("attempts", { ascending: true });

  const [funnel, quality, daily, attempts, deadLetters] = await Promise.all([
    campaignId ? funnelQ.eq("campaign_id", campaignId) : funnelQ,
    campaignId ? qualityQ.eq("campaign_id", campaignId) : qualityQ,
    campaignId ? dailyQ.eq("campaign_id", campaignId) : dailyQ,
    campaignId ? attemptsQ.eq("campaign_id", campaignId) : attemptsQ,
    db().from("failed_op").select("id", { count: "exact", head: true }).eq("resolved", false),
  ]);

  const firstError = funnel.error || quality.error || daily.error || attempts.error;
  if (firstError) return c.json({ error: firstError.message }, 500);

  // Reconcile the two view grains into single headline numbers: cost lives in
  // v_call_quality (campaign×brand), qualified in v_campaign_funnel (campaign).
  const q = quality.data ?? [];
  const f = funnel.data ?? [];
  const sum = <T,>(rows: T[], pick: (r: T) => number | null | undefined) =>
    rows.reduce((a, r) => a + (Number(pick(r)) || 0), 0);
  const totalCost = sum(q, (r: any) => r.total_cost);
  const qualified = sum(f, (r: any) => r.qualified);
  const calls = sum(q, (r: any) => r.calls);
  const connected = sum(q, (r: any) => r.connected);
  const reachedMachine = sum(q, (r: any) => (r.voicemail ?? 0) + (r.no_answer ?? 0));

  return c.json({
    funnel: f,
    quality: q,
    daily: daily.data ?? [],
    attempts: attempts.data ?? [],
    unresolvedFailures: deadLetters.count ?? 0,
    summary: {
      totalCost: Math.round(totalCost * 100) / 100,
      qualified,
      costPerQualified: qualified > 0 ? Math.round((totalCost / qualified) * 100) / 100 : null,
      connectRate: calls > 0 ? Math.round((connected / calls) * 1000) / 10 : null, // %
      reachedMachine,
    },
    days,
  });
});

// Re-apply dead-lettered writes (outbound.failed_op) so lost lead/call/event
// writes are recovered, not just counted on the analytics card.
outbound.post("/outbound/failed-ops/replay", async (c) => {
  const result = await replayFailedOps();
  log.info("Failed-op replay requested", result);
  return c.json({ ok: true, ...result });
});

// Reconcile authoritative telephony cost/status/answered-by from Twilio onto the
// call rows (Twilio is the carrier; Vapi only reports its own platform cost).
outbound.post("/outbound/twilio/sync", async (c) => {
  const campaignId = c.req.query("campaignId") || undefined;
  const result = await syncTwilioCosts({ campaignId });
  log.info("Twilio cost sync requested", { campaignId: campaignId ?? "all", ...result });
  return c.json({ ok: true, ...result });
});

// Data retention: purge call transcripts/recordings/raw payloads older than N
// days (default PII_RETAIN_DAYS). Run on a schedule or on demand.
outbound.post("/outbound/retention/purge", async (c) => {
  const body = await c.req.json<{ days?: number }>().catch(() => ({}) as { days?: number });
  const days = typeof body.days === "number" && body.days > 0 ? Math.floor(body.days) : undefined;
  const result = await purgeOldPii(days);
  log.info("Retention purge requested", { days: days ?? "default", ...result });
  return c.json({ ok: true, ...result });
});

// DSAR / right-to-erasure: delete all data for a phone number (leads + calls +
// events), keeping only the DNC suppression entry so it's never contacted again.
outbound.post("/outbound/dsar/delete", async (c) => {
  const body = await c.req.json<{ phone?: string }>().catch(() => ({}) as { phone?: string });
  const phone = toE164(body.phone) ?? body.phone?.trim();
  if (!phone) return c.json({ ok: false, error: "phone is required" }, 400);
  const result = await deleteLeadDataByPhone(phone);
  log.info("DSAR delete requested", { phone: maskPhone(phone), ...result });
  return c.json({ ok: true, ...result });
});

// --- Continuous improvement (per-campaign transcript analysis) ------------

// Analyze this campaign's recent transcripts now (also runs automatically every
// INSIGHT_EVERY_N_CALLS calls). Produces an improvement report + a proposed
// improved system prompt, stored as a campaign_insight.
outbound.post("/outbound/campaign/:id/analyze", async (c) => {
  const id = c.req.param("id");
  if (!env.anthropicApiKey) {
    return c.json({ ok: false, error: "analysis unavailable (ANTHROPIC_API_KEY not set on the server)" }, 400);
  }
  // Fast eligibility pre-check so the operator gets immediate feedback.
  const { count } = await db()
    .from("call")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", id)
    .eq("status", "ended")
    .not("transcript", "is", null);
  if ((count ?? 0) < 3) {
    return c.json({ ok: false, error: "need at least 3 ended calls with transcripts to analyze" }, 400);
  }
  // The analysis is a 1–2 min Claude call over the transcript batch. Run it
  // DETACHED and return immediately — otherwise the dashboard fetch (and any
  // proxy) times out mid-request and surfaces as "Failed to fetch". The new
  // campaign_insight row appears via the panel's polling / Realtime.
  log.info("Campaign analysis started", { campaignId: id, transcripts: count });
  void analyzeCampaign(id).catch((err) => log.warn("Manual analyze failed", { campaignId: id, err: String(err) }));
  return c.json({ ok: true, started: true });
});

// List a campaign's improvement insights (report + suggested prompt + status).
outbound.get("/outbound/campaign/:id/insights", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  const { data, error } = await db()
    .from("campaign_insight")
    .select("*")
    .eq("campaign_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ insights: data ?? [] });
});

// Pre-start calling-window preview: which timezone groups of this campaign's
// eligible leads are dialable right now, and when the rest open. Backs the
// Start-confirmation popup in the dashboard.
outbound.get("/outbound/campaign/:id/window-status", async (c) => {
  const status = await campaignWindowStatus(c.req.param("id"));
  if (!status) return c.json({ ok: false, error: "campaign not found" }, 404);
  return c.json({ ok: true, ...status });
});

// Approve + APPLY a proposed prompt improvement (human-in-the-loop self-learning).
// Blocked if the compliance guardrail failed.
outbound.post("/outbound/insights/:id/approve", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ approvedBy?: string }>().catch(() => ({}) as { approvedBy?: string });
  const result = await applyInsight(id, body.approvedBy);
  log.info("Insight approve requested", { insightId: id, ok: result.ok, blocked: result.blocked });
  return c.json(result, result.ok ? 200 : 400);
});

// Reject a proposed improvement (no change to the live agent).
outbound.post("/outbound/insights/:id/reject", async (c) => {
  const id = c.req.param("id");
  const result = await rejectInsight(id);
  return c.json(result, result.ok ? 200 : 400);
});

// Per-call compliance audit rows (disclosure spoken? consent captured? DNC?).
outbound.get("/outbound/analytics/compliance", async (c) => {
  const campaignId = c.req.query("campaignId");
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  let q = db()
    .from("v_compliance_audit")
    .select("*")
    .not("started_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  // Headline compliance summary across the returned window.
  const total = rows.length;
  const disclosed = rows.filter((r) => r.disclosure_logged || r.disclosure_event).length;
  const consented = rows.filter((r) => r.consent_captured || r.consent_event).length;
  return c.json({ rows, summary: { total, disclosed, consented } });
});

// Start a campaign. For a specific campaign you can pass:
//   maxCalls       — dial up to N calls this run, then auto-pause (null = unlimited)
//   maxConcurrent  — how many calls may be in flight at once
// Every start stamps run_started_at = now() so the per-run budget is measured
// from this moment (each Start = a fresh batch).
outbound.post("/outbound/campaign/start", async (c) => {
  const body = await c.req
    .json<{ campaignId?: string; maxCalls?: number | null; maxConcurrent?: number }>()
    .catch(() => ({}) as { campaignId?: string; maxCalls?: number | null; maxConcurrent?: number });

  if (body.campaignId) {
    const patch: Record<string, unknown> = {
      status: "running",
      updated_at: new Date().toISOString(),
      run_started_at: new Date().toISOString(),
    };
    if (body.maxCalls === null) patch.max_calls_per_run = null;
    else if (typeof body.maxCalls === "number" && body.maxCalls > 0) patch.max_calls_per_run = Math.floor(body.maxCalls);
    if (typeof body.maxConcurrent === "number" && body.maxConcurrent >= 1) {
      patch.max_concurrent = Math.floor(body.maxConcurrent);
    }
    const { error } = await db().from("campaign").update(patch).eq("id", body.campaignId);
    if (error) return c.json({ error: error.message }, 500);
    // Automatic brand/voice/caller-ID: if no brand was chosen, resolve it from
    // the campaign's leads (location/servicing_brand) so the right brand agent
    // dials — the operator doesn't have to pick.
    await autoAssignCampaignBrand(body.campaignId);
  } else {
    // "Start all" path (no per-run budget) — unchanged legacy behavior.
    const { error } = await db()
      .from("campaign")
      .update({ status: "running", updated_at: new Date().toISOString() })
      .neq("status", "done");
    if (error) return c.json({ error: error.message }, 500);
  }

  startCampaignWorker();
  log.info("Campaign started", { campaignId: body.campaignId ?? "all", maxCalls: body.maxCalls });
  return c.json({ ok: true, status: "running" });
});

outbound.post("/outbound/campaign/pause", async (c) => {
  const body = await c.req.json<{ campaignId?: string }>().catch(() => ({}) as { campaignId?: string });
  const query = db().from("campaign").update({ status: "paused", updated_at: new Date().toISOString() });
  const { error } = body.campaignId ? await query.eq("id", body.campaignId) : await query.eq("status", "running");
  if (error) return c.json({ error: error.message }, 500);
  // Only stop the worker if NO campaigns are left running (multiple can run at once).
  const { count } = await db().from("campaign").select("id", { count: "exact", head: true }).eq("status", "running");
  if (!count) stopCampaignWorker();
  log.info("Campaign paused", { campaignId: body.campaignId ?? "all", stillRunning: count ?? 0 });
  return c.json({ ok: true, status: "paused" });
});

// Rename / re-region / set the brand on a campaign (brand → per-brand agent + caller ID).
outbound.post("/outbound/campaign/:id/update", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{
      name?: string;
      region?: string;
      brand?: string;
      maxConcurrent?: number;
      maxCalls?: number | null;
    }>()
    .catch(() => ({}) as { name?: string; region?: string; brand?: string; maxConcurrent?: number; maxCalls?: number | null });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.region === "string") patch.region = body.region.trim() || null;
  if (typeof body.brand === "string") {
    const slug = body.brand.trim();
    patch.brand = slug || null;
    // Assigning a brand also sets the campaign's calling-hours timezone to that
    // brand's region, so the dialer dials within the right local TCPA window.
    const brand = slug ? getBrand(slug) : undefined;
    if (brand) patch.timezone = brand.timezone;
  }
  if (typeof body.maxConcurrent === "number" && body.maxConcurrent >= 1) {
    patch.max_concurrent = Math.floor(body.maxConcurrent);
  }
  if (body.maxCalls === null) patch.max_calls_per_run = null;
  else if (typeof body.maxCalls === "number" && body.maxCalls > 0) patch.max_calls_per_run = Math.floor(body.maxCalls);

  if (Object.keys(patch).length === 1) {
    // Only updated_at — nothing meaningful was provided.
    return c.json({ ok: false, error: "nothing to update" }, 400);
  }
  const { data, error } = await db().from("campaign").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) return c.json({ ok: false, error: error.message }, 500);
  if (!data) return c.json({ ok: false, error: "campaign not found" }, 404);
  log.info("Campaign updated", { campaignId: id, patch });
  return c.json({ ok: true, campaign: data });
});

// The brands available to assign to campaigns (for the dashboard dropdown).
outbound.get("/outbound/brand-list", (c) => {
  return c.json({
    brands: BRANDS.map((b) => ({ slug: b.slug, displayName: b.displayName, serviceArea: b.serviceArea })),
  });
});

// Delete a campaign and all of its leads (calls/events cascade off the leads).
outbound.post("/outbound/campaign/:id/delete", async (c) => {
  const id = c.req.param("id");
  // Delete leads first; outbound.call (and call_event) cascade off lead_id.
  const { error: leadErr } = await db().from("lead").delete().eq("campaign_id", id);
  if (leadErr) return c.json({ ok: false, error: leadErr.message }, 500);
  const { error } = await db().from("campaign").delete().eq("id", id);
  if (error) return c.json({ ok: false, error: error.message }, 500);
  log.info("Campaign deleted", { campaignId: id });
  return c.json({ ok: true });
});

// POC: issue a signed URL so the dashboard can talk to the ElevenLabs agent in
// the browser (mic) without exposing the API key. Lets you A/B it against Vapi.
outbound.get("/outbound/el-agent/signed-url", async (c) => {
  if (!env.elevenLabsApiKey) return c.json({ ok: false, error: "ELEVENLABS_API_KEY not set" }, 400);
  if (!env.elevenLabsAgentId) return c.json({ ok: false, error: "ELEVENLABS_AGENT_ID not set" }, 400);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${env.elevenLabsAgentId}`,
    { headers: { "xi-api-key": env.elevenLabsApiKey } },
  );
  if (!res.ok) return c.json({ ok: false, error: `ElevenLabs ${res.status}` }, 502);
  const json = (await res.json()) as { signed_url?: string };
  return c.json({ ok: true, agentId: env.elevenLabsAgentId, signedUrl: json.signed_url });
});

// List ElevenLabs voices + each agent's currently-selected voice (for the picker).
outbound.get("/outbound/voices", async (c) => {
  const current = await getCurrentVoices(); // { vapi, elevenlabs }
  try {
    const voices = await listElevenLabsVoices();
    return c.json({ voices, current });
  } catch (err) {
    // No EL key / fetch failed — still return current ids so the UI can show them.
    return c.json({ voices: [], current, error: String(err) });
  }
});

// Switch ONE agent's voice (independent per target). Defaults to the ElevenLabs agent.
outbound.post("/outbound/voice", async (c) => {
  const body = await c.req
    .json<{ voiceId?: string; target?: VoiceTarget }>()
    .catch(() => ({}) as { voiceId?: string; target?: VoiceTarget });
  if (!body.voiceId) return c.json({ ok: false, error: "voiceId is required" }, 400);
  const target: VoiceTarget = body.target === "vapi" ? "vapi" : "elevenlabs";
  const result = await setAgentVoice(body.voiceId, target);
  log.info("Voice switch requested", { voiceId: body.voiceId, target, ok: result.ok });
  return c.json(result, result.ok ? 200 : 400);
});

outbound.post("/outbound/call-now/:leadId", async (c) => {
  const leadId = c.req.param("leadId");
  const result = await callNow(leadId);
  return c.json(result, result.ok ? 200 : 400);
});

// End an in-flight call from the dashboard.
outbound.post("/outbound/calls/:id/end", async (c) => {
  const id = c.req.param("id");
  const result = await endCall(id);
  log.info("End-call requested", { callId: id, ok: result.ok });
  return c.json(result, result.ok ? 200 : 400);
});

// Dial an arbitrary number to test the agent (no lead row). Still DNC-checked.
outbound.post("/outbound/test-call", async (c) => {
  const body = await c.req.json<TestCallInput>().catch(() => ({}) as TestCallInput);
  if (!body.phone) return c.json({ ok: false, reason: "phone is required" }, 400);
  const result = await testCall(body);
  log.info("Test call requested", { phone: maskPhone(body.phone), ok: result.ok });
  return c.json(result, result.ok ? 200 : 400);
});

// --- Lead import (dashboard upload) ---------------------------------------

async function readUpload(c: Context): Promise<Uint8Array | null> {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") return null;
  const ab = await (file as File).arrayBuffer();
  return new Uint8Array(ab);
}

// Inspect an uploaded workbook: list its sheets + row counts, and suggest the
// campaign-ready sheet so the UI can preselect it.
outbound.post("/outbound/import/preview", async (c) => {
  try {
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES) {
      return c.json({ error: "file too large" }, 413);
    }
    const bytes = await readUpload(c);
    if (!bytes) return c.json({ error: "no file uploaded (field 'file')" }, 400);
    const sheets = listSheets(bytes);
    return c.json({ sheets, suggested: guessCampaignReadySheet(sheets) ?? null });
  } catch (err) {
    log.error("Import preview failed", { err: String(err) });
    return c.json({ error: `could not read workbook: ${String(err)}` }, 400);
  }
});

// Import the chosen sheet of leads into a campaign.
outbound.post("/outbound/import", async (c) => {
  try {
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES) {
      return c.json({ error: "file too large" }, 413);
    }
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || typeof file === "string") return c.json({ error: "no file uploaded (field 'file')" }, 400);
    const sheetName = String(body["sheet"] ?? "").trim();
    if (!sheetName) return c.json({ error: "sheet is required" }, 400);
    const region = (String(body["region"] ?? "").trim() || null) as string | null;
    const campaignName = (String(body["campaign"] ?? "").trim() || null) as string | null;

    const ab = await (file as File).arrayBuffer();
    const result = await importLeads({ bytes: new Uint8Array(ab), sheetName, region, campaignName });
    log.info("Leads imported via dashboard", { ...result });
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error("Import failed", { err: String(err) });
    return c.json({ ok: false, error: String(err) }, 400);
  }
});

const EXPORT_COLUMNS = [
  "building_name",
  "address",
  "city",
  "state",
  "zip",
  "region",
  "servicing_brand",
  "contact_name",
  "contact_title",
  "contact_phone",
  "contact_email",
  "oem_match",
  "problem_type",
  "violation_codes",
  "violation_count",
  "cert_expiry_date",
  "lead_score",
  "lead_tier",
  "disposition",
  // Sales-ready qualification fields captured on the call.
  "decision_maker",
  "current_provider",
  "timeline",
  "callback_name",
  "callback_phone",
  "callback_email",
  "qualified_at",
  "attempts",
  "notes",
] as const;

outbound.get("/outbound/export", async (c) => {
  const disposition = c.req.query("disposition"); // e.g. "qualified"; omit for all
  const campaignId = c.req.query("campaignId"); // scope to one region/campaign
  const brand = c.req.query("brand"); // scope to one servicing brand; omit for all
  const format = (c.req.query("format") || "xlsx").toLowerCase();

  let query = db().from("lead").select(EXPORT_COLUMNS.join(","));
  if (campaignId) query = query.eq("campaign_id", campaignId);
  if (brand) {
    // Allow comma-separated brands, e.g. ?brand=AmeriTex,AmeriTex West
    const list = brand.split(",").map((s) => s.trim()).filter(Boolean);
    query = list.length > 1 ? query.in("servicing_brand", list) : query.eq("servicing_brand", list[0]);
  }
  if (disposition) {
    // Allow comma-separated dispositions, e.g. ?disposition=qualified,needs_followup
    const list = disposition.split(",").map((s) => s.trim()).filter(Boolean);
    query = list.length > 1 ? query.in("disposition", list) : query.eq("disposition", list[0]);
  }
  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMNS as unknown as string[] });
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  const brandPart = brand ? `${slug(brand)}_` : "";
  const base = `axxiom_leads_${brandPart}${disposition ?? "all"}_${stamp}`;

  if (format === "csv") {
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
      },
    });
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "leads");
  const buf = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer;
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${base}.xlsx"`,
    },
  });
});
