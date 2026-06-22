/**
 * Diagnostic: verify the backend can reach the `outbound` schema in Supabase.
 *
 * Run: npm run check-db:node   (or: bun run scripts/check-outbound-db.ts)
 *
 * If the schema isn't exposed to the REST API, every query fails with PGRST106
 * ("The schema must be one of the following...") and the dialer fail-closes
 * every number as "DNC". This script makes that obvious.
 */

import { env } from "../src/config/env.ts";
import { checkSuppression, db } from "../src/outbound/db.ts";

const TEST_NUMBER = process.argv[2] || "+17723234606";

async function countOf(table: string): Promise<string> {
  const { count, error } = await db().from(table).select("id", { count: "exact", head: true });
  if (error) return `ERROR — ${error.message}`;
  return `${count ?? 0} rows`;
}

async function main() {
  console.log("Supabase URL:", env.supabaseUrl || "(not set)");
  console.log("Service role key:", env.supabaseServiceRoleKey ? "set" : "(NOT set)");
  console.log("Outbound schema:", env.outboundSchema);
  console.log("");

  console.log("Reading outbound tables (service role):");
  console.log("  campaign        :", await countOf("campaign"));
  console.log("  lead            :", await countOf("lead"));
  console.log("  dnc_suppression :", await countOf("dnc_suppression"));
  console.log("");

  console.log(`DNC check for ${TEST_NUMBER}:`);
  console.log(" ", JSON.stringify(await checkSuppression(TEST_NUMBER)));
}

main().catch((err) => {
  console.error("Diagnostic crashed:", err);
  process.exit(1);
});
