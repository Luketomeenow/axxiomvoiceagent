"use client";

import { useEffect, useState } from "react";
import { api, type BrandInfoOption, type TestCallBody } from "@/lib/api";

/**
 * Place a test call to any number so you can hear the outbound agent live.
 * Pick which brand agent to test (its voice + caller ID), or the default.
 * The call streams into the monitor below like any other. Still DNC-checked.
 */
export function TestAgentCard() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<TestCallBody>({ phone: "" });
  const [brands, setBrands] = useState<BrandInfoOption[]>([]);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api.brandList().then(setBrands).catch(() => {});
  }, []);

  function set<K extends keyof TestCallBody>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function placeCall() {
    if (!form.phone.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.testCall(form);
      setResult(r.ok ? "Calling now — watch it in Live calls on the Overview tab." : `Could not place call: ${r.reason ?? "unknown error"}`);
    } catch (e) {
      setResult(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="section-title">Test the agent</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Dial any number to hear the live outbound agent. Only call numbers you&apos;re authorized to reach.
          </p>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost btn-xs shrink-0">
          {open ? "Close" : "New test call"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="label">Agent</span>
              <select
                value={form.brand ?? ""}
                onChange={(e) => set("brand", e.target.value)}
                className="field mt-1 w-full"
              >
                <option value="">Default outbound agent</option>
                {brands.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.displayName}
                  </option>
                ))}
              </select>
            </label>
            <Input label="Phone (required)" value={form.phone} onChange={(v) => set("phone", v)} placeholder="+1 415 555 0123" />
            <Input label="Contact name" value={form.name ?? ""} onChange={(v) => set("name", v)} placeholder="Jordan" />
            <Input label="Building name" value={form.buildingName ?? ""} onChange={(v) => set("buildingName", v)} placeholder="Market St Tower" />
            <Input label="City" value={form.city ?? ""} onChange={(v) => set("city", v)} placeholder="San Francisco" />
            <Input label="Problem type" value={form.problemType ?? ""} onChange={(v) => set("problemType", v)} placeholder="overdue inspection" />
            <Input label="Violation code(s)" value={form.violationCodes ?? ""} onChange={(v) => set("violationCodes", v)} placeholder="3.10.4" />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={placeCall} disabled={busy || !form.phone.trim()} className="btn btn-sky">
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
      <span className="label">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="field mt-1" />
    </label>
  );
}
