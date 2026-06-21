"use client";

import { useState } from "react";
import { api, type TestCallBody } from "@/lib/api";

/**
 * Place a test call to any number so you can hear the outbound agent live.
 * The call streams into the monitor below like any other. Still DNC-checked.
 */
export function TestAgentCard() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<TestCallBody>({ phone: "" });
  const [result, setResult] = useState<string | null>(null);

  function set<K extends keyof TestCallBody>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function placeCall() {
    if (!form.phone.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.testCall(form);
      setResult(r.ok ? "Calling now — watch the live monitor below." : `Could not place call: ${r.reason ?? "unknown error"}`);
    } catch (e) {
      setResult(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Test the agent</h2>
          <p className="text-xs text-slate-400">
            Dial any number to hear the live outbound agent. Only call numbers you&apos;re authorized to reach.
          </p>
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="rounded-lg border border-white/20 px-3 py-1.5 text-sm font-semibold hover:bg-white/10"
        >
          {open ? "Close" : "New test call"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Phone (required)" value={form.phone} onChange={(v) => set("phone", v)} placeholder="+1 415 555 0123" />
            <Input label="Contact name" value={form.name ?? ""} onChange={(v) => set("name", v)} placeholder="Jordan" />
            <Input label="Building name" value={form.buildingName ?? ""} onChange={(v) => set("buildingName", v)} placeholder="Market St Tower" />
            <Input label="City" value={form.city ?? ""} onChange={(v) => set("city", v)} placeholder="San Francisco" />
            <Input label="Problem type" value={form.problemType ?? ""} onChange={(v) => set("problemType", v)} placeholder="overdue inspection" />
            <Input label="Violation code(s)" value={form.violationCodes ?? ""} onChange={(v) => set("violationCodes", v)} placeholder="3.10.4" />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={placeCall}
              disabled={busy || !form.phone.trim()}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-ink hover:bg-sky-400 disabled:opacity-50"
            >
              {busy ? "Placing…" : "Place test call"}
            </button>
            {result && <span className="text-sm text-slate-300">{result}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-sm"
      />
    </label>
  );
}
