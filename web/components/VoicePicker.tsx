"use client";

import { useEffect, useState } from "react";
import { api, type VoiceOption } from "@/lib/api";

/**
 * Switch the outbound agent's ElevenLabs voice from the dashboard. Lists the
 * account's voices (needs ELEVENLABS_API_KEY on the backend), previews them, and
 * applies the choice live to the Vapi assistant. Falls back to a manual voiceId
 * field if the catalog can't be fetched.
 */
export function VoicePicker() {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selected, setSelected] = useState("");
  const [current, setCurrent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function load() {
    const r = await api.getVoices();
    setVoices(r.voices ?? []);
    setCurrent(r.current ?? "");
    setSelected(r.current ?? "");
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
      const r = await api.setVoice(selected.trim());
      if (r && r.ok === false) {
        setStatus(`Could not switch: ${r.error ?? "unknown error"}`);
      } else {
        setCurrent(selected.trim());
        const where = Array.isArray(r?.applied) && r.applied.length ? r.applied.join(" + ") : "the agent";
        setStatus(`Applied to ${where}.${r?.error ? ` (note: ${r.error})` : ""}`);
      }
    } catch (e) {
      setStatus(`Error (is the backend deployed?): ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const selectedVoice = voices.find((v) => v.voiceId === selected);
  const dirty = selected.trim() && selected.trim() !== current;

  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="section-title">Voice</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Applies to both the ElevenLabs and Vapi agents. New calls/sessions use it; other voice settings stay the same.
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
          {busy ? "Applying…" : "Apply voice"}
        </button>
        {status && <span className="text-sm text-slate-300">{status}</span>}
      </div>

      {error && (
        <p className="mt-3 text-xs text-amber-300">
          Couldn&apos;t list voices ({error}). Add <code>ELEVENLABS_API_KEY</code> to the backend (.env + Railway) for the
          full list with previews — you can still paste a voiceId above. Current: <code>{current || "—"}</code>
        </p>
      )}
    </div>
  );
}
