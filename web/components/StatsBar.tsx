"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Disposition breakdown order + accent dot color.
const BREAKDOWN: { key: string; label: string; dot: string }[] = [
  { key: "new", label: "New", dot: "bg-slate-400" },
  { key: "queued", label: "Queued", dot: "bg-blue-400" },
  { key: "calling", label: "Calling", dot: "bg-yellow-400" },
  { key: "needs_followup", label: "Needs follow-up", dot: "bg-amber-400" },
  { key: "not_interested", label: "Not interested", dot: "bg-slate-400" },
  { key: "no_answer", label: "No answer", dot: "bg-sky-400" },
  { key: "voicemail", label: "Voicemail", dot: "bg-indigo-400" },
  { key: "remove", label: "Remove", dot: "bg-rose-400" },
  { key: "bad_number", label: "Bad number", dot: "bg-zinc-400" },
  { key: "dnc", label: "DNC", dot: "bg-rose-500" },
];

export function StatsBar({ refreshKey, campaignId }: { refreshKey: number; campaignId: string | null }) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabase.from("lead").select("disposition");
      if (campaignId) q = q.eq("campaign_id", campaignId);
      const { data } = await q;
      if (cancelled || !data) return;
      const c: Record<string, number> = {};
      for (const r of data) c[r.disposition] = (c[r.disposition] ?? 0) + 1;
      setCounts(c);
      setTotal(data.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, campaignId]);

  const qualified = counts.qualified ?? 0;
  const inProgress = (counts.calling ?? 0) + (counts.queued ?? 0);
  // Contacted = anything that's no longer "new"/"queued" (i.e. we reached an outcome).
  const untouched = (counts.new ?? 0) + (counts.queued ?? 0);
  const contacted = Math.max(0, total - untouched);
  const contactRate = total ? Math.round((contacted / total) * 100) : 0;
  const qualRate = contacted ? Math.round((qualified / contacted) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Total leads" value={total} hint={campaignId ? "this campaign" : "all campaigns"} />
        <Kpi label="Qualified" value={qualified} hint={`${qualRate}% of contacted`} accent="emerald" />
        <Kpi label="In progress" value={inProgress} hint="queued + calling" accent="sky" />
        <Kpi label="Contacted" value={contacted} hint={`${contactRate}% of total`} progress={contactRate} />
      </div>

      <div className="card card-pad">
        <div className="mb-3 flex items-center justify-between">
          <span className="label">Disposition breakdown</span>
          <span className="text-xs text-slate-500">{total} leads</span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
          {BREAKDOWN.map((b) => (
            <div key={b.key} className="flex items-center justify-between gap-2 border-b border-white/5 pb-2">
              <span className="flex items-center gap-2 text-sm text-slate-300">
                <span className={`h-2 w-2 rounded-full ${b.dot}`} />
                {b.label}
              </span>
              <span className="tabular-nums text-sm font-semibold text-slate-100">{counts[b.key] ?? 0}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  accent,
  progress,
}: {
  label: string;
  value: number;
  hint?: string;
  accent?: "emerald" | "sky";
  progress?: number;
}) {
  const ring =
    accent === "emerald"
      ? "ring-1 ring-emerald-500/20 bg-emerald-500/[0.07]"
      : accent === "sky"
        ? "ring-1 ring-sky-500/20 bg-sky-500/[0.07]"
        : "bg-panel/85";
  return (
    <div className={`card card-pad ${ring}`}>
      <div className="text-3xl font-bold tabular-nums tracking-tight">{value.toLocaleString()}</div>
      <div className="mt-0.5 text-sm font-medium text-slate-300">{label}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
      {typeof progress === "number" && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}
