/**
 * Shared lead-import logic — used by both the CLI (`scripts/import-leads.ts`)
 * and the dashboard upload endpoint (`POST /outbound/import`).
 *
 * Parses the leads workbook, normalizes phones to E.164, dedupes on
 * (device_id, contact_phone), flags toll-free/missing numbers as bad_number,
 * groups leads under one campaign per region, and upserts so re-running is safe.
 */

import * as XLSX from "xlsx";

import { db } from "./db.ts";
import { chooseDialNumber, toE164 } from "./phone.ts";

export interface SheetInfo {
  name: string;
  rows: number;
}

export interface ImportResult {
  campaignId: string | null;
  campaignName: string;
  sheet: string;
  totalRows: number;
  prepared: number;
  imported: number;
  deduped: number;
  badNumbers: number;
}

export type WorkbookBytes = ArrayBuffer | Uint8Array;

function intOrNull(v: unknown): number | null {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function readWorkbook(bytes: WorkbookBytes): XLSX.WorkBook {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return XLSX.read(arr, { type: "array" });
}

/** List every sheet in the workbook with its data-row count (for the UI picker). */
export function listSheets(bytes: WorkbookBytes): SheetInfo[] {
  const wb = readWorkbook(bytes);
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }).length;
    return { name, rows };
  });
}

/**
 * Best guess at which sheet holds the campaign-ready leads, so the UI can
 * preselect it. Prefers names mentioning "campaign ready", then "tier a".
 */
export function guessCampaignReadySheet(sheets: SheetInfo[]): string | undefined {
  const byName = (re: RegExp) => sheets.find((s) => re.test(s.name))?.name;
  return (
    byName(/campaign\s*ready/i) ??
    byName(/tier\s*a/i) ??
    sheets.slice().sort((a, b) => b.rows - a.rows)[0]?.name
  );
}

/** Resolve (or create) the campaign for this import. `name` isn't unique, so fall back gracefully. */
async function resolveCampaignId(campaignName: string, region: string | null, segment: string): Promise<string | null> {
  const fields = { name: campaignName, segment, region };

  const existing = await db().from("campaign").select("id").eq("name", campaignName).maybeSingle();
  if (existing.data?.id) return existing.data.id as string;

  const created = await db().from("campaign").insert(fields).select("id").maybeSingle();
  return (created.data?.id as string | undefined) ?? null;
}

/**
 * Import one sheet of leads into outbound.lead under a campaign.
 * Idempotent: upserts on (device_id, contact_phone).
 */
export async function importLeads(opts: {
  bytes: WorkbookBytes;
  sheetName: string;
  region?: string | null;
  campaignName?: string | null;
  segment?: string;
}): Promise<ImportResult> {
  const wb = readWorkbook(opts.bytes);
  const sheet = wb.Sheets[opts.sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${opts.sheetName}" not found. Available: ${wb.SheetNames.join(", ")}`);
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const region = opts.region ?? null;
  const segment = opts.segment || "tier_a_campaign_ready";
  const campaignName = (opts.campaignName && opts.campaignName.trim()) || region || `Campaign — ${opts.sheetName}`;

  const campaignId = await resolveCampaignId(campaignName, region, segment);

  const seen = new Set<string>();
  const records: Record<string, unknown>[] = [];

  for (const r of rows) {
    const contactPhone = toE164(str(r.contact_phone));
    const ownerPhone = toE164(str(r.owner_phone));
    const deviceId = str(r.device_id);

    const dedupeKey = `${deviceId ?? ""}|${contactPhone ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const { phone: dialPhone, lowQuality } = chooseDialNumber(contactPhone, ownerPhone);

    records.push({
      campaign_id: campaignId,
      contact_name: str(r.contact_name),
      contact_title: str(r.contact_title),
      contact_email: str(r.contact_email),
      contact_phone: contactPhone,
      owner_phone: ownerPhone,
      dial_phone: dialPhone,
      building_name: str(r.building_name),
      address: str(r.address),
      city: str(r.city),
      state: str(r.state),
      zip: str(r.zip),
      market: str(r.market),
      region: region ?? str(r.region) ?? str(r.market),
      device_id: deviceId,
      equipment_type: str(r.equipment_type),
      manufacturer: str(r.manufacturer),
      service_company: str(r.service_company),
      oem_match: str(r.oem_match),
      problem_type: str(r.problem_type),
      inspection_type: str(r.inspection_type),
      violation_codes: str(r.violation_codes),
      violation_count: intOrNull(r.violation_count),
      violation_details: str(r.violation_details),
      last_inspection_date: str(r.last_inspection_date),
      cert_expiry_date: str(r.cert_expiry_date),
      lead_score: intOrNull(r.lead_score),
      lead_tier: str(r.lead_tier),
      servicing_brand: str(r.servicing_brand),
      disposition: lowQuality || !dialPhone ? "bad_number" : "new",
      source_url: str(r.source_url),
      date_scraped: str(r.date_scraped),
      raw: r,
    });
  }

  const CHUNK = 500;
  let imported = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK);
    const { error } = await db().from("lead").upsert(batch, { onConflict: "device_id,contact_phone" });
    if (error) throw new Error(`Lead upsert failed (batch ${i / CHUNK}): ${error.message}`);
    imported += batch.length;
  }

  const badNumbers = records.filter((r) => r.disposition === "bad_number").length;

  return {
    campaignId,
    campaignName,
    sheet: opts.sheetName,
    totalRows: rows.length,
    prepared: records.length,
    imported,
    deduped: rows.length - records.length,
    badNumbers,
  };
}
