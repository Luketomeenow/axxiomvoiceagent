"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  api,
  type AnalyticsResponse,
  type ComplianceResponse,
  type FunnelRow,
  type QualityRow,
} from "@/lib/api";
import { BarList, ColumnChart, LineChart, Ring } from "@/components/Charts";

interface CampaignOpt {
  id: string;
  name: string;
  region: string | null;
}

/** Sum the per-campaign funnel rows into one total (for "all campaigns"). */
function sumFunnel(rows: FunnelRow[]): Omit<FunnelRow, "campaign_id" | "name" | "region" | "brand" | "status"> {
  const k: (keyof FunnelRow)[] = [
    "total_leads",
    "contacted",
    "qualified",
    "needs_followup",
    "not_interested",
    "no_contact",
    "removed",
    "dnc_flagged",
    "total_attempts",
  ];
  const out: Record<string, number> = {};
  for (const key of k) out[key] = rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  return out as ReturnType<typeof sumFunnel>;
}

/** Aggregate call-quality rows into headline numbers. */
function sumQuality(rows: QualityRow[]) {
  const calls = rows.reduce((s, r) => s + r.calls, 0);
  const transferred = rows.reduce((s, r) => s + r.transferred, 0);
  const voicemail = rows.reduce((s, r) => s + r.voicemail, 0);
  const noAnswer = rows.reduce((s, r) => s + r.no_answer, 0);
  const failed = rows.reduce((s, r) => s + r.failed, 0);
  // Duration-weighted average across rows that report one.
  const durRows = rows.filter((r) => r.avg_duration_seconds != null);
  const avgDuration = durRows.length
    ? durRows.reduce((s, r) => s + (r.avg_duration_seconds || 0) * r.calls, 0) /
      Math.max(1, durRows.reduce((s, r) => s + r.calls, 0))
    : null;
  const sentRows = rows.filter((r) => r.avg_sentiment != null);
  const avgSentiment = sentRows.length
    ? sentRows.reduce((s, r) => s + (r.avg_sentiment || 0) * r.calls, 0) /
      Math.max(1, sentRows.reduce((s, r) => s + r.calls, 0))
    : null;
  return { calls, transferred, voicemail, noAnswer, failed, avgDuration, avgSentiment };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const fmtDur = (s: number | null) => (s == null ? "—" : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

export default function AnalyticsPage() {
  const [campaigns, setCampaigns] = useState<CampaignOpt[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [compliance, setCompliance] = useState<ComplianceResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("campaign")
        .select("id, name, region")
        .order("created_at", { ascending: false });
      setCampaigns((data as CampaignOpt[]) ?? []);
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, c] = await Promise.all([api.analytics(campaignId, days), api.compliance(campaignId, 100)]);
    setData(a);
    setCompliance(c);
    setLoading(false);
  }, [campaignId, days]);

  useEffect(() => {
    load();
  }, [load]);

  const funnel = data ? sumFunnel(data.funnel) : null;
  const quality = data ? sumQuality(data.quality) : null;
  const contactRate = funnel ? pct(funnel.contacted, funnel.total_leads) : 0;
  const qualRate = funnel ? pct(funnel.qualified, funnel.contacted) : 0;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-sky-400 text-sm font-black text-ink shadow-glow">
              AX
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight tracking-tight">Analytics &amp; Tracking</h1>
              <p className="text-xs text-slate-400">Outbound campaign performance · compliance audit · call quality</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="field !w-auto"
              value={campaignId ?? ""}
              onChange={(e) => setCampaignId(e.target.value || null)}
            >
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.region ? ` · ${c.region}` : ""}
                </option>
              ))}
            </select>
            <select className="field !w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
            <Link href="/" className="btn btn-ghost btn-xs">
              ← Console
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 p-5">
        {data?.unresolvedFailures ? (
          <div className="card card-pad border-rose-500/30 bg-rose-500/[0.06] text-sm text-rose-200">
            ⚠️ {data.unresolvedFailures} unresolved write failure{data.unresolvedFailures === 1 ? "" : "s"} in the
            dead-letter queue (<code>outbound.failed_op</code>). Investigate before trusting the numbers below.
          </div>
        ) : null}

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Total leads" value={funnel?.total_leads ?? 0} hint={campaignId ? "this campaign" : "all campaigns"} />
          <Kpi label="Contacted" value={funnel?.contacted ?? 0} hint={`${contactRate}% of total`} accent="sky" />
          <Kpi label="Qualified" value={funnel?.qualified ?? 0} hint={`${qualRate}% of contacted`} accent="emerald" />
          <Kpi label="Total dials" value={funnel?.total_attempts ?? 0} hint="across all attempts" />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Funnel */}
          <section className="card card-pad">
            <h2 className="section-title mb-3">Conversion funnel</h2>
            {funnel && (
              <BarList
                items={[
                  { label: "Total leads", value: funnel.total_leads, accent: "slate" },
                  { label: "Contacted", value: funnel.contacted, accent: "sky", hint: `${contactRate}%` },
                  { label: "Qualified", value: funnel.qualified, accent: "emerald", hint: `${qualRate}% of contacted` },
                  { label: "Needs follow-up", value: funnel.needs_followup, accent: "amber" },
                  { label: "Not interested", value: funnel.not_interested, accent: "slate" },
                  { label: "No contact (NA/VM)", value: funnel.no_contact, accent: "indigo" },
                  { label: "DNC / removed", value: funnel.removed + funnel.dnc_flagged, accent: "rose" },
                ]}
              />
            )}
          </section>

          {/* Trends */}
          <section className="card card-pad">
            <h2 className="section-title mb-3">Daily activity ({days}d)</h2>
            <LineChart
              rows={(data?.daily ?? []).map((d) => ({ day: d.day.slice(5), calls: d.calls, qualified: d.qualified }))}
              xKey="day"
              series={[
                { key: "calls", label: "Calls", accent: "sky" },
                { key: "qualified", label: "Qualified", accent: "emerald" },
              ]}
            />
          </section>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Call quality */}
          <section className="card card-pad">
            <h2 className="section-title mb-3">Call quality</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Mini label="Calls placed" value={(quality?.calls ?? 0).toLocaleString()} />
              <Mini label="Avg duration" value={fmtDur(quality?.avgDuration ?? null)} />
              <Mini
                label="Avg sentiment"
                value={quality?.avgSentiment == null ? "—" : quality.avgSentiment.toFixed(2)}
              />
              <Mini label="Transfer rate" value={`${pct(quality?.transferred ?? 0, quality?.calls ?? 0)}%`} />
              <Mini label="Voicemail rate" value={`${pct(quality?.voicemail ?? 0, quality?.calls ?? 0)}%`} />
              <Mini label="No-answer rate" value={`${pct(quality?.noAnswer ?? 0, quality?.calls ?? 0)}%`} />
            </div>
            {quality && quality.failed > 0 && (
              <p className="mt-3 text-xs text-rose-300">{quality.failed} call(s) failed to place.</p>
            )}
          </section>

          {/* Attempts distribution */}
          <section className="card card-pad">
            <h2 className="section-title mb-1">Attempts per lead</h2>
            <p className="mb-3 text-xs text-slate-500">Bars = leads at each attempt count · green = qualified</p>
            <ColumnChart
              data={(data?.attempts ?? [])
                .filter((a) => a.attempts > 0)
                .map((a) => ({ label: String(a.attempts), value: a.leads, sub: a.qualified }))}
            />
          </section>
        </div>

        {/* Compliance */}
        <section className="card card-pad">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="section-title">Compliance audit</h2>
            <span className="text-xs text-slate-500">last {compliance?.rows.length ?? 0} calls</span>
          </div>
          <div className="mb-4 flex flex-wrap gap-8">
            <Ring
              pct={pct(compliance?.summary.disclosed ?? 0, compliance?.summary.total ?? 0)}
              label="AI disclosure spoken"
              accent="sky"
            />
            <Ring
              pct={pct(compliance?.summary.consented ?? 0, compliance?.summary.total ?? 0)}
              label="Recording consent captured"
              accent="emerald"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Phone</th>
                  <th className="py-2 pr-3">Brand</th>
                  <th className="py-2 pr-3">Disclosed</th>
                  <th className="py-2 pr-3">Consent</th>
                  <th className="py-2 pr-3">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {(compliance?.rows ?? []).slice(0, 50).map((r) => (
                  <tr key={r.call_id} className="border-b border-white/5">
                    <td className="py-2 pr-3 text-slate-400">
                      {r.started_at ? new Date(r.started_at).toLocaleString() : "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-300">{r.phone_number ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-400">{r.brand ?? "—"}</td>
                    <td className="py-2 pr-3">{r.disclosure_logged || r.disclosure_event ? <Yes /> : <No />}</td>
                    <td className="py-2 pr-3">{r.consent_captured || r.consent_event ? <Yes /> : <Dash />}</td>
                    <td className="py-2 pr-3 text-slate-300">{r.outcome ?? r.disposition ?? "—"}</td>
                  </tr>
                ))}
                {!compliance?.rows.length && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500">
                      No completed calls in range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {loading && <p className="text-center text-sm text-slate-500">Loading…</p>}
      </main>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number;
  hint?: string;
  accent?: "emerald" | "sky";
}) {
  const ring =
    accent === "emerald"
      ? "ring-1 ring-emerald-500/20 bg-emerald-500/[0.07]"
      : accent === "sky"
        ? "ring-1 ring-sky-500/20 bg-sky-500/[0.07]"
        : "bg-panel/85";
  return (
    <div className={`card card-pad ${ring}`}>
      <div className="text-3xl font-bold tabular-nums tracking-tight">{value.toLocaleString()}</div>
      <div className="mt-0.5 text-sm font-medium text-slate-300">{label}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-ink/40 p-3">
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  );
}

const Yes = () => <span className="chip border-emerald-500/30 text-emerald-300">✓ yes</span>;
const No = () => <span className="chip border-rose-500/30 text-rose-300">✗ no</span>;
const Dash = () => <span className="chip border-white/10 text-slate-500">n/a</span>;
