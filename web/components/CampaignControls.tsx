"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { Campaign } from "@/lib/types";

export function CampaignControls({ onChange }: { onChange: () => void }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data } = await supabase
      .from("campaign")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setCampaign((data as Campaign) ?? null);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("campaign-changes")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "campaign" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  async function toggle() {
    if (!campaign) return;
    setBusy(true);
    try {
      if (campaign.status === "running") await api.pauseCampaign(campaign.id);
      else await api.startCampaign(campaign.id);
      await load();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const running = campaign?.status === "running";

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-panel p-4">
      <div>
        <div className="text-sm text-slate-400">Campaign</div>
        <div className="text-lg font-semibold">{campaign?.name ?? "No campaign found — import leads first"}</div>
        {campaign && (
          <div className="mt-1 text-xs text-slate-400">
            Window {campaign.call_window_start}:00–{campaign.call_window_end}:00 {campaign.timezone} · concurrency{" "}
            {campaign.max_concurrent} · max {campaign.max_attempts} attempts
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${
            running ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-600/30 text-slate-300"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${running ? "animate-pulse bg-emerald-400" : "bg-slate-400"}`} />
          {campaign?.status ?? "—"}
        </span>
        <button
          onClick={toggle}
          disabled={!campaign || busy}
          className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
            running ? "bg-rose-500 hover:bg-rose-400" : "bg-emerald-500 hover:bg-emerald-400 text-ink"
          }`}
        >
          {busy ? "…" : running ? "Pause campaign" : "Start campaign"}
        </button>
      </div>
    </div>
  );
}
