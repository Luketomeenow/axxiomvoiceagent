"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
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

export function LeadsTable({ onAction, campaignId }: { onAction: () => void; campaignId: string | null }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [callingId, setCallingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load() {
    let q = supabase.from("lead").select("*").order("lead_score", { ascending: false }).limit(500);
    if (campaignId) q = q.eq("campaign_id", campaignId);
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
  }, [filter, campaignId]);

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
              <Fragment key={l.id}>
                <tr className="border-b border-white/5 hover:bg-white/5">
                  <td className="px-2 py-2">
                    <button
                      onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}
                      className="text-left"
                    >
                      <div className="font-medium">{l.building_name || l.address || "—"}</div>
                      <div className="text-xs text-slate-400">
                        {[l.city, l.state].filter(Boolean).join(", ")}
                      </div>
                    </button>
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
                {expandedId === l.id && (
                  <tr className="border-b border-white/10 bg-white/5">
                    <td colSpan={8} className="px-4 py-3">
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-4">
                        <Field label="Decision maker" value={l.decision_maker == null ? "—" : l.decision_maker ? "Yes" : "No"} />
                        <Field label="Current provider" value={l.current_provider} />
                        <Field label="Timeline" value={l.timeline} />
                        <Field label="Callback name" value={l.callback_name} />
                        <Field label="Callback phone" value={l.callback_phone} mono />
                        <Field label="Callback email" value={l.callback_email} />
                        <Field label="Violation codes" value={l.violation_codes} />
                        <Field label="Region" value={l.region} />
                        <Field label="Qualified at" value={l.qualified_at} />
                      </div>
                      {l.notes && <div className="mt-2 text-xs text-slate-300">Notes: {l.notes}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
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

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <div className="uppercase tracking-wide text-slate-500">{label}</div>
      <div className={mono ? "font-mono text-slate-200" : "text-slate-200"}>{value || "—"}</div>
    </div>
  );
}
