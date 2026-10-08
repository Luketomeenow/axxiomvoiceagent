/**
 * Voice switching for the ElevenLabs Conversational AI evaluation agent
 * (dashboard → Agent studio → Voice), persisted as elevenlabs_voice_id in
 * outbound.app_setting so it survives create-convai-agent re-runs;
 * ELEVENLABS_VOICE_ID is the fallback.
 *
 * The Vapi call agents are NOT switched here: they speak with Vapi's native
 * voices, set per brand in src/assistant/brands.ts (the generic agent is brand
 * "default"; optional brand_voice:<slug> overrides) and pushed by the assistant
 * sync. Vapi can't load voices from Axxiom's own ElevenLabs account without an
 * ElevenLabs key in the Vapi account, and there is none.
 */

import { env } from "../config/env.ts";
import { fetchWithTimeout } from "../lib/http.ts";
import { scopedLog } from "../lib/logger.ts";
import { defaultBrand } from "../assistant/brands.ts";
import { getBrandVoiceId } from "./brandStore.ts";
import { db } from "./db.ts";

const log = scopedLog("voice");

/** "vapi" is read-only now (the generic call agent's voice, set in code). */
export type VoiceTarget = "vapi" | "elevenlabs";
const ELEVENLABS_VOICE_KEY = "elevenlabs_voice_id";
const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

export interface VoiceOption {
  voiceId: string;
  name: string;
  category?: string;
  previewUrl?: string;
}

async function readSetting(key: string): Promise<string | undefined> {
  try {
    const { data } = await db().from("app_setting").select("value").eq("key", key).maybeSingle();
    return (data?.value as string | undefined)?.trim() || undefined;
  } catch (err) {
    log.warn("app_setting read failed — using env fallback", { key, err: String(err) });
    return undefined;
  }
}

/** Current ElevenLabs agent voice (persisted, else env). Used by create-convai-agent. */
export async function getElevenLabsAgentVoiceId(): Promise<string> {
  return (await readSetting(ELEVENLABS_VOICE_KEY)) || env.elevenLabsVoiceId || "";
}

/** List the account's ElevenLabs voices (needs ELEVENLABS_API_KEY). */
export async function listElevenLabsVoices(): Promise<VoiceOption[]> {
  if (!env.elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY not set");
  const res = await fetchWithTimeout(`${ELEVENLABS_API}/voices`, {
    headers: { "xi-api-key": env.elevenLabsApiKey },
    timeoutMs: 10_000,
  });
  if (!res.ok) throw new Error(`ElevenLabs voices ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { voices?: Array<Record<string, unknown>> };
  return (json.voices ?? []).map((v) => ({
    voiceId: String(v.voice_id ?? ""),
    name: String(v.name ?? "Unnamed"),
    category: v.category ? String(v.category) : undefined,
    previewUrl: v.preview_url ? String(v.preview_url) : undefined,
  }));
}

/**
 * Current voices: the ElevenLabs agent's (switchable) and, for reference, the
 * generic Vapi call agent's (Vapi native, set in code — see the header).
 */
export async function getCurrentVoices(): Promise<Record<VoiceTarget, string>> {
  const [vapi, elevenlabs] = await Promise.all([
    getBrandVoiceId("default").then((v) => v ?? defaultBrand().voiceId ?? ""),
    getElevenLabsAgentVoiceId(),
  ]);
  return { vapi, elevenlabs };
}

/** Persist + apply a voice to the ElevenLabs agent. */
export async function setAgentVoice(
  voiceId: string,
  target: VoiceTarget,
): Promise<{ ok: boolean; error?: string }> {
  const id = voiceId.trim();
  if (!id) return { ok: false, error: "voiceId is required" };
  if (target === "vapi") {
    return {
      ok: false,
      error:
        "The Vapi call agents use Vapi's built-in voices, set per brand in src/assistant/brands.ts. " +
        "Change it there, deploy, and re-sync the Vapi assistants.",
    };
  }
  if (target !== "elevenlabs") return { ok: false, error: "invalid target" };
  if (!env.elevenLabsAgentId || !env.elevenLabsApiKey) return { ok: false, error: "ElevenLabs agent not configured" };

  // Persist first so it sticks across create-convai-agent re-runs.
  try {
    await db()
      .from("app_setting")
      .upsert({ key: ELEVENLABS_VOICE_KEY, value: id, updated_at: new Date().toISOString() }, { onConflict: "key" });
  } catch (err) {
    return { ok: false, error: `could not save voice: ${String(err)}` };
  }

  // Patch just the voice_id (merges — keeps model/stability/etc.).
  const res = await fetchWithTimeout(`${ELEVENLABS_API}/convai/agents/${env.elevenLabsAgentId}`, {
    method: "PATCH",
    headers: { "xi-api-key": env.elevenLabsApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_config: { tts: { voice_id: id } } }),
    timeoutMs: 10_000,
  });
  if (!res.ok) return { ok: false, error: `ElevenLabs PATCH ${res.status}: ${(await res.text()).slice(0, 200)}` };

  log.info("Voice switched", { voiceId: id, target });
  return { ok: true };
}
