"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CampaignInsight, SystemRecommendation } from "@/lib/types";

const IMPACT_CLS: Record<string, string> = {
  high: "border-rose-500/30 bg-rose-500/15 text-rose-300",
  medium: "border-amber-500/30 bg-amber-500/15 text-amber-300",
  low: "border-white/10 bg-white/5 text-slate-400",
};

/**
 * System-level AI analysis — the whole operation, not one brand's prompt:
 * reach/deliverability per brand (spam-flag early warning), funnel conversion,
 * failure reasons, best calling hours, cost per qualified lead, and dialer
 * config. Advisory report + prioritized recommendations; nothing auto-applies.
 */
export function SystemInsightsPanel() {
  const [insights, setInsights] = useState<CampaignInsight[]>([]);
  const [busy, setBusy] = useState(false);
  const [openReport, setOpenReport] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInsights(await api.systemInsights());
    } catch {
      setInsights([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function analyze() {
    setBusy(true);
    setMsg(null);
    const beforeId = insights[0]?.id ?? null;
    try {
      const res = await api.analyzeSystem();
      if (!res?.ok) {
        setMsg(res?.error ?? "Analysis unavailable.");
        setBusy(false);
        return;
      }
      setMsg("Reviewing the whole operation… this takes a minute or two. You can leave this page.");
      const deadline = Date.now() + 3 * 60_000;
      const tick = async () => {
        const list = await api.systemInsights().catch(() => null);
        if (list && (list[0]?.id ?? null) !== beforeId) {
          setInsights(list);
          setMsg("Analysis ready.");
          setBusy(false);
          return;
        }
        if (Date.now() > deadline) {
          setMsg("Still working — the report will appear here shortly.");
          setBusy(false);
          await load();
          return;
        }
        setTimeout(tick, 10_000);
      };
      setTimeout(tick, 8_000);
    } catch (err) {
      setMsg(String(err));
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title">System analysis &amp; improvements</h2>
          <p className="text-xs text-slate-400">
            AI reviews the whole operation — reach per brand, funnel, failure reasons, calling hours, costs, and
            dialer settings — and recommends what to fix first.
          </p>
        </div>
        <button onClick={analyze} disabled={busy} className="btn btn-primary btn-xs disabled:opacity-40">
          {busy ? "Analyzing…" : "Analyze system"}
        </button>
      </div>

      {msg && <p className="mb-3 rounded-lg border border-white/10 bg-ink/60 px-3 py-2 text-xs text-slate-300">{msg}</p>}

      {insights.length === 0 && (
        <p className="rounded-lg border border-dashed border-white/10 bg-ink/40 px-4 py-6 text-center text-sm text-slate-400">
          No system analysis yet. Click “Analyze system” to review the operation end to end.
        </p>
      )}

      <div className="space-y-3">
        {insights.map((ins) => {
          const recs = (ins.raw?.recommendations ?? []) as SystemRecommendation[];
          return (
            <div key={ins.id} className="rounded-xl border border-white/10 bg-ink/60 p-3">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="rounded-full border border-violet-500/30 bg-violet-500/15 px-2 py-0.5 text-violet-300">
                  system
                </span>
                <span className="text-slate-400">{ins.calls_analyzed} calls considered</span>
                {ins.created_at && <span className="text-slate-500">{new Date(ins.created_at).toLocaleString()}</span>}
              </div>

              {recs.length > 0 && (
                <div className="mt-3 space-y-2">
                  {recs.map((r, i) => (
                    <div key={i} className="rounded-lg border border-white/10 bg-ink/40 p-2.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className={`rounded-full border px-2 py-0.5 ${IMPACT_CLS[r.impact] ?? IMPACT_CLS.low}`}>
                          {r.impact} impact
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-slate-400">
                          {r.effort} effort
                        </span>
                        <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300">
                          {r.area}
                        </span>
                      </div>
                      <div className="mt-1.5 text-sm font-semibold text-slate-100">{r.title}</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-slate-300">{r.detail}</div>
                    </div>
                  ))}
                </div>
              )}

              {ins.report && (
                <div className="mt-2">
                  <button
                    onClick={() => setOpenReport((m) => ({ ...m, [ins.id]: !m[ins.id] }))}
                    className="text-xs text-sky-300 hover:underline"
                  >
                    {openReport[ins.id] ? "Hide full report" : "Show full report"}
                  </button>
                  {openReport[ins.id] && (
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-slate-200">
                      {ins.report}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
