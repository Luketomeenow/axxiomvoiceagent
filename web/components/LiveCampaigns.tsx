"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDebouncedLoader } from "@/lib/useDebouncedLoader";
import ErrorChip from "./ErrorChip";
import type { Campaign } from "@/lib/types";

/**
 * Live monitor of every RUNNING campaign with realtime call counts. Appears as
 * soon as a campaign is started; updates via Supabase Realtime (campaign +
 * call changes, debounced) with a slow safety poll covering dropped websockets.
 * Per campaign it shows calls dialed this run (vs. the per-run budget), calls
 * active right now, and qualified leads — read from outbound.v_campaign_live in
 * one query instead of per-campaign counts.
 */
interface Row {
  campaign: Campaign;
  dialedThisRun: number;
  active: number;
  qualified: number;
}

interface LiveRow {
  campaign_id: string;
  dialed_this_run: number;
  active_calls: number;
  qualified: number;
}

export function LiveCampaigns({ onSelect }: { onSelect?: (id: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    const { data: camps, error: campErr } = await supabase
      .from("campaign")
      .select("*")
      .eq("status", "running")
      .order("updated_at", { ascending: false });
    if (campErr) throw new Error(campErr.message);
    const running = (camps as Campaign[]) ?? [];
    if (!running.length) {
      setRows([]);
      return;
    }

    const { data: live, error: liveErr } = await supabase
      .from("v_campaign_live")
      .select("campaign_id, dialed_this_run, active_calls, qualified")
      .in("campaign_id", running.map((c) => c.id));
    if (liveErr) throw new Error(liveErr.message);
    const liveBy = new Map(((live as LiveRow[]) ?? []).map((r) => [r.campaign_id, r]));

    setRows(
      running.map((c) => ({
        campaign: c,
        dialedThisRun: liveBy.get(c.id)?.dialed_this_run ?? 0,
        active: liveBy.get(c.id)?.active_calls ?? 0,
        qualified: liveBy.get(c.id)?.qualified ?? 0,
      })),
    );
  }, []);

  const { trigger, loadNow, error } = useDebouncedLoader(load);

  useEffect(() => {
    void loadNow();
    const ch = supabase
      .channel("live-campaigns")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "campaign" }, trigger)
      .on("postgres_changes", { event: "*", schema: "outbound", table: "call" }, trigger)
      .subscribe();
    // Realtime is the primary signal — the slow poll only covers a dropped websocket.
    const t = setInterval(trigger, 30_000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(t);
    };
  }, [loadNow, trigger]);

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
          <ErrorChip error={error} />
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
