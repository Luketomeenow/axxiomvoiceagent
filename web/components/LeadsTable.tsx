"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { Lead } from "@/lib/types";
import { Badge } from "./Badge";

const FILTERS = [
  "all",
  "new",
  "calling",
  "qualified",
  "needs_followup",
  "not_interested",
  "no_answer",
  "voicemail",
  "remove",
  "dnc",
  "bad_number",
];

export function LeadsTable({ onAction }: { onAction: () => void }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [callingId, setCallingId] = useState<string | null>(null);

  async function load() {
    let q = supabase.from("lead").select("*").order("lead_score", { ascending: false }).limit(500);
    if (filter !== "all") q = q.eq("disposition", filter);
    const { data } = await q;
    setLeads((data as Lead[]) ?? []);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("leads-table")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "lead" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const filtered = useMemo(() => {
    if (!search.trim()) return leads;
    const s = search.toLowerCase();
    return leads.filter((l) =>
      [l.building_name, l.address, l.city, l.contact_name, l.dial_phone, l.oem_match]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(s)),
    );
  }, [leads, search]);

  async function call(lead: Lead) {
    setCallingId(lead.id);
    try {
      const r = await api.callNow(lead.id);
      if (!r.ok) alert(`Could not place call: ${r.reason ?? "unknown error"}`);
      onAction();
    } finally {
      setCallingId(null);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Leads</h2>
        <span className="text-sm text-slate-400">({filtered.length})</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search building, contact, phone…"
            className="w-56 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-sm"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-sm"
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {f.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-400">
            <tr className="border-b border-white/10">
              <th className="px-2 py-2">Building</th>
              <th className="px-2 py-2">Contact</th>
              <th className="px-2 py-2">Phone</th>
              <th className="px-2 py-2">OEM</th>
              <th className="px-2 py-2">Problem</th>
              <th className="px-2 py-2">Score</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l.id} className="border-b border-white/5 hover:bg-white/5">
                <td className="px-2 py-2">
                  <div className="font-medium">{l.building_name || l.address || "—"}</div>
                  <div className="text-xs text-slate-400">
                    {[l.city, l.state].filter(Boolean).join(", ")}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div>{l.contact_name || "—"}</div>
                  <div className="text-xs text-slate-400">{l.contact_title}</div>
                </td>
                <td className="px-2 py-2 font-mono text-xs">{l.dial_phone || "—"}</td>
                <td className="px-2 py-2">{l.oem_match}</td>
                <td className="px-2 py-2 text-xs">{l.problem_type}</td>
                <td className="px-2 py-2 tabular-nums">{l.lead_score ?? "—"}</td>
                <td className="px-2 py-2">
                  <Badge value={l.disposition} />
                </td>
                <td className="px-2 py-2">
                  <button
                    onClick={() => call(l)}
                    disabled={!l.dial_phone || l.dnc || callingId === l.id}
                    className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-semibold text-ink hover:bg-sky-400 disabled:opacity-40"
                  >
                    {callingId === l.id ? "…" : "Call now"}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-8 text-center text-slate-400">
                  No leads. Import the workbook with <code>bun run import-leads</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
