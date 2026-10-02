/**
 * Per-brand runtime config persisted in outbound.app_setting:
 *   brand_assistant:<slug> → the brand's Vapi assistant id (set by create-brand-assistants)
 *   brand_voice:<slug>     → the brand's chosen ElevenLabs voice (set in the dashboard)
 * The dialer reads these to route each call to the right brand's assistant + voice.
 */

import { db } from "./db.ts";
import { log } from "../lib/logger.ts";

// Throws on a failed lookup — the query builder reports errors in `{ error }`
// rather than throwing, and a swallowed error would read as "not set" (which
// made appSettingReady() always true and could make a sync create duplicate
// assistants). The soft getters below still degrade to undefined.
async function read(key: string): Promise<string | undefined> {
  const { data, error } = await db().from("app_setting").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.value as string | undefined)?.trim() || undefined;
}

async function write(key: string, value: string): Promise<boolean> {
  try {
    const { error } = await db()
      .from("app_setting")
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    log.warn("brandStore write failed", { key, err: String(err) });
    return false;
  }
}

export const getBrandAssistantId = (slug: string): Promise<string | undefined> => read(`brand_assistant:${slug}`).catch(() => undefined);
/** Like getBrandAssistantId, but a failed lookup throws instead of reading as "none". */
export const getBrandAssistantIdStrict = (slug: string): Promise<string | undefined> => read(`brand_assistant:${slug}`);
export const setBrandAssistantId = (slug: string, id: string): Promise<boolean> => write(`brand_assistant:${slug}`, id);
export const getBrandVoiceId = (slug: string): Promise<string | undefined> => read(`brand_voice:${slug}`).catch(() => undefined);
export const setBrandVoiceId = (slug: string, id: string): Promise<boolean> => write(`brand_voice:${slug}`, id);

// Approved self-learning prompt override for a brand (set when an operator approves
// a campaign_insight). When present, it replaces the code-default system prompt for
// that brand's assistant — so the create-assistant scripts + apply step use it and a
// redeploy doesn't clobber an approved improvement.
export const getBrandPromptOverride = (slug: string): Promise<string | undefined> => read(`brand_prompt:${slug}`).catch(() => undefined);
export const setBrandPromptOverride = (slug: string, prompt: string): Promise<boolean> => write(`brand_prompt:${slug}`, prompt);

// Strict variants for the assistant sync: a failed lookup must fail that
// assistant's sync, not silently push the code-default prompt/voice over an
// approved override (src/assistant/sync.ts).
export const getBrandPromptOverrideStrict = (slug: string): Promise<string | undefined> => read(`brand_prompt:${slug}`);
export const getBrandVoiceIdStrict = (slug: string): Promise<string | undefined> => read(`brand_voice:${slug}`);
/** Any app_setting value; throws on a failed lookup. */
export const readAppSettingStrict = (key: string): Promise<string | undefined> => read(key);

/** True if outbound.app_setting is reachable (migration applied + schema exposed). */
export async function appSettingReady(): Promise<boolean> {
  try {
    await read("__preflight__");
    return true;
  } catch {
    return false;
  }
}
