/**
 * Diagnostic: verify the backend can reach the `outbound` schema on the active
 * data backend (Azure Postgres, or the legacy Supabase project).
 *
 * Run: bun run check-db   (or: npm run check-db:node)
 *
 * On Azure a laptop can't reach the server (firewall: Azure services only) —
 * run this in Cloud Shell with AZURE_PG_USER=<your Entra email>, or hit the
 * deployed app's GET /ready, which runs the same checks as the managed identity.
 * If the schema or a grant is missing, every query errors and the dialer
 * fail-closes every number as "DNC" — this makes that obvious.
 */

import { env } from "../src/config/env.ts";
import { checkSuppression, db } from "../src/outbound/db.ts";

const TEST_NUMBER = process.argv[2] || "+17723234606";

async function countOf(table: string, key = "id"): Promise<string> {
  const { count, error } = await db().from(table).select(key, { count: "exact", head: true });
  if (error) return `ERROR — ${error.message}`;
  return `${count ?? 0} rows`;
}

async function main() {
  console.log("Data backend:", env.dataBackend);
  if (env.dataBackend === "azure") {
    console.log("Azure Postgres:", `${env.azurePgHost}:${env.azurePgPort}/${env.azurePgDatabase}`);
    console.log("Login as:", env.azurePgUser || "(AZURE_PG_USER NOT set)", env.azurePgPassword ? "(static password)" : "(Entra token)");
    try {
      const { pgWhoAmI } = await import("../src/lib/pg/backend.ts");
      const who = await pgWhoAmI();
      console.log("Connected as:", who.user, `· ${who.database} · PostgreSQL ${who.version}`);
    } catch (err) {
      console.log("Connection FAILED:", String(err));
    }
  } else {
    console.log("Supabase URL:", env.supabaseUrl || "(not set)");
    console.log("Service role key:", env.supabaseServiceRoleKey ? "set" : "(NOT set)");
  }
  console.log("Outbound schema:", env.outboundSchema);
  console.log("");

  console.log("Reading outbound tables:");
  console.log("  campaign        :", await countOf("campaign"));
  console.log("  lead            :", await countOf("lead"));
  console.log("  dnc_suppression :", await countOf("dnc_suppression", "phone"));
  console.log("  dashboard_user  :", await countOf("dashboard_user"));
  console.log("");

  console.log(`DNC check for ${TEST_NUMBER}:`);
  console.log(" ", JSON.stringify(await checkSuppression(TEST_NUMBER)));

  if (env.dataBackend === "azure") {
    const { closePool } = await import("../src/lib/pg/backend.ts");
    await closePool();
  }
}

main().catch((err) => {
  console.error("Diagnostic crashed:", err);
  process.exit(1);
});
