"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const ORDER = [
  "new",
  "queued",
  "calling",
  "qualified",
  "needs_followup",
  "not_interested",
  "no_answer",
  "voicemail",
  "remove",
  "bad_number",
  "dnc",
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

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      <Stat label="Total leads" value={total} highlight />
      {ORDER.map((k) => (
        <Stat key={k} label={k.replace(/_/g, " ")} value={counts[k] ?? 0} />
      ))}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border border-white/10 p-3 ${highlight ? "bg-emerald-500/10" : "bg-panel"}`}>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}
