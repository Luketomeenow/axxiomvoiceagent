"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/**
 * Compact header indicator: how many calls are live right now, refreshed via
 * Supabase Realtime. Doubles as a quick "is the dashboard connected?" signal.
 */
export function LiveStatus() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from("call")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "ringing", "in-progress"])
        .gte("created_at", cutoff);
      if (!cancelled) setActive(count ?? 0);
    }
    load();
    const ch = supabase
      .channel("live-status")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "call" }, load)
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  const live = active > 0;

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
