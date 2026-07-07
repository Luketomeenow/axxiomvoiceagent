"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api, type BrandInfoOption, type WindowStatus } from "@/lib/api";
import type { Campaign } from "@/lib/types";

/** "8:00 AM PT (in 1h 48m)"-style countdown for a window that hasn't opened. */
function untilLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

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
  const [brands, setBrands] = useState<BrandInfoOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  // Batch controls: how many calls to dial this run ("" = unlimited) + concurrency.
  const [callsThisRun, setCallsThisRun] = useState("25");
  const [concurrency, setConcurrency] = useState("1");
  const [placedThisRun, setPlacedThisRun] = useState(0);
  // Pre-start confirmation: calling-window status fetched when Start is clicked.
  const [preflight, setPreflight] = useState<WindowStatus | null>(null);

  async function load() {
    const { data } = await supabase.from("campaign").select("*").order("created_at", { ascending: false });
    const list = (data as Campaign[]) ?? [];
    setCampaigns(list);
    // Default to the most recent campaign (one campaign per region).
    if (!campaignId && list.length) onSelect(list[0].id);
  }

  async function setBrand(brand: string) {
    if (!campaign) return;
    setBusy(true);
    try {
      await api.updateCampaign(campaign.id, { brand });
      await load();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    api.brandList().then(setBrands).catch(() => {});
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

  // Keep the concurrency input in sync with the selected campaign.
  useEffect(() => {
    if (campaign) setConcurrency(String(campaign.max_concurrent ?? 1));
  }, [campaign?.id, campaign?.max_concurrent]);

  // Live "dialed this run" counter: call rows created since run_started_at.
  // Polls while the campaign is running so the operator sees the batch fill up.
  useEffect(() => {
    let cancelled = false;
    async function fetchPlaced() {
      if (!campaign?.run_started_at || campaign.max_calls_per_run == null) {
        if (!cancelled) setPlacedThisRun(0);
        return;
      }
      const { count } = await supabase
        .from("call")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaign.id)
        .gte("created_at", campaign.run_started_at);
      if (!cancelled) setPlacedThisRun(count ?? 0);
    }
    fetchPlaced();
    const t = campaign?.status === "running" ? setInterval(fetchPlaced, 5000) : undefined;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [campaign?.id, campaign?.run_started_at, campaign?.max_calls_per_run, campaign?.status]);

  async function toggle() {
    if (!campaign) return;
    if (campaign.status === "running") {
      setBusy(true);
      try {
        await api.pauseCampaign(campaign.id);
        await load();
        onChange();
      } finally {
        setBusy(false);
      }
      return;
    }
    // Starting: show the calling-window preflight first (per-timezone "right
    // time to start"). If the endpoint isn't deployed yet, start directly.
    setBusy(true);
    try {
      const status = await api.windowStatus(campaign.id);
      setPreflight(status);
    } catch {
      await doStart();
    } finally {
      setBusy(false);
    }
  }

  async function doStart() {
    if (!campaign) return;
    setBusy(true);
    try {
      // Empty input = unlimited (null); otherwise dial up to N this run.
      const n = callsThisRun.trim();
      const maxCalls = n === "" ? null : Math.max(1, Number(n) || 0);
      const conc = Math.max(1, Number(concurrency) || 1);
      await api.startCampaign(campaign.id, { maxCalls, maxConcurrent: conc });
      setPreflight(null);
      await load();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function saveConcurrency(value: string) {
    if (!campaign) return;
    const conc = Math.max(1, Number(value) || 1);
    if (conc === campaign.max_concurrent) return;
    setBusy(true);
    try {
      await api.updateCampaign(campaign.id, { maxConcurrent: conc });
      await load();
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
              {campaign.max_concurrent} · max {campaign.max_attempts} attempts · calls/run{" "}
              {campaign.max_calls_per_run ?? "∞"}
            </span>
            <button onClick={startEdit} disabled={busy} className="text-sky-400 hover:text-sky-300">
              Rename
            </button>
            <button onClick={remove} disabled={busy} className="text-rose-400 hover:text-rose-300">
              Delete
            </button>
          </div>
        )}
        {campaign && !editing && (
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span>Brand agent + caller ID:</span>
            <select
              value={campaign.brand ?? ""}
              onChange={(e) => setBrand(e.target.value)}
              disabled={busy}
              className="rounded-lg border border-white/10 bg-ink px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500/60"
            >
              <option value="">Auto — by location &amp; brand</option>
              {brands.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.displayName} · {b.serviceArea}
                </option>
              ))}
            </select>
            {!campaign.brand && (
              <span className="text-slate-500">— picks the right brand &amp; voice per lead automatically</span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-2">
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
            className={`btn ${running ? "btn-danger" : "btn-primary"}`}
          >
            {busy ? "…" : running ? "Pause campaign" : "Start campaign"}
          </button>
        </div>

        {campaign && (
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <label className="flex items-center gap-1.5">
              Calls this run
              <input
                type="number"
                min={1}
                value={callsThisRun}
                onChange={(e) => setCallsThisRun(e.target.value)}
                placeholder="∞"
                disabled={busy || running}
                title="How many calls to place this run before auto-pausing. Leave blank for unlimited."
                className="w-16 rounded-lg border border-white/10 bg-ink px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500/60 disabled:opacity-50"
              />
            </label>
            <label className="flex items-center gap-1.5">
              At once
              <input
                type="number"
                min={1}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                onBlur={(e) => saveConcurrency(e.target.value)}
                disabled={busy}
                title="Max simultaneous calls (concurrency)."
                className="w-14 rounded-lg border border-white/10 bg-ink px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500/60 disabled:opacity-50"
              />
            </label>
          </div>
        )}

        {running && campaign?.max_calls_per_run != null && (
          <div className="text-xs text-slate-400">
            <span className="tabular-nums font-semibold text-slate-200">{placedThisRun}</span> / {campaign.max_calls_per_run}{" "}
            dialed this run
          </div>
        )}
      </div>

      {preflight && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPreflight(null)}>
          <div className="card card-pad w-full max-w-lg space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-lg font-semibold">Start “{preflight.name}”?</div>
              <div className="mt-0.5 text-xs text-slate-400">
                Calling window {preflight.windowStart}:00–{preflight.windowEnd}:00 in each <b>lead’s own timezone</b>
                {preflight.brand ? <> · brand <span className="text-slate-200">{preflight.brand}</span></> : null}
              </div>
            </div>

            {preflight.totalEligible === 0 ? (
              <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                No eligible leads right now — everything is done, capped out, in retry backoff, or on the DNC list.
                Starting is harmless but nothing will dial.
              </div>
            ) : (
              <div className="space-y-2">
                {preflight.groups.map((g) => (
                  <div key={g.timezone} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-ink px-3 py-2 text-sm">
                    <div className="flex items-center gap-2.5">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${g.insideWindow ? "bg-emerald-400" : "bg-amber-400"}`} />
                      <span>
                        <span className="tabular-nums font-semibold text-slate-100">{g.leads.toLocaleString()}</span>{" "}
                        <span className="text-slate-300">{g.states.join("/")} leads</span>
                        <span className="text-slate-500"> · {g.localTime} {g.tzLabel}</span>
                      </span>
                    </div>
                    <span className={`shrink-0 text-xs ${g.insideWindow ? "text-emerald-300" : "text-amber-300"}`}>
                      {g.insideWindow
                        ? "dialable now"
                        : `opens ${preflight.windowStart}:00 ${g.tzLabel} (${untilLabel(g.minutesUntilOpen)})`}
                    </span>
                  </div>
                ))}
                <div className="text-xs text-slate-400">
                  <span className="font-semibold text-slate-200">{preflight.dialableNow.toLocaleString()}</span> of{" "}
                  {preflight.totalEligible.toLocaleString()} eligible leads are inside their window right now
                  {preflight.sampled ? " (large campaign — counts sampled)" : ""}.
                  {preflight.waiting > 0 && (
                    <> Starting is safe — the dialer holds each lead until its local window opens, then begins automatically.</>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={() => setPreflight(null)} disabled={busy} className="btn btn-ghost">
                Cancel
              </button>
              <button onClick={doStart} disabled={busy} className="btn btn-primary">
                {busy
                  ? "…"
                  : preflight.dialableNow > 0
                    ? `Start — ${preflight.dialableNow.toLocaleString()} dialable now`
                    : preflight.groups.length && preflight.totalEligible > 0
                      ? `Start — begins ${preflight.windowStart}:00 ${preflight.groups[0].tzLabel}`
                      : "Start anyway"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
