/**
 * ElevenLabs voice switching, INDEPENDENT per agent.
 *
 * Each agent keeps its own voice, persisted in outbound.app_setting (so it
 * survives create-assistant / create-convai-agent re-runs):
 *   - vapi_voice_id        → the Vapi outbound assistant
 *   - elevenlabs_voice_id  → the ElevenLabs Conversational AI agent
 * ELEVENLABS_VOICE_ID stays the fallback for both. Picking a voice in the
 * dashboard applies it to ONLY the chosen target.
 */

import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { buildVoice } from "../assistant/voicePipeline.ts";
import { db } from "./db.ts";

export type VoiceTarget = "vapi" | "elevenlabs";
const VOICE_KEY: Record<VoiceTarget, string> = {
  vapi: "vapi_voice_id",
  elevenlabs: "elevenlabs_voice_id",
};
const VAPI_API = "https://api.vapi.ai";
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

/** Current Vapi assistant voice (persisted, else env). Used by create-outbound-assistant. */
export async function getVapiVoiceId(): Promise<string> {
  return (await readSetting(VOICE_KEY.vapi)) || env.elevenLabsVoiceId || "burt";
}

/** Current ElevenLabs agent voice (persisted, else env). Used by create-convai-agent. */
export async function getElevenLabsAgentVoiceId(): Promise<string> {
  return (await readSetting(VOICE_KEY.elevenlabs)) || env.elevenLabsVoiceId || "";
}

/** List the account's ElevenLabs voices (needs ELEVENLABS_API_KEY). */
export async function listElevenLabsVoices(): Promise<VoiceOption[]> {
  if (!env.elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY not set");
  const res = await fetch(`${ELEVENLABS_API}/voices`, { headers: { "xi-api-key": env.elevenLabsApiKey } });
  if (!res.ok) throw new Error(`ElevenLabs voices ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { voices?: Array<Record<string, unknown>> };
  return (json.voices ?? []).map((v) => ({
    voiceId: String(v.voice_id ?? ""),
    name: String(v.name ?? "Unnamed"),
    category: v.category ? String(v.category) : undefined,
    previewUrl: v.preview_url ? String(v.preview_url) : undefined,
  }));
}

/** Both agents' current voices, for the dashboard to preselect per target. */
export async function getCurrentVoices(): Promise<Record<VoiceTarget, string>> {
  const [vapi, elevenlabs] = await Promise.all([getVapiVoiceId(), getElevenLabsAgentVoiceId()]);
  return { vapi, elevenlabs };
}

/**
 * Persist + apply a voice to ONE agent (independent per target). The other
 * agent is untouched.
 */
export async function setAgentVoice(
  voiceId: string,
  target: VoiceTarget,
): Promise<{ ok: boolean; error?: string }> {
  const id = voiceId.trim();
  if (!id) return { ok: false, error: "voiceId is required" };
  if (target !== "vapi" && target !== "elevenlabs") return { ok: false, error: "invalid target" };

  // Persist first so it sticks across create-assistant / create-convai-agent re-runs.
  try {
    await db()
      .from("app_setting")
      .upsert({ key: VOICE_KEY[target], value: id, updated_at: new Date().toISOString() }, { onConflict: "key" });
  } catch (err) {
    return { ok: false, error: `could not save voice: ${String(err)}` };
  }

  if (target === "vapi") {
    if (!env.outboundAssistantId || !env.vapiApiKey) return { ok: false, error: "Vapi assistant not configured" };
    const res = await fetch(`${VAPI_API}/assistant/${env.outboundAssistantId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ voice: buildVoice(id) }),
    });
    if (!res.ok) return { ok: false, error: `Vapi PATCH ${res.status}: ${(await res.text()).slice(0, 200)}` };
  } else {
    if (!env.elevenLabsAgentId || !env.elevenLabsApiKey) return { ok: false, error: "ElevenLabs agent not configured" };
    // Patch just the voice_id (merges — keeps model/stability/etc.).
    const res = await fetch(`${ELEVENLABS_API}/convai/agents/${env.elevenLabsAgentId}`, {
      method: "PATCH",
      headers: { "xi-api-key": env.elevenLabsApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_config: { tts: { voice_id: id } } }),
    });
    if (!res.ok) return { ok: false, error: `ElevenLabs PATCH ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }

  log.info("Voice switched", { voiceId: id, target });
  return { ok: true };
}
