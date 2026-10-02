/**
 * Server-side re-sync of every Vapi assistant from code — the same configs the
 * create-*-assistant scripts build, applied with THIS server's env (SERVER_URL
 * → webhook URL, VAPI_SERVER_SECRET) and database (brand assistant ids, chosen
 * voices, approved prompt overrides). Exposed as
 * POST /outbound/admin/assistants/sync because on Azure a laptop can't reach
 * the database those ids live in.
 *
 * Run it after a deploy that changes prompts/tools, and once at cutover: it is
 * what moves the webhooks from the old host to this one. Phone numbers whose
 * inbound webhook points at a /vapi/webhook on another host are re-pointed too;
 * numbers with no webhook (outbound-only caller IDs) are left alone.
 */

import { env } from "../config/env.ts";
import { fetchWithTimeout } from "../lib/http.ts";
import { scopedLog } from "../lib/logger.ts";
import { redactSecretsDeep } from "../lib/redact.ts";
import {
  getBrandAssistantIdStrict,
  getBrandPromptOverrideStrict,
  getBrandVoiceIdStrict,
  setBrandAssistantId,
} from "../outbound/brandStore.ts";
import { getVapiVoiceIdStrict } from "../outbound/voice.ts";
import { BRANDS, getBrand, type Brand } from "./brands.ts";
import { buildAssistantConfig } from "./config.ts";
import { buildOutboundAssistantConfig } from "./outbound/config.ts";

const log = scopedLog("assistant-sync");

const VAPI_API = "https://api.vapi.ai";

export interface SyncItem {
  target: string;
  action: "updated" | "created" | "skipped" | "failed";
  id?: string;
  detail?: string;
}

export interface SyncResult {
  ok: boolean;
  webhookUrl: string | null;
  items: SyncItem[];
}

export function webhookUrl(): string | null {
  return env.serverUrl ? `${env.serverUrl.replace(/\/$/, "")}/vapi/webhook` : null;
}

async function vapi<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetchWithTimeout(VAPI_API + path, {
    method,
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    timeoutMs: 20_000,
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { body: text.slice(0, 200) };
  }
  if (!res.ok) {
    throw new Error(`Vapi ${method} ${path} → ${res.status}: ${JSON.stringify(redactSecretsDeep(json)).slice(0, 400)}`);
  }
  return json as T;
}

/** PATCH (or create + store the id for) one brand's outbound assistant. */
export async function syncBrandAssistant(brand: Brand): Promise<SyncItem> {
  const target = `brand:${brand.slug}`;
  try {
    // Every read is strict: if the database can't answer, this brand fails
    // rather than having an approved prompt/voice overwritten with defaults.
    const voiceId = (await getBrandVoiceIdStrict(brand.slug)) ?? brand.voiceId;
    // An approved self-learning prompt must survive the re-sync.
    const promptOverride = await getBrandPromptOverrideStrict(brand.slug);
    const config = buildOutboundAssistantConfig({ brand, voiceId, promptOverride });
    // Strict: a failed lookup must not read as "no assistant yet" (→ duplicate).
    const existing = await getBrandAssistantIdStrict(brand.slug);
    if (existing) {
      await vapi(`/assistant/${existing}`, "PATCH", config);
      return { target, action: "updated", id: existing, detail: promptOverride ? "approved prompt override kept" : undefined };
    }
    const created = await vapi<{ id?: string }>("/assistant", "POST", config);
    if (!created.id) throw new Error("Vapi returned no assistant id");
    if (!(await setBrandAssistantId(brand.slug, created.id))) {
      return { target, action: "failed", id: created.id, detail: "created in Vapi but the id could not be saved to app_setting" };
    }
    return { target, action: "created", id: created.id };
  } catch (err) {
    return { target, action: "failed", detail: String(err) };
  }
}

async function syncInbound(): Promise<SyncItem[]> {
  if (!env.vapiAssistantId) {
    return [{ target: "inbound", action: "skipped", detail: "VAPI_ASSISTANT_ID not set (create it with bun run create-assistant)" }];
  }
  const items: SyncItem[] = [];
  try {
    await vapi(`/assistant/${env.vapiAssistantId}`, "PATCH", buildAssistantConfig());
    items.push({ target: "inbound", action: "updated", id: env.vapiAssistantId });
  } catch (err) {
    return [{ target: "inbound", action: "failed", id: env.vapiAssistantId, detail: String(err) }];
  }
  if (env.vapiPhoneNumberId) {
    try {
      await vapi(`/phone-number/${env.vapiPhoneNumberId}`, "PATCH", { assistantId: env.vapiAssistantId });
      items.push({ target: "inbound-number", action: "updated", id: env.vapiPhoneNumberId, detail: "routes to the inbound assistant" });
    } catch (err) {
      items.push({ target: "inbound-number", action: "failed", id: env.vapiPhoneNumberId, detail: String(err) });
    }
  }
  return items;
}

async function syncGenericOutbound(): Promise<SyncItem> {
  if (!env.outboundAssistantId) {
    return { target: "outbound", action: "skipped", detail: "OUTBOUND_ASSISTANT_ID not set (create it with bun run create-outbound-assistant)" };
  }
  try {
    // Unbranded calls' approved prompt lives under brand_prompt:default (strict reads, as above).
    const promptOverride = await getBrandPromptOverrideStrict("default");
    const config = buildOutboundAssistantConfig({ voiceId: await getVapiVoiceIdStrict(), promptOverride });
    await vapi(`/assistant/${env.outboundAssistantId}`, "PATCH", config);
    return { target: "outbound", action: "updated", id: env.outboundAssistantId };
  } catch (err) {
    return { target: "outbound", action: "failed", id: env.outboundAssistantId, detail: String(err) };
  }
}

interface VapiNumber {
  id: string;
  number?: string;
  server?: { url?: string };
}

/** Re-point numbers already wired to a /vapi/webhook elsewhere (e.g. the old host). */
async function syncPhoneNumberWebhooks(url: string): Promise<SyncItem[]> {
  let numbers: VapiNumber[];
  try {
    const json = await vapi<unknown>("/phone-number?limit=1000", "GET");
    numbers = Array.isArray(json) ? (json as VapiNumber[]) : [];
  } catch (err) {
    return [{ target: "phone-numbers", action: "failed", detail: String(err) }];
  }
  const stale = numbers.filter((n) => n.server?.url?.endsWith("/vapi/webhook") && n.server.url !== url);
  const items: SyncItem[] = [];
  for (const n of stale) {
    try {
      await vapi(`/phone-number/${n.id}`, "PATCH", { server: { url, secret: env.vapiServerSecret } });
      items.push({ target: `number:${n.number ?? n.id}`, action: "updated", id: n.id, detail: "inbound webhook re-pointed" });
    } catch (err) {
      items.push({ target: `number:${n.number ?? n.id}`, action: "failed", id: n.id, detail: String(err) });
    }
  }
  if (!stale.length) items.push({ target: "phone-numbers", action: "skipped", detail: "no number points at another host" });
  return items;
}

/**
 * Sync everything (or one brand). Refuses to run without SERVER_URL +
 * VAPI_SERVER_SECRET: pushing a config without them would leave the live
 * assistants posting to a webhook that rejects them.
 */
export async function syncAssistants(opts: { onlyBrand?: string } = {}): Promise<SyncResult> {
  const url = webhookUrl();
  if (!env.vapiApiKey || !url || !env.vapiServerSecret) {
    const missing = [!env.vapiApiKey && "VAPI_API_KEY", !url && "SERVER_URL", !env.vapiServerSecret && "VAPI_SERVER_SECRET"]
      .filter(Boolean)
      .join(", ");
    return { ok: false, webhookUrl: url, items: [{ target: "all", action: "skipped", detail: `not configured: ${missing}` }] };
  }

  let items: SyncItem[];
  if (opts.onlyBrand) {
    const brand = getBrand(opts.onlyBrand);
    items = brand
      ? [await syncBrandAssistant(brand)]
      : [{ target: `brand:${opts.onlyBrand}`, action: "failed", detail: "unknown brand slug" }];
  } else {
    items = [...(await syncInbound()), await syncGenericOutbound()];
    for (const brand of BRANDS) items.push(await syncBrandAssistant(brand));
    items.push(...(await syncPhoneNumberWebhooks(url)));
  }

  const ok = !items.some((i) => i.action === "failed");
  if (!ok) log.warn("assistant sync had failures", { failed: items.filter((i) => i.action === "failed").map((i) => i.target) });
  return { ok, webhookUrl: url, items };
}
