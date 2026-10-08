"use client";

import { useEffect, useState } from "react";
import { api, type VoiceOption, type VoiceTarget } from "@/lib/api";

/**
 * Pick the voice of the ElevenLabs evaluation agent. Lists the account's
 * ElevenLabs voices (needs ELEVENLABS_API_KEY), previews them, and applies the
 * choice live. Falls back to a manual voiceId field if the catalog can't be
 * fetched. The Vapi phone agents aren't switched here: they use Vapi's
 * built-in voices, set per brand in code (src/assistant/brands.ts).
 */
export function VoicePicker() {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [current, setCurrent] = useState<Record<VoiceTarget, string>>({ vapi: "", elevenlabs: "" });
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function load() {
    const r = await api.getVoices();
    setVoices(r.voices ?? []);
    setCurrent(r.current ?? { vapi: "", elevenlabs: "" });
    setSelected(r.current?.elevenlabs ?? "");
    setError(r.error ?? null);
  }

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, []);

  function preview() {
    const url = voices.find((v) => v.voiceId === selected)?.previewUrl;
    if (url) new Audio(url).play().catch(() => {});
  }

  async function apply() {
    if (!selected.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.setVoice(selected.trim(), "elevenlabs");
      if (r && r.ok === false) {
        setStatus(`Could not switch: ${r.error ?? "unknown error"}`);
      } else {
        setCurrent((c) => ({ ...c, elevenlabs: selected.trim() }));
        setStatus("Applied to the ElevenLabs agent.");
      }
    } catch (e) {
      setStatus(`Error (is the backend deployed?): ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const selectedVoice = voices.find((v) => v.voiceId === selected);
  const dirty = selected.trim() && selected.trim() !== current.elevenlabs;

  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="section-title">ElevenLabs agent voice</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            For the ElevenLabs evaluation agent. Applies live; other voice settings stay the same. The phone agents
            use Vapi&apos;s built-in voices, set per brand in code
            {current.vapi ? ` (generic agent: ${current.vapi})` : ""}.
          </p>
        </div>
        {selectedVoice?.previewUrl && (
          <button onClick={preview} className="btn btn-ghost btn-xs shrink-0">
            ▶ Preview
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {voices.length > 0 ? (
          <label className="block">
            <span className="label">Voice</span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="field mt-1 min-w-[16rem]"
            >
              {voices.map((v) => (
                <option key={v.voiceId} value={v.voiceId}>
                  {v.name}
                  {v.category ? ` · ${v.category}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="label">Voice ID</span>
            <input
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              placeholder="ElevenLabs voiceId"
              className="field mt-1 min-w-[16rem]"
            />
          </label>
        )}

        <button onClick={apply} disabled={busy || !dirty} className="btn btn-primary">
          {busy ? "Applying…" : "Apply"}
        </button>
        {status && <span className="text-sm text-slate-300">{status}</span>}
      </div>

      {error && (
        <p className="mt-3 text-xs text-amber-300">
          Couldn&apos;t list voices ({error}). Add <code>ELEVENLABS_API_KEY</code> to the backend (.env locally, App Service settings / Key Vault in Azure) for the
          full list with previews — you can still paste a voiceId above. Current:{" "}
          <code>{current.elevenlabs || "—"}</code>
        </p>
      )}
    </div>
  );
}
