"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { Campaign } from "@/lib/types";

export function CampaignControls({
  campaignId,
  onSelect,
  onChange,
}: {
  campaignId: string | null;
  onSelect: (id: string) => void;
  onChange: () => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

  async function load() {
    const { data } = await supabase.from("campaign").select("*").order("created_at", { ascending: false });
    const list = (data as Campaign[]) ?? [];
    setCampaigns(list);
    // Default to the most recent campaign (one campaign per region).
    if (!campaignId && list.length) onSelect(list[0].id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;

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

  function startEdit() {
    if (!campaign) return;
    setEditName(campaign.name);
    setEditing(true);
  }

  async function saveName() {
    if (!campaign || !editName.trim()) return;
    setBusy(true);
    try {
      const r = await api.updateCampaign(campaign.id, { name: editName.trim() });
      if (r && r.ok === false) {
        alert(`Could not rename: ${r.error ?? "unknown error"}`);
        return;
      }
      setEditing(false);
      await load();
      onChange();
    } catch (e) {
      alert(`Could not rename — is the backend deployed with the latest routes?\n${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!campaign) return;
    if (!confirm(`Delete campaign "${campaign.name}"?\n\nThis permanently removes the campaign and all of its leads and call history. This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await api.deleteCampaign(campaign.id);
      if (r && r.ok === false) {
        alert(`Could not delete: ${r.error ?? "unknown error"}`);
        return;
      }
      setEditing(false);
      const remaining = campaigns.filter((c) => c.id !== campaign.id);
      onSelect(remaining[0]?.id ?? "");
      await load();
      onChange();
    } catch (e) {
      alert(`Could not delete — is the backend deployed with the latest routes?\n${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const running = campaign?.status === "running";

  return (
    <div className="card card-pad flex flex-wrap items-center justify-between gap-4">
      <div>
        <div className="label">Region / campaign</div>
        {editing && campaign ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") setEditing(false);
              }}
              className="rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-lg font-semibold outline-none focus:border-sky-500/60"
            />
            <button onClick={saveName} disabled={busy || !editName.trim()} className="btn btn-primary btn-xs">
              Save
            </button>
            <button onClick={() => setEditing(false)} disabled={busy} className="btn btn-ghost btn-xs">
              Cancel
            </button>
          </div>
        ) : campaigns.length ? (
          <select
            value={campaignId ?? ""}
            onChange={(e) => onSelect(e.target.value)}
            className="mt-1 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-lg font-semibold outline-none focus:border-sky-500/60"
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.region ? `${c.region} — ${c.name}` : c.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-lg font-semibold">No campaign found — import leads first</div>
        )}
        {campaign && !editing && (
          <div className="mt-1 flex items-center gap-3 text-xs text-slate-400">
            <span>
              Window {campaign.call_window_start}:00–{campaign.call_window_end}:00 {campaign.timezone} · concurrency{" "}
              {campaign.max_concurrent} · max {campaign.max_attempts} attempts
            </span>
            <button onClick={startEdit} disabled={busy} className="text-sky-400 hover:text-sky-300">
              Rename
            </button>
            <button onClick={remove} disabled={busy} className="text-rose-400 hover:text-rose-300">
              Delete
            </button>
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
        <button onClick={toggle} disabled={!campaign || busy} className={`btn ${running ? "btn-danger" : "btn-primary"}`}>
          {busy ? "…" : running ? "Pause campaign" : "Start campaign"}
        </button>
      </div>
    </div>
  );
}
