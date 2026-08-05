"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BrandInfoOption } from "@/lib/api";
import type { CampaignInsight } from "@/lib/types";

/**
 * Per-BRAND continuous improvement. Shows the AI's analysis of the brand's
 * most recent call transcripts (last 50 ended calls, across campaigns): a
 * detailed improvement report + a proposed improved system prompt for that
 * brand's assistant. Self-learning is human-gated — Approve applies the
 * proposed prompt to the live brand agent (blocked if it dropped a required
 * compliance disclosure); or copy the prompt to iterate on it yourself.
 */
export function InsightsPanel() {
  const [brands, setBrands] = useState<BrandInfoOption[]>([]);
  const [brand, setBrand] = useState(""); // slug; "default" = generic/fallback agent
  const [insights, setInsights] = useState<CampaignInsight[]>([]);
  const [busy, setBusy] = useState(false);
  const [openReport, setOpenReport] = useState<Record<string, boolean>>({});
  const [openPrompt, setOpenPrompt] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);
  // Current selection, readable from long-lived poll closures so a poll for one
  // brand can't clobber the list after the operator switches to another.
  const brandRef = useRef(brand);
  brandRef.current = brand;

  useEffect(() => {
    api
      .brandList()
      .then((list) => {
        setBrands(list);
        setBrand((b) => b || list[0]?.slug || "default");
      })
      .catch(() => setBrand((b) => b || "default"));
  }, []);

  const load = useCallback(async () => {
    if (!brand) return;
    try {
      setInsights(await api.brandInsights(brand));
    } catch {
      setInsights([]);
    }
  }, [brand]);

  useEffect(() => {
    setMsg(null);
    load();
  }, [load]);

  async function analyze() {
    if (!brand) return;
    const slug = brand;
    setBusy(true);
    setMsg(null);
    const beforeId = insights[0]?.id ?? null;
    try {
      const res = await api.analyzeBrand(slug);
      if (!res?.ok) {
        setMsg(res?.error ?? "Analysis unavailable.");
        setBusy(false);
        return;
      }
      // The server runs the analysis in the background (1–2 min). Poll for the
      // new insight row instead of holding the request open (which would time out).
      setMsg("Analyzing the brand's last 50 calls… this takes a minute or two. You can leave this page.");
      const deadline = Date.now() + 3 * 60_000;
      const tick = async () => {
        if (brandRef.current !== slug) return; // operator switched brands — stop
        const list = await api.brandInsights(slug).catch(() => null);
        if (list && (list[0]?.id ?? null) !== beforeId) {
          setInsights(list);
          setMsg("Analysis ready.");
          setBusy(false);
          return;
        }
        if (Date.now() > deadline) {
          setMsg("Still working — the analysis will appear here shortly.");
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

  async function approve(id: string) {
    setMsg(null);
    const res = await api.approveInsight(id);
    if (!res?.ok) setMsg(res?.reason ?? "Could not apply.");
    else setMsg("Applied to the live agent.");
    await load();
  }

  async function reject(id: string) {
    await api.rejectInsight(id);
    await load();
  }

  async function copyPrompt(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Prompt copied to clipboard.");
    } catch {
      setMsg("Copy failed — select the text manually.");
    }
  }

  const statusCls: Record<string, string> = {
    proposed: "border-sky-500/30 bg-sky-500/15 text-sky-300",
    applied: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
    rejected: "border-white/10 bg-white/5 text-slate-400",
    approved: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  };

  return (
    <div className="card card-pad">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title">Call analysis &amp; improvements</h2>
          <p className="text-xs text-slate-400">
            AI reviews the brand&apos;s last 50 calls and proposes prompt improvements for that brand&apos;s agent.
            Auto-runs as calls accumulate; or analyze now.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            disabled={busy}
            className="rounded-lg border border-white/10 bg-ink px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500/60"
            title="Which brand agent to analyze"
          >
            {brands.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.displayName}
              </option>
            ))}
            <option value="default">Default outbound agent</option>
          </select>
          <button onClick={analyze} disabled={!brand || busy} className="btn btn-primary btn-xs disabled:opacity-40">
            {busy ? "Analyzing…" : "Analyze now"}
          </button>
        </div>
      </div>

      {msg && <p className="mb-3 rounded-lg border border-white/10 bg-ink/60 px-3 py-2 text-xs text-slate-300">{msg}</p>}

      {brand && insights.length === 0 && (
        <p className="rounded-lg border border-dashed border-white/10 bg-ink/40 px-4 py-6 text-center text-sm text-slate-400">
          No analysis for this brand yet. It runs automatically after enough calls, or click “Analyze now”.
        </p>
      )}

      <div className="space-y-3">
        {insights.map((ins) => (
          <div key={ins.id} className="rounded-xl border border-white/10 bg-ink/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`rounded-full border px-2 py-0.5 ${statusCls[ins.status] ?? "bg-white/10"}`}>
                  {ins.status}
                </span>
                <span className="text-slate-400">{ins.calls_analyzed} calls</span>
                {ins.guardrail_passed === false && (
                  <span
                    className="rounded-full border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-red-300"
                    title={ins.guardrail_notes ?? undefined}
                  >
                    ⚠ compliance guardrail
                  </span>
                )}
                {ins.created_at && <span className="text-slate-500">{new Date(ins.created_at).toLocaleString()}</span>}
              </div>
              {ins.status === "proposed" && (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => approve(ins.id)}
                    disabled={ins.guardrail_passed === false}
                    title={ins.guardrail_passed === false ? ins.guardrail_notes ?? "Blocked by guardrail" : "Apply to the live agent"}
                    className="btn btn-primary btn-xs disabled:opacity-40"
                  >
                    Approve &amp; apply
                  </button>
                  <button onClick={() => reject(ins.id)} className="btn btn-ghost btn-xs">
                    Reject
                  </button>
                </div>
              )}
            </div>

            {ins.report && (
              <div className="mt-2">
                <button
                  onClick={() => setOpenReport((m) => ({ ...m, [ins.id]: !m[ins.id] }))}
                  className="text-xs text-sky-300 hover:underline"
                >
                  {openReport[ins.id] ? "Hide report" : "Show improvement report"}
                </button>
                {openReport[ins.id] && (
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-slate-200">
                    {ins.report}
                  </pre>
                )}
              </div>
            )}

            {ins.suggested_prompt && (
              <div className="mt-2">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setOpenPrompt((m) => ({ ...m, [ins.id]: !m[ins.id] }))}
                    className="text-xs text-sky-300 hover:underline"
                  >
                    {openPrompt[ins.id] ? "Hide proposed prompt" : "Show proposed prompt"}
                  </button>
                  <button onClick={() => copyPrompt(ins.suggested_prompt!)} className="text-xs text-slate-300 hover:underline">
                    Copy prompt
                  </button>
                </div>
                {openPrompt[ins.id] && (
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-slate-200">
                    {ins.suggested_prompt}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
