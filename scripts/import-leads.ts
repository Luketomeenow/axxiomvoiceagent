/**
 * Import leads from the workbook into outbound.lead.
 *
 *   bun run import-leads [path-to-xlsx] [--sheet "Tier A - Campaign Ready"] \
 *                        [--region "CA — Bay Area"] [--campaign "Custom name"]
 *
 * One campaign per region: --region names/creates the campaign (and is stamped
 * on every lead) so the dashboard can launch + monitor each region on its own.
 * Defaults to data/axxiom_leads_CA_20260617.xlsx and the "Tier A - Campaign Ready"
 * sheet (the 703 enriched, named-contact rows). Normalizes phones to E.164,
 * dedupes on (device_id, contact_phone), flags toll-free-only leads as
 * bad_number, and upserts so re-running is safe.
 */

import * as XLSX from "xlsx";

import { db } from "../src/outbound/db.ts";
import { chooseDialNumber, toE164 } from "../src/outbound/phone.ts";

const DEFAULT_FILE = "data/axxiom_leads_CA_20260617.xlsx";
const DEFAULT_SHEET = "Tier A - Campaign Ready";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function intOrNull(v: unknown): number | null {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

async function main() {
  const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_FILE;
  const sheetName = arg("--sheet") ?? DEFAULT_SHEET;
  // One campaign per region. --region names the region; --campaign overrides the
  // campaign name (defaults to the region). Region is stamped on every lead too.
  const region = arg("--region") ?? null;
  const campaignName = arg("--campaign") ?? region ?? `CA AmeriTex West — ${sheetName}`;

  console.log(`Reading ${file} → sheet "${sheetName}"${region ? ` → region "${region}"` : ""}…`);
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    console.error(`Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(", ")}`);
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  console.log(`Parsed ${rows.length} rows.`);

  // Upsert a campaign row so leads can be grouped + the worker has guardrails.
  const campaignFields = { name: campaignName, segment: "tier_a_campaign_ready", region };
  const { data: campaign, error: campErr } = await db()
    .from("campaign")
    .upsert(campaignFields, { onConflict: "name" })
    .select("id")
    .maybeSingle();
  if (campErr) {
    // `name` may not be unique; fall back to a plain insert/select.
    console.warn("Campaign upsert warning:", campErr.message);
  }
  let campaignId = campaign?.id as string | undefined;
  if (!campaignId) {
    const { data } = await db().from("campaign").select("id").eq("name", campaignName).maybeSingle();
    campaignId = data?.id as string | undefined;
    if (!campaignId) {
      const { data: created } = await db().from("campaign").insert(campaignFields).select("id").maybeSingle();
      campaignId = created?.id as string | undefined;
    }
  }

  const seen = new Set<string>();
  const records = [] as Record<string, unknown>[];

  for (const r of rows) {
    const contactPhone = toE164(str(r.contact_phone));
    const ownerPhone = toE164(str(r.owner_phone));
    const deviceId = str(r.device_id);

    const dedupeKey = `${deviceId ?? ""}|${contactPhone ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const { phone: dialPhone, lowQuality } = chooseDialNumber(contactPhone, ownerPhone);

    records.push({
      campaign_id: campaignId ?? null,
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
      disposition: lowQuality ? "bad_number" : !dialPhone ? "bad_number" : "new",
      source_url: str(r.source_url),
      date_scraped: str(r.date_scraped),
      raw: r,
    });
  }

  console.log(`Prepared ${records.length} unique leads (deduped from ${rows.length}). Upserting…`);

  // Chunked upsert so we don't blow the request size limit.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK);
    const { error } = await db().from("lead").upsert(batch, { onConflict: "device_id,contact_phone" });
    if (error) {
      console.error(`Batch ${i / CHUNK} failed:`, error.message);
      process.exit(1);
    }
    inserted += batch.length;
    console.log(`  …${inserted}/${records.length}`);
  }

  const badNumbers = records.filter((r) => r.disposition === "bad_number").length;
  console.log(`✅ Imported ${inserted} leads (${badNumbers} flagged bad_number for toll-free/missing phone).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
