/**
 * Hono routes for the outbound campaign, consumed by the Next.js dashboard:
 *   GET  /outbound/campaigns          list campaigns + live counts
 *   GET  /outbound/stats              disposition breakdown
 *   POST /outbound/campaign/start     mark a campaign running + start the worker
 *   POST /outbound/campaign/pause     pause campaigns + stop the worker
 *   POST /outbound/call-now/:leadId   manually dial one lead
 *   POST /outbound/test-call          dial an arbitrary number to test the agent
 *   GET  /outbound/export             download leads as csv/xlsx by disposition
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import * as XLSX from "xlsx";

import { log } from "../lib/logger.ts";
import { callNow, startCampaignWorker, stopCampaignWorker, testCall, type TestCallInput } from "./dialer.ts";
import { db } from "./db.ts";

export const outbound = new Hono();

outbound.use("/outbound/*", cors());

outbound.get("/outbound/campaigns", async (c) => {
  const { data, error } = await db().from("campaign").select("*").order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ campaigns: data ?? [] });
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

outbound.post("/outbound/call-now/:leadId", async (c) => {
  const leadId = c.req.param("leadId");
  const result = await callNow(leadId);
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

const EXPORT_COLUMNS = [
  "building_name",
  "address",
  "city",
  "state",
  "zip",
  "region",
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
  const format = (c.req.query("format") || "xlsx").toLowerCase();

  let query = db().from("lead").select(EXPORT_COLUMNS.join(","));
  if (campaignId) query = query.eq("campaign_id", campaignId);
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
  const base = `axxiom_leads_${disposition ?? "all"}_${stamp}`;

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
