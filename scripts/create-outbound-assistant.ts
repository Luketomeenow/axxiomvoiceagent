/**
 * Create (or update) the Vapi OUTBOUND qualification assistant.
 *
 *   bun run create-outbound-assistant
 *
 * - If OUTBOUND_ASSISTANT_ID is set, PATCHes that assistant.
 * - Otherwise POSTs a new one and prints the id to put in your .env.
 *
 * The outbound assistant is separate from the inbound one so the two prompts,
 * tools, and call logs never collide.
 */

import { assertVapi, env } from "../src/config/env.ts";
import { buildOutboundAssistantConfig } from "../src/assistant/outbound/config.ts";
import { redactSecretsDeep } from "../src/lib/redact.ts";

const VAPI_API = "https://api.vapi.ai";

async function vapi(path: string, method: string, body?: unknown) {
  const res = await fetch(VAPI_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.vapiApiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    console.error(`Vapi ${method} ${path} → ${res.status}`);
    console.error(JSON.stringify(redactSecretsDeep(json), null, 2));
    process.exit(1);
  }
  return json as { id?: string };
}

async function main() {
  assertVapi();

  if (!env.serverUrl) {
    console.warn("⚠️  SERVER_URL is not set — the assistant will be created WITHOUT a webhook URL.");
    console.warn("    Set SERVER_URL to this service's public URL (App Service) and re-run to wire up tools + live logging.\n");
  }
  if (!env.transferPhoneNumber) {
    console.warn("ℹ️  TRANSFER_PHONE_NUMBER not set — the transferToHuman tool will be omitted.\n");
  }

  // Honor the overrides for unbranded calls (brand_prompt:default, brand_voice:default)
  // — otherwise re-running this script would silently revert an approved
  // improvement. Same inputs as the dashboard's assistant sync (src/assistant/sync.ts).
  const { getBrandPromptOverride, getBrandVoiceId } = await import("../src/outbound/brandStore.ts");
  const voiceId = await getBrandVoiceId("default");
  const promptOverride = await getBrandPromptOverride("default");
  if (promptOverride) console.log("   (using the approved prompt override for unbranded calls)");
  const config = buildOutboundAssistantConfig({ voiceId, promptOverride });

  if (env.outboundAssistantId) {
    console.log(`Updating outbound assistant ${env.outboundAssistantId}…`);
    await vapi(`/assistant/${env.outboundAssistantId}`, "PATCH", config);
    console.log("✅ Updated.");
  } else {
    console.log("Creating new outbound assistant…");
    const created = await vapi("/assistant", "POST", config);
    console.log(`✅ Created outbound assistant: ${created.id}`);
    console.log(`   Add this to your .env:  OUTBOUND_ASSISTANT_ID=${created.id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
