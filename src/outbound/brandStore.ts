/**
 * Per-brand runtime config persisted in outbound.app_setting:
 *   brand_assistant:<slug> → the brand's Vapi assistant id (set by create-brand-assistants)
 *   brand_voice:<slug>     → the brand's chosen ElevenLabs voice (set in the dashboard)
 * The dialer reads these to route each call to the right brand's assistant + voice.
 */

import { db } from "./db.ts";
import { log } from "../lib/logger.ts";

async function read(key: string): Promise<string | undefined> {
  const { data } = await db().from("app_setting").select("value").eq("key", key).maybeSingle();
  return (data?.value as string | undefined)?.trim() || undefined;
}

async function write(key: string, value: string): Promise<boolean> {
  try {
    await db().from("app_setting").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return true;
  } catch (err) {
    log.warn("brandStore write failed", { key, err: String(err) });
    return false;
  }
}

export const getBrandAssistantId = (slug: string): Promise<string | undefined> => read(`brand_assistant:${slug}`).catch(() => undefined);
export const setBrandAssistantId = (slug: string, id: string): Promise<boolean> => write(`brand_assistant:${slug}`, id);
export const getBrandVoiceId = (slug: string): Promise<string | undefined> => read(`brand_voice:${slug}`).catch(() => undefined);
export const setBrandVoiceId = (slug: string, id: string): Promise<boolean> => write(`brand_voice:${slug}`, id);

// Approved self-learning prompt override for a brand (set when an operator approves
// a campaign_insight). When present, it replaces the code-default system prompt for
// that brand's assistant — so the create-assistant scripts + apply step use it and a
// redeploy doesn't clobber an approved improvement.
export const getBrandPromptOverride = (slug: string): Promise<string | undefined> => read(`brand_prompt:${slug}`).catch(() => undefined);
export const setBrandPromptOverride = (slug: string, prompt: string): Promise<boolean> => write(`brand_prompt:${slug}`, prompt);

/** True if outbound.app_setting is reachable (migration applied + schema exposed). */
export async function appSettingReady(): Promise<boolean> {
  try {
    await read("__preflight__");
    return true;
  } catch {
    return false;
  }
}
