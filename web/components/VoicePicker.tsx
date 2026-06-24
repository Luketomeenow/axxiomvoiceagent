"use client";

import { useEffect, useState } from "react";
import { api, type VoiceOption, type VoiceTarget } from "@/lib/api";

const TARGETS: { value: VoiceTarget; label: string }[] = [
  { value: "elevenlabs", label: "ElevenLabs agent" },
  { value: "vapi", label: "Vapi agent" },
];

/**
 * Pick the ElevenLabs voice for ONE agent at a time (independent per target).
 * Lists the account's voices (needs ELEVENLABS_API_KEY), previews them, and
 * applies the choice live to whichever agent is selected. Falls back to a manual
 * voiceId field if the catalog can't be fetched.
 */
export function VoicePicker() {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [target, setTarget] = useState<VoiceTarget>("elevenlabs");
  const [current, setCurrent] = useState<Record<VoiceTarget, string>>({ vapi: "", elevenlabs: "" });
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function load(forTarget: VoiceTarget) {
    const r = await api.getVoices();
    setVoices(r.voices ?? []);
    setCurrent(r.current ?? { vapi: "", elevenlabs: "" });
    setSelected(r.current?.[forTarget] ?? "");
    setError(r.error ?? null);
  }

  useEffect(() => {
    load(target).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchTarget(t: VoiceTarget) {
    setTarget(t);
    setSelected(current[t] ?? "");
    setStatus(null);
  }

  function preview() {
    const url = voices.find((v) => v.voiceId === selected)?.previewUrl;
    if (url) new Audio(url).play().catch(() => {});
  }

  async function apply() {
    if (!selected.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.setVoice(selected.trim(), target);
      if (r && r.ok === false) {
        setStatus(`Could not switch: ${r.error ?? "unknown error"}`);
      } else {
        setCurrent((c) => ({ ...c, [target]: selected.trim() }));
        setStatus(`Applied to the ${target === "vapi" ? "Vapi" : "ElevenLabs"} agent.`);
      }
    } catch (e) {
      setStatus(`Error (is the backend deployed?): ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const selectedVoice = voices.find((v) => v.voiceId === selected);
  const dirty = selected.trim() && selected.trim() !== current[target];

  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="section-title">Voice</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Set each agent&apos;s voice independently. Applies live; other voice settings stay the same.
          </p>
        </div>
        {selectedVoice?.previewUrl && (
          <button onClick={preview} className="btn btn-ghost btn-xs shrink-0">
            ▶ Preview
          </button>
        )}
      </div>

      <div className="mt-3 inline-flex rounded-lg border border-white/10 bg-ink p-1">
        {TARGETS.map((t) => (
          <button
            key={t.value}
            onClick={() => switchTarget(t.value)}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
              target === t.value ? "bg-sky-500 text-ink" : "text-slate-300 hover:bg-white/5"
            } disabled:opacity-50`}
          >
            {t.label}
          </button>
        ))}
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
          {busy ? "Applying…" : `Apply to ${target === "vapi" ? "Vapi" : "ElevenLabs"}`}
        </button>
        {status && <span className="text-sm text-slate-300">{status}</span>}
      </div>

      {error && (
        <p className="mt-3 text-xs text-amber-300">
          Couldn&apos;t list voices ({error}). Add <code>ELEVENLABS_API_KEY</code> to the backend (.env + Railway) for the
          full list with previews — you can still paste a voiceId above. Current ({target}):{" "}
          <code>{current[target] || "—"}</code>
        </p>
      )}
    </div>
  );
}
