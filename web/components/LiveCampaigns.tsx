"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Campaign } from "@/lib/types";

/**
 * Live monitor of every RUNNING campaign with realtime call counts. Appears as
 * soon as a campaign is started and updates via Supabase Realtime (campaign +
 * call changes) plus a 5s poll. Per campaign it shows calls dialed this run
 * (vs. the per-run budget), calls active right now, and qualified leads.
 */
interface Row {
  campaign: Campaign;
  dialedThisRun: number;
  active: number;
  qualified: number;
}

export function LiveCampaigns({ onSelect }: { onSelect?: (id: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    const { data: camps } = await supabase
      .from("campaign")
      .select("*")
      .eq("status", "running")
      .order("updated_at", { ascending: false });
    const running = (camps as Campaign[]) ?? [];
    if (!running.length) {
      setRows([]);
      return;
    }
    const ids = running.map((c) => c.id);

    // Active (in-flight) calls + qualified leads across the running campaigns,
    // tallied client-side so it's just two queries regardless of campaign count.
    const [{ data: active }, { data: quals }] = await Promise.all([
      supabase.from("call").select("campaign_id").in("status", ["queued", "ringing", "in-progress"]).in("campaign_id", ids),
      supabase.from("lead").select("campaign_id").eq("disposition", "qualified").in("campaign_id", ids),
    ]);
    const tally = (arr: { campaign_id: string | null }[] | null) => {
      const m = new Map<string, number>();
      for (const r of arr ?? []) if (r.campaign_id) m.set(r.campaign_id, (m.get(r.campaign_id) ?? 0) + 1);
      return m;
    };
    const activeBy = tally(active as { campaign_id: string | null }[] | null);
    const qualBy = tally(quals as { campaign_id: string | null }[] | null);

    // Calls dialed since each run started (= dial attempts this run).
    const dialed = await Promise.all(
      running.map(async (c) => {
        if (!c.run_started_at) return 0;
        const { count } = await supabase
          .from("call")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", c.id)
          .gte("created_at", c.run_started_at);
        return count ?? 0;
      }),
    );

    setRows(
      running.map((c, i) => ({
        campaign: c,
        dialedThisRun: dialed[i],
        active: activeBy.get(c.id) ?? 0,
        qualified: qualBy.get(c.id) ?? 0,
      })),
    );
  }, []);

  useEffect(() => {
    load();
    const ch = supabase
      .channel("live-campaigns")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "campaign" }, load)
      .on("postgres_changes", { event: "*", schema: "outbound", table: "call" }, load)
      .subscribe();
    const t = setInterval(load, 5000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(t);
    };
  }, [load]);

  if (!rows.length) return null; // nothing running — keep the dashboard clean

  const totalActive = rows.reduce((s, r) => s + r.active, 0);

  return (
    <section className="card card-pad">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-title flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          Live campaigns
          <span className="text-sm font-normal text-slate-500">
            {rows.length} running · {totalActive} call{totalActive === 1 ? "" : "s"} active
          </span>
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ campaign: c, dialedThisRun, active, qualified }) => (
          <button
            key={c.id}
            onClick={() => onSelect?.(c.id)}
            className="rounded-xl border border-white/10 bg-ink/40 p-3 text-left transition-colors hover:border-white/25"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-semibold text-slate-100">
                {c.region ? `${c.region} — ${c.name}` : c.name}
              </span>
              <span className="chip shrink-0 border-emerald-500/30 text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                live
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-500">
              {c.brand ?? "auto"} · {c.timezone}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Stat
                label="Calls"
                value={c.max_calls_per_run != null ? `${dialedThisRun}/${c.max_calls_per_run}` : String(dialedThisRun)}
                accent="text-sky-300"
              />
              <Stat label="Active" value={String(active)} accent="text-amber-300" />
              <Stat label="Qualified" value={String(qualified)} accent="text-emerald-300" />
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] py-2">
      <div className={`text-lg font-bold tabular-nums ${accent}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
