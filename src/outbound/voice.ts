/**
 * ElevenLabs voice switching for the outbound assistant.
 *
 * The selected voice id is persisted in outbound.app_setting (so it survives
 * `create-outbound-assistant` re-runs) AND applied live by PATCHing the Vapi
 * assistant's `voice`. The ELEVENLABS_VOICE_ID env value stays the fallback —
 * nothing changes until someone picks a different voice in the dashboard.
 */

import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { buildVoice } from "../assistant/voicePipeline.ts";
import { db } from "./db.ts";

const VOICE_SETTING_KEY = "outbound_voice_id";
const VAPI_API = "https://api.vapi.ai";
const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

export interface VoiceOption {
  voiceId: string;
  name: string;
  category?: string;
  previewUrl?: string;
}

/** The currently-selected outbound voice id (persisted override, else env default). */
export async function getOutboundVoiceId(): Promise<string> {
  try {
    const { data } = await db().from("app_setting").select("value").eq("key", VOICE_SETTING_KEY).maybeSingle();
    const v = (data?.value as string | undefined)?.trim();
    if (v) return v;
  } catch (err) {
    log.warn("Could not read persisted voice — using env default", { err: String(err) });
  }
  return env.elevenLabsVoiceId || "burt";
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

/**
 * Persist the chosen voice and apply it live to BOTH agents we're evaluating:
 * the Vapi outbound assistant and the ElevenLabs Conversational AI agent. Each
 * is optional (skipped if its id isn't configured); we report which ones took.
 */
export async function setOutboundVoice(
  voiceId: string,
): Promise<{ ok: boolean; applied: string[]; error?: string }> {
  const id = voiceId.trim();
  if (!id) return { ok: false, applied: [], error: "voiceId is required" };

  // Persist first so it sticks across create-assistant / create-convai-agent re-runs.
  try {
    await db()
      .from("app_setting")
      .upsert({ key: VOICE_SETTING_KEY, value: id, updated_at: new Date().toISOString() }, { onConflict: "key" });
  } catch (err) {
    return { ok: false, applied: [], error: `could not save voice: ${String(err)}` };
  }

  const applied: string[] = [];
  const errors: string[] = [];

  // Vapi assistant — replace voice (keeps the rest of our voice settings).
  if (env.outboundAssistantId && env.vapiApiKey) {
    const res = await fetch(`${VAPI_API}/assistant/${env.outboundAssistantId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ voice: buildVoice(id) }),
    });
    if (res.ok) applied.push("Vapi");
    else errors.push(`Vapi ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }

  // ElevenLabs Convai agent — patch just the voice_id (merges, keeps model/stability/etc.).
  if (env.elevenLabsAgentId && env.elevenLabsApiKey) {
    const res = await fetch(`${ELEVENLABS_API}/convai/agents/${env.elevenLabsAgentId}`, {
      method: "PATCH",
      headers: { "xi-api-key": env.elevenLabsApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_config: { tts: { voice_id: id } } }),
    });
    if (res.ok) applied.push("ElevenLabs");
    else errors.push(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }

  if (!applied.length) {
    return { ok: false, applied, error: errors.join("; ") || "no agent configured to apply the voice to" };
  }
  log.info("Voice switched", { voiceId: id, applied });
  return { ok: true, applied, error: errors.length ? errors.join("; ") : undefined };
}
