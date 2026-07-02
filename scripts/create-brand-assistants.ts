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
import { buildOutboundAssistantConfig } from "../src/assistant/outbound/config.ts";
import {
  appSettingReady,
  getBrandAssistantId,
  getBrandPromptOverride,
  getBrandVoiceId,
  setBrandAssistantId,
} from "../src/outbound/brandStore.ts";
import { redactSecretsDeep } from "../src/lib/redact.ts";

const VAPI_API = "https://api.vapi.ai";

async function vapi(path: string, method: string, body?: unknown) {
  const res = await fetch(VAPI_API + path, {
    method,
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok)
    throw new Error(`Vapi ${method} ${path} → ${res.status}: ${JSON.stringify(redactSecretsDeep(json)).slice(0, 500)}`);
  return json as { id?: string };
}

async function main() {
  assertVapi();
  if (!env.serverUrl) {
    console.warn("⚠️  SERVER_URL not set — assistants will be created WITHOUT a webhook (no tools/logging).\n");
  }
  if (!(await appSettingReady())) {
    console.error(
      "❌ outbound.app_setting isn't reachable. Run scripts/sql/outbound_schema.sql in Supabase\n" +
        "   (and expose the `outbound` schema) before creating brand assistants — otherwise the\n" +
        "   ids can't be saved and the dialer can't route to them.",
    );
    process.exit(1);
  }

  const only = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const brands = only ? [getBrand(only)].filter(Boolean) : BRANDS;
  if (!brands.length) {
    console.error(`No brand "${only}". Known: ${BRANDS.map((b) => b.slug).join(", ")}`);
    process.exit(1);
  }

  for (const brand of brands) {
    if (!brand) continue;
    const voiceId = (await getBrandVoiceId(brand.slug)) ?? brand.voiceId;
    // Honor an approved self-learning prompt override so a redeploy doesn't
    // clobber an improvement that was reviewed + applied.
    const promptOverride = await getBrandPromptOverride(brand.slug);
    const config = buildOutboundAssistantConfig({ brand, voiceId, promptOverride });
    if (promptOverride) console.log(`   (using approved prompt override for ${brand.slug})`);
    const existing = await getBrandAssistantId(brand.slug);

    try {
      if (existing) {
        await vapi(`/assistant/${existing}`, "PATCH", config);
        console.log(`✅ ${brand.displayName}: updated ${existing}`);
      } else {
        const created = await vapi("/assistant", "POST", config);
        const id = created.id ?? "";
        await setBrandAssistantId(brand.slug, id);
        console.log(`✅ ${brand.displayName}: created ${id}`);
      }
      console.log(`   caller-ID phoneNumberId: ${brand.vapiPhoneNumberId ?? "(none set)"}\n`);
    } catch (err) {
      console.error(`❌ ${brand.displayName}: ${String(err)}\n`);
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
