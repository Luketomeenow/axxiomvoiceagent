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

import { log } from "../lib/logger.ts";
import { callNow, endCall, startCampaignWorker, stopCampaignWorker, testCall, type TestCallInput } from "./dialer.ts";
import { db } from "./db.ts";
import { guessCampaignReadySheet, importLeads, listSheets } from "./import.ts";
import { getCurrentVoices, listElevenLabsVoices, setAgentVoice, type VoiceTarget } from "./voice.ts";
import { BRANDS } from "../assistant/brands.ts";

export const outbound = new Hono();

outbound.use("/outbound/*", cors());

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

outbound.post("/outbound/campaign/start", async (c) => {
  const body = await c.req.json<{ campaignId?: string }>().catch(() => ({}) as { campaignId?: string });
  const query = db().from("campaign").update({ status: "running", updated_at: new Date().toISOString() });
  const { error } = body.campaignId ? await query.eq("id", body.campaignId) : await query.neq("status", "done");
  if (error) return c.json({ error: error.message }, 500);
  startCampaignWorker();
  log.info("Campaign started", { campaignId: body.campaignId ?? "all" });
  return c.json({ ok: true, status: "running" });
});

outbound.post("/outbound/campaign/pause", async (c) => {
  const body = await c.req.json<{ campaignId?: string }>().catch(() => ({}) as { campaignId?: string });
  const query = db().from("campaign").update({ status: "paused", updated_at: new Date().toISOString() });
  const { error } = body.campaignId ? await query.eq("id", body.campaignId) : await query.eq("status", "running");
  if (error) return c.json({ error: error.message }, 500);
  stopCampaignWorker();
  log.info("Campaign paused", { campaignId: body.campaignId ?? "all" });
  return c.json({ ok: true, status: "paused" });
});

// Rename / re-region / set the brand on a campaign (brand → per-brand agent + caller ID).
outbound.post("/outbound/campaign/:id/update", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{ name?: string; region?: string; brand?: string }>()
    .catch(() => ({}) as { name?: string; region?: string; brand?: string });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.region === "string") patch.region = body.region.trim() || null;
  if (typeof body.brand === "string") patch.brand = body.brand.trim() || null;
  if (!("name" in patch) && !("region" in patch) && !("brand" in patch)) {
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
  const { env } = await import("../config/env.ts");
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
  log.info("Test call requested", { phone: body.phone, ok: result.ok });
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
