/**
 * Create (or update) one customized Vapi OUTBOUND assistant per brand, from the
 * brand registry (src/assistant/brands.ts).
 *
 *   bun run create-brand-assistants            (or: npm run create-brand-assistants:node)
 *   bun run create-brand-assistants quality    (one brand by slug)
 *
 * Each brand's assistant id is stored in outbound.app_setting (brand_assistant:<slug>)
 * so the dialer can route a campaign's calls to the right brand. Re-running PATCHes
 * existing assistants. Needs the outbound schema migration applied first.
 */

import { assertVapi, env } from "../src/config/env.ts";
import { BRANDS, getBrand } from "../src/assistant/brands.ts";
import { syncBrandAssistant } from "../src/assistant/sync.ts";
import { appSettingReady } from "../src/outbound/brandStore.ts";

async function main() {
  assertVapi();
  if (!env.serverUrl) {
    console.warn("⚠️  SERVER_URL not set — assistants will be created WITHOUT a webhook (no tools/logging).\n");
  }
  if (!(await appSettingReady())) {
    console.error(
      "❌ outbound.app_setting isn't reachable, so brand assistant ids can't be read or saved.\n" +
        "   Apply the schema first (Azure: scripts/azure/sql/voice_schema.sql). On Azure a laptop can't\n" +
        "   reach the database at all — run the same sync server-side instead: dashboard → Agent studio →\n" +
        "   \"Re-sync Vapi assistants\" (POST /outbound/admin/assistants/sync).",
    );
    process.exit(1);
  }

  const only = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const brands = only ? [getBrand(only)].filter(Boolean) : BRANDS;
  if (!brands.length) {
    console.error(`No brand "${only}". Known: ${BRANDS.map((b) => b.slug).join(", ")}`);
    process.exit(1);
  }

  // Same code path as the server-side sync (src/assistant/sync.ts): honors the
  // brand's chosen voice + approved prompt override, PATCHes existing
  // assistants, creates missing ones and stores their ids in app_setting.
  for (const brand of brands) {
    if (!brand) continue;
    const r = await syncBrandAssistant(brand);
    const icon = r.action === "failed" ? "❌" : "✅";
    console.log(`${icon} ${brand.displayName}: ${r.action}${r.id ? ` ${r.id}` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
    console.log(`   caller-ID phoneNumberId: ${brand.vapiPhoneNumberId ?? "(none set)"}\n`);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
