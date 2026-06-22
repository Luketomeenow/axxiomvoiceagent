/**
 * Import leads from the workbook into outbound.lead.
 *
 *   bun run import-leads [path-to-xlsx] [--sheet "Tier A - Campaign Ready"] \
 *                        [--region "CA — Bay Area"] [--campaign "Custom name"]
 *
 * One campaign per region: --region names/creates the campaign (and is stamped
 * on every lead) so the dashboard can launch + monitor each region on its own.
 * Defaults to data/axxiom_leads_CA_20260617.xlsx and the "Tier A - Campaign Ready"
 * sheet. The actual parsing/normalization/upsert lives in src/outbound/import.ts
 * so the dashboard upload endpoint shares the exact same logic.
 */

import { readFileSync } from "node:fs";

import { importLeads, listSheets } from "../src/outbound/import.ts";

const DEFAULT_FILE = "data/axxiom_leads_CA_20260617.xlsx";
const DEFAULT_SHEET = "Tier A - Campaign Ready";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_FILE;
  const sheetName = arg("--sheet") ?? DEFAULT_SHEET;
  const region = arg("--region") ?? null;
  const campaignName = arg("--campaign") ?? region ?? `CA AmeriTex West — ${sheetName}`;

  const bytes = readFileSync(file);
  const sheets = listSheets(bytes);
  if (!sheets.some((s) => s.name === sheetName)) {
    console.error(`Sheet "${sheetName}" not found. Available: ${sheets.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`Reading ${file} → sheet "${sheetName}"${region ? ` → region "${region}"` : ""}…`);
  const result = await importLeads({ bytes, sheetName, region, campaignName });

  console.log(
    `✅ Imported ${result.imported} leads (deduped ${result.deduped} from ${result.totalRows}; ` +
      `${result.badNumbers} flagged bad_number) into campaign "${result.campaignName}".`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
