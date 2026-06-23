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

const PAGE_SIZES = [25, 50, 100, 200];

export function LeadsTable({
  onAction,
  campaignId,
  refreshKey,
}: {
  onAction: () => void;
  campaignId: string | null;
  refreshKey?: number;
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [callingId, setCallingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  async function load() {
    let q = supabase.from("lead").select("*").order("lead_score", { ascending: false }).limit(2000);
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
  }, [filter, campaignId, refreshKey]);

  const filtered = useMemo(() => {
    if (!search.trim()) return leads;
    const s = search.toLowerCase();
    return leads.filter((l) =>
      [l.building_name, l.address, l.city, l.contact_name, l.dial_phone, l.oem_match]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(s)),
    );
  }, [leads, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));

  // Keep the current page in range whenever the result set or page size changes.
  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), pageCount));
  }, [pageCount]);

  // Jump back to the first page when the filters/search change the result set.
  useEffect(() => {
    setPage(1);
  }, [filter, search, campaignId, pageSize]);

  const start = (page - 1) * pageSize;
  const paged = useMemo(() => filtered.slice(start, start + pageSize), [filtered, start, pageSize]);

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
    <div className="card card-pad">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="section-title">Leads</h2>
        <span className="text-sm text-slate-400">({filtered.length})</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search building, contact, phone…"
          className="field ml-auto w-64"
        />
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`chip transition-colors ${
              filter === f
                ? "border-sky-500/50 bg-sky-500/15 text-sky-200"
                : "border-white/10 bg-white/5 text-slate-400 hover:text-slate-200"
            }`}
          >
            {f.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-400">
            <tr className="border-b border-white/10">
              <th className="px-2 py-2 font-medium">Building</th>
              <th className="px-2 py-2 font-medium">Contact</th>
              <th className="px-2 py-2 font-medium">Phone</th>
              <th className="px-2 py-2 font-medium">OEM</th>
              <th className="px-2 py-2 font-medium">Problem</th>
              <th className="px-2 py-2 font-medium">Score</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {paged.map((l) => (
              <Fragment key={l.id}>
                <tr className="border-b border-white/5 transition-colors hover:bg-white/[0.04]">
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
                  <td className="px-2 py-2 text-slate-300">{l.oem_match || "—"}</td>
                  <td className="px-2 py-2 text-xs text-slate-300">{l.problem_type || "—"}</td>
                  <td className="px-2 py-2">
                    <ScorePill score={l.lead_score} />
                  </td>
                  <td className="px-2 py-2">
                    <Badge value={l.disposition} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => call(l)}
                      disabled={!l.dial_phone || l.dnc || callingId === l.id}
                      className="btn btn-sky btn-xs"
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
                <td colSpan={8} className="px-2 py-10 text-center text-slate-400">
                  No leads yet. Use the <span className="font-medium text-slate-200">Import leads</span> card above to upload
                  your workbook.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
          <span>
            Showing <span className="text-slate-200">{start + 1}</span>–
            <span className="text-slate-200">{Math.min(start + pageSize, filtered.length)}</span> of{" "}
            <span className="text-slate-200">{filtered.length}</span>
          </span>

          <label className="flex items-center gap-1.5">
            <span>Per page</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded-md border border-white/10 bg-ink px-2 py-1 text-xs outline-none focus:border-sky-500/60"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="btn btn-ghost btn-xs"
            >
              Prev
            </button>
            <span>
              Page <span className="text-slate-200">{page}</span> of{" "}
              <span className="text-slate-200">{pageCount}</span>
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
              className="btn btn-ghost btn-xs"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-slate-500">—</span>;
  const tone =
    score >= 80
      ? "bg-emerald-500/15 text-emerald-300"
      : score >= 50
        ? "bg-amber-500/15 text-amber-300"
        : "bg-slate-500/15 text-slate-300";
  return <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${tone}`}>{score}</span>;
}

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <div className="uppercase tracking-wide text-slate-500">{label}</div>
      <div className={mono ? "font-mono text-slate-200" : "text-slate-200"}>{value || "—"}</div>
    </div>
  );
}
