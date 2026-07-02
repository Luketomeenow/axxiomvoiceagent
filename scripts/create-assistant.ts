/**
 * Create (or update) the Vapi assistant from src/assistant/config.ts.
 *
 *   bun run create-assistant
 *
 * - If VAPI_ASSISTANT_ID is set, PATCHes that assistant.
 * - Otherwise POSTs a new one and prints the id to put in your .env.
 * - If VAPI_PHONE_NUMBER_ID is set, attaches the assistant to that number.
 */

import { assertVapi, env } from "../src/config/env.ts";
import { buildAssistantConfig } from "../src/assistant/config.ts";
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
    console.warn("    Set SERVER_URL to your Railway URL and re-run to wire up tools + logging.\n");
  }

  const config = buildAssistantConfig();

  if (env.vapiAssistantId) {
    console.log(`Updating assistant ${env.vapiAssistantId}…`);
    await vapi(`/assistant/${env.vapiAssistantId}`, "PATCH", config);
    console.log("✅ Updated.");
  } else {
    console.log("Creating new assistant…");
    const created = await vapi("/assistant", "POST", config);
    console.log(`✅ Created assistant: ${created.id}`);
    console.log(`   Add this to your .env:  VAPI_ASSISTANT_ID=${created.id}`);
  }

  const assistantId = env.vapiAssistantId || undefined;
  if (env.vapiPhoneNumberId && assistantId) {
    console.log(`Attaching assistant to phone number ${env.vapiPhoneNumberId}…`);
    await vapi(`/phone-number/${env.vapiPhoneNumberId}`, "PATCH", { assistantId });
    console.log("✅ Phone number now routes to this assistant.");
  } else if (env.vapiPhoneNumberId) {
    console.log("ℹ️  Set VAPI_ASSISTANT_ID (printed above) and re-run to attach the phone number.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
