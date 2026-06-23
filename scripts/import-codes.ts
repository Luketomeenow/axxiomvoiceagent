/**
 * Seed outbound.code_reference — the curated, authoritative elevator
 * inspection / violation codes the agent's lookupViolationCode tool reads from.
 * The agent NEVER invents code meanings; it only speaks what's in this table.
 *
 *   bun run import-codes [path-to-xlsx-or-csv] [--sheet "Codes"]
 *
 * Defaults to data/elevator_codes.xlsx. Expected columns (header row, case- and
 * space-insensitive): code, jurisdiction, title, plain_summary, severity,
 * typical_remedy, source_url. Only `code` is required. Upserts on `code` so
 * re-running is safe; codes are normalized (uppercased, punctuation trimmed)
 * to match how the lookup tool queries them.
 */

import * as XLSX from "xlsx";

import { db } from "../src/outbound/db.ts";

const DEFAULT_FILE = "scripts/seed/ca_elevator_compliance.csv";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/**
 * Same normalization the lookup tool applies (src/outbound/handlers.ts), so
 * seeded keys match queries: uppercase, keep alphanumerics/dots, collapse other
 * runs to underscores ("overdue inspection" → "OVERDUE_INSPECTION").
 */
function normalizeCode(raw: string | null): string | null {
  if (!raw) return null;
  const n = raw
    .toUpperCase()
    .replace(/[^A-Z0-9.]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return n || null;
}

/** Map a row's headers (case/space-insensitive) to our column names. */
function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase().replace(/[\s_]+/g, "")] = v;
  for (const key of keys) {
    const hit = lower[key.toLowerCase().replace(/[\s_]+/g, "")];
    if (hit !== undefined && String(hit).trim() !== "") return hit;
  }
  return undefined;
}

async function main() {
  const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_FILE;
  const sheetName = arg("--sheet");

  console.log(`Reading ${file}${sheetName ? ` → sheet "${sheetName}"` : ""}…`);
  // raw:true / cellDates:false so code values like "2.7.6" aren't coerced into
  // dates/numbers (SheetJS otherwise reads "2.7.6" as a date serial).
  const wb = XLSX.readFile(file, { raw: true, cellDates: false });
  const sheet = wb.Sheets[sheetName ?? wb.SheetNames[0]];
  if (!sheet) {
    console.error(`Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(", ")}`);
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
  console.log(`Parsed ${rows.length} rows.`);

  const seen = new Set<string>();
  const records = [] as Record<string, unknown>[];

  for (const r of rows) {
    const code = normalizeCode(str(pick(r, "code", "citation", "violation_code")));
    if (!code || seen.has(code)) continue;
    seen.add(code);

    records.push({
      code,
      jurisdiction: str(pick(r, "jurisdiction", "standard", "source")),
      title: str(pick(r, "title", "name")),
      plain_summary: str(pick(r, "plain_summary", "summary", "meaning", "description")),
      severity: str(pick(r, "severity", "level")),
      typical_remedy: str(pick(r, "typical_remedy", "remedy", "fix", "resolution")),
      source_url: str(pick(r, "source_url", "url", "link")),
    });
  }

  if (!records.length) {
    console.error("No rows with a `code` column found. Check the header names.");
    process.exit(1);
  }

  console.log(`Prepared ${records.length} unique codes. Upserting…`);
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK);
    const { error } = await db().from("code_reference").upsert(batch, { onConflict: "code" });
    if (error) {
      console.error(`Batch ${i / CHUNK} failed:`, error.message);
      process.exit(1);
    }
    inserted += batch.length;
    console.log(`  …${inserted}/${records.length}`);
  }

  console.log(`✅ Seeded ${inserted} codes into outbound.code_reference.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
