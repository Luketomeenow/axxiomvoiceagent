"use client";

import { useState } from "react";
import { api } from "@/lib/api";

const PRESETS: { label: string; value: string }[] = [
  { label: "Qualified", value: "qualified" },
  { label: "Needs follow-up", value: "needs_followup" },
  { label: "Remove / DNC", value: "remove,dnc" },
  { label: "All", value: "all" },
];

export function ExportButtons() {
  const [disposition, setDisposition] = useState("qualified");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-panel p-4">
      <span className="text-sm text-slate-400">Export</span>
      <select
        value={disposition}
        onChange={(e) => setDisposition(e.target.value)}
        className="rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-sm"
      >
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <a
        href={api.exportUrl(disposition, "xlsx")}
        className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-ink hover:bg-emerald-400"
      >
        Excel
      </a>
      <a
        href={api.exportUrl(disposition, "csv")}
        className="rounded-lg border border-white/20 px-3 py-1.5 text-sm font-semibold hover:bg-white/10"
      >
        CSV
      </a>
    </div>
  );
}
