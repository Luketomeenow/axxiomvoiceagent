"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDebouncedLoader } from "@/lib/useDebouncedLoader";

/**
 * Compact header indicator: how many calls are live right now, refreshed via
 * Supabase Realtime. Doubles as a quick "is the dashboard connected?" signal —
 * a failed refresh shows "offline?" instead of masquerading as "Idle".
 */
export function LiveStatus() {
  const [active, setActive] = useState(0);

  const load = useCallback(async () => {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("call")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "ringing", "in-progress"])
      .gte("created_at", cutoff);
    if (error) throw new Error(error.message);
    setActive(count ?? 0);
  }, []);

  const { trigger, loadNow, error } = useDebouncedLoader(load);

  useEffect(() => {
    void loadNow();
    const ch = supabase
      .channel("live-status")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "call" }, trigger)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [loadNow, trigger]);

  const live = active > 0;

  if (error) {
    return (
      <div title={error} className="chip border-amber-500/40 bg-amber-500/10 text-amber-300">
        <span className="h-2 w-2 rounded-full bg-amber-400" />
        offline?
      </div>
    );
  }

  return (
    <div
      className={`chip ${
        live
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
          : "border-white/10 bg-white/5 text-slate-400"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-emerald-400" : "bg-slate-500"}`} />
      {live ? `${active} call${active === 1 ? "" : "s"} live` : "Idle"}
    </div>
  );
}
