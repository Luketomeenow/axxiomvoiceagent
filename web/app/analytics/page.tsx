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
  const sum = (f: (r: QualityRow) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const calls = sum((r) => r.calls);
  const connected = sum((r) => r.connected);
  const transferred = sum((r) => r.transferred);
  const voicemail = sum((r) => r.voicemail);
  const noAnswer = sum((r) => r.no_answer);
  const ivr = sum((r) => r.ivr ?? 0);
  const failed = sum((r) => r.failed);
  const stale = sum((r) => r.stale);
  const endedCustomer = sum((r) => r.ended_customer);
  const endedAgent = sum((r) => r.ended_agent);
  const endedOperator = sum((r) => r.ended_operator);
  const endedSystem = sum((r) => r.ended_system);
  // Twilio AMD (0 until machine detection is enabled) + carrier status.
  const answeredHuman = sum((r) => r.answered_human ?? 0);
  const answeredMachine = sum((r) => r.answered_machine ?? 0);
  const answeredFax = sum((r) => r.answered_fax ?? 0);
  const statusCompleted = sum((r) => r.status_completed ?? 0);
  const statusBusy = sum((r) => r.status_busy ?? 0);
  const statusNoAnswer = sum((r) => r.status_no_answer ?? 0);
  const statusFailed = sum((r) => r.status_failed ?? 0);
  const statusCanceled = sum((r) => r.status_canceled ?? 0);
  const vapiCost = sum((r) => Number(r.vapi_cost) || 0);
  const telephonyCost = sum((r) => Number(r.telephony_cost) || 0);
  const totalCost = sum((r) => Number(r.total_cost) || 0);
  // Duration-weighted averages across rows that report one.
  const wAvg = (pick: (r: QualityRow) => number | null) => {
    const rs = rows.filter((r) => pick(r) != null);
    return rs.length
      ? rs.reduce((s, r) => s + (pick(r) || 0) * r.calls, 0) / Math.max(1, rs.reduce((s, r) => s + r.calls, 0))
      : null;
  };
  return {
    calls,
    connected,
    transferred,
    voicemail,
    noAnswer,
    ivr,
    failed,
    stale,
    endedCustomer,
    endedAgent,
    endedOperator,
    endedSystem,
    answeredHuman,
    answeredMachine,
    answeredFax,
    amdTotal: answeredHuman + answeredMachine + answeredFax,
    statusCompleted,
    statusBusy,
    statusNoAnswer,
    statusFailed,
    statusCanceled,
    statusTotal: statusCompleted + statusBusy + statusNoAnswer + statusFailed + statusCanceled,
    vapiCost,
    telephonyCost,
    totalCost,
    avgDuration: wAvg((r) => r.avg_duration_seconds),
    avgTalk: wAvg((r) => r.avg_talk_seconds),
    avgSentiment: wAvg((r) => r.avg_sentiment),
  };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const fmtDur = (s: number | null) => (s == null ? "—" : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const fmtMoney = (n: number) => `$${(n || 0).toFixed(n >= 100 ? 0 : 2)}`;
const fmtMoney4 = (n: number) => `$${(n || 0).toFixed(4)}`;

export default function AnalyticsPage() {
  const [campaigns, setCampaigns] = useState<CampaignOpt[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [compliance, setCompliance] = useState<ComplianceResponse | null>(null);
  const [compPage, setCompPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

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
    const [a, c] = await Promise.all([api.analytics(campaignId, days), api.compliance(campaignId, 200)]);
    setData(a);
    setCompliance(c);
    setCompPage(0);
    setLoading(false);
  }, [campaignId, days]);

  useEffect(() => {
    load();
  }, [load]);

  const funnel = data ? sumFunnel(data.funnel) : null;
  const quality = data ? sumQuality(data.quality) : null;
  const contactRate = funnel ? pct(funnel.contacted, funnel.total_leads) : 0;
  const qualRate = funnel ? pct(funnel.qualified, funnel.contacted) : 0;
  const connectRate = quality ? pct(quality.connected, quality.calls) : 0;
  const costPerCall = quality && quality.calls > 0 ? quality.totalCost / quality.calls : null;
  const costPerQualified = quality && funnel && funnel.qualified > 0 ? quality.totalCost / funnel.qualified : null;

  async function syncTwilio() {
    setSyncing(true);
    try {
      await api.syncTwilio(campaignId);
      await load();
    } finally {
      setSyncing(false);
    }
  }

  // Per-brand rollup (brand ≈ one Twilio caller-ID today): volume, connect rate, cost.
  const byBrand = (() => {
    const m = new Map<string, { calls: number; connected: number; cost: number }>();
    for (const r of data?.quality ?? []) {
      const key = r.brand || "—";
      const e = m.get(key) ?? { calls: 0, connected: 0, cost: 0 };
      e.calls += r.calls;
      e.connected += r.connected;
      e.cost += Number(r.total_cost) || 0;
      m.set(key, e);
    }
    return [...m.entries()].map(([brand, v]) => ({ brand, ...v })).sort((a, b) => b.calls - a.calls);
  })();

  // Connect rate by hour-of-day (Pacific) — "when do people actually answer?".
  // Rolls up the per-campaign hourly rows into one row per hour.
  const byHour = (() => {
    const m = new Map<number, { calls: number; connected: number; qualified: number }>();
    for (const r of data?.hourly ?? []) {
      const e = m.get(r.hour_pt) ?? { calls: 0, connected: 0, qualified: 0 };
      e.calls += r.calls;
      e.connected += r.connected;
      e.qualified += r.qualified;
      m.set(r.hour_pt, e);
    }
    return [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, v]) => ({ hour, ...v, rate: v.calls ? Math.round((v.connected / v.calls) * 100) : 0 }));
  })();
  const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;

  // Compliance pagination (keep the audit list compact + scrollable).
  const COMP_PAGE = 10;
  const compRows = compliance?.rows ?? [];
  const compPages = Math.max(1, Math.ceil(compRows.length / COMP_PAGE));
  const compSlice = compRows.slice(compPage * COMP_PAGE, compPage * COMP_PAGE + COMP_PAGE);

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
            <button onClick={syncTwilio} disabled={syncing} className="btn btn-ghost btn-xs disabled:opacity-40" title="Pull Twilio call cost + carrier status onto recent calls">
              {syncing ? "Syncing…" : "↻ Twilio costs"}
            </button>
            <Link href="/docs" className="btn btn-ghost btn-xs">
              📖 Docs
            </Link>
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

        {/* Cost & reach — Vapi platform cost + Twilio telephony cost */}
        <section className="card card-pad">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="section-title">Cost &amp; reach</h2>
            <span className="text-xs text-slate-500">Vapi (AI) + Twilio (telephony)</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Mini label="Total cost" value={fmtMoney(quality?.totalCost ?? 0)} />
            <Mini label="Cost / call" value={costPerCall == null ? "—" : fmtMoney4(costPerCall)} />
            <Mini label="Cost / qualified" value={costPerQualified == null ? "—" : fmtMoney(costPerQualified)} />
            <Mini label="Connect rate" value={`${connectRate}%`} />
            <Mini label="AI cost (Vapi)" value={fmtMoney(quality?.vapiCost ?? 0)} />
            <Mini label="Telephony (Twilio)" value={fmtMoney(quality?.telephonyCost ?? 0)} />
          </div>
          {quality && quality.calls > 0 && quality.telephonyCost === 0 && (
            <p className="mt-3 text-xs text-amber-300">
              Telephony cost is $0 — click “↻ Twilio costs” above (and set TWILIO creds on the server) to pull
              authoritative per-call pricing from Twilio.
            </p>
          )}
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Reach breakdown. IMPORTANT: "connected" = a call the agent talked on
              (ended_by customer/agent). It does NOT distinguish a live person from
              a machine until voicemail detection is ON + the ivr disposition ships
              — so we label it "Answered" and warn when the machine split is missing. */}
          <section className="card card-pad">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="section-title">Who we reached</h2>
              {quality &&
                quality.calls > 0 &&
                (quality.amdTotal > 0 ? (
                  <span className="text-xs text-emerald-300">
                    {pct(quality.answeredHuman, quality.amdTotal)}% reached a person
                  </span>
                ) : (
                  <span className="text-xs text-emerald-300">{pct(quality.connected, quality.calls)}% answered</span>
                ))}
            </div>
            {quality && quality.amdTotal > 0 ? (
              <>
                <p className="mb-3 text-xs text-slate-500">
                  Live human vs. machine, from Twilio answering-machine detection. Getting more calls to a real
                  decision-maker is the lever for qualified leads.
                </p>
                <BarList
                  items={[
                    { label: "Reached a person", value: quality.answeredHuman, accent: "emerald" },
                    { label: "Answering machine / voicemail", value: quality.answeredMachine, accent: "indigo" },
                    { label: "Fax", value: quality.answeredFax, accent: "slate" },
                    { label: "No answer", value: quality.noAnswer, accent: "slate" },
                    { label: "Failed to place (dial error)", value: quality.failed, accent: "rose" },
                  ]}
                />
                <p className="mt-3 text-xs text-slate-400">
                  Machines:{" "}
                  <span className="font-semibold text-slate-200">
                    {pct(quality.answeredMachine + quality.answeredFax, quality.amdTotal)}%
                  </span>{" "}
                  of answered calls (Twilio AMD). Lower it with direct-dial numbers, IVR navigation, and best-time
                  calling.
                </p>
              </>
            ) : (
              <>
                <p className="mb-3 text-xs text-slate-500">
                  “Answered” = the call connected and the agent spoke. Getting more of those to a real decision-maker
                  (vs. a machine or switchboard) is the lever for qualified leads.
                </p>
                {quality && (
                  <BarList
                    items={[
                      { label: "Answered (incl. machines)", value: quality.connected, accent: "emerald" },
                      { label: "Voicemail", value: quality.voicemail, accent: "indigo" },
                      { label: "Automated menu (IVR)", value: quality.ivr, accent: "amber" },
                      { label: "No answer", value: quality.noAnswer, accent: "slate" },
                      { label: "Failed to place (dial error)", value: quality.failed, accent: "rose" },
                    ]}
                  />
                )}
                {quality && quality.calls > 0 && (
                  <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    ⚠ “Answered” still includes answering machines &amp; phone-tree menus — Twilio machine detection
                    isn’t on yet, so this over-counts real people. Set{" "}
                    <span className="font-mono">ENABLE_VOICEMAIL_DETECTION=true</span> (Twilio AMD) to split people from
                    machines. (Recent transcripts suggest ~half of “answered” calls are actually machines.)
                  </p>
                )}
              </>
            )}
          </section>

          {/* Best time to call — connect rate by hour (Pacific), from v_call_hourly */}
          <section className="card card-pad">
            <h2 className="section-title mb-1">Best time to call</h2>
            <p className="mb-3 text-xs text-slate-500">
              Connect rate by hour (Pacific) · green = qualified. Dial when people actually answer.
            </p>
            {byHour.length > 0 ? (
              <ColumnChart
                data={byHour.map((h) => ({ label: hourLabel(h.hour), value: h.rate, sub: h.qualified }))}
              />
            ) : (
              <p className="rounded-lg border border-dashed border-white/10 bg-ink/40 px-4 py-6 text-center text-sm text-slate-500">
                No hourly data yet — re-run <span className="font-mono">outbound_schema.sql</span> to add the
                <span className="font-mono"> v_call_hourly</span> view, then place a few calls.
              </p>
            )}
          </section>
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
              <Mini label="Connect rate" value={`${connectRate}%`} />
              <Mini label="Avg talk (connected)" value={fmtDur(quality?.avgTalk ?? null)} />
              <Mini
                label="Avg sentiment"
                value={quality?.avgSentiment == null ? "—" : quality.avgSentiment.toFixed(2)}
              />
              <Mini label="Transfer rate" value={`${pct(quality?.transferred ?? 0, quality?.calls ?? 0)}%`} />
              <Mini label="No-answer rate" value={`${pct(quality?.noAnswer ?? 0, quality?.calls ?? 0)}%`} />
            </div>

            <h3 className="mt-4 mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Who ended the call</h3>
            <BarList
              items={[
                { label: "They hung up", value: quality?.endedCustomer ?? 0, accent: "amber" },
                { label: "Agent ended", value: quality?.endedAgent ?? 0, accent: "sky" },
                { label: "We ended (operator)", value: quality?.endedOperator ?? 0, accent: "emerald" },
                { label: "System (no-answer/VM/error)", value: quality?.endedSystem ?? 0, accent: "slate" },
              ]}
            />
            {quality && (quality.failed > 0 || quality.stale > 0) && (
              <p className="mt-3 text-xs text-rose-300">
                {quality.failed > 0 && `${quality.failed} failed to place. `}
                {quality.stale > 0 && `${quality.stale} timed out (missed end-of-call webhook).`}
              </p>
            )}

            {/* Twilio carrier status — the network's own disposition (from twilioSync). */}
            {quality && quality.statusTotal > 0 && (
              <>
                <h3 className="mt-4 mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  Carrier status (Twilio)
                </h3>
                <BarList
                  items={[
                    { label: "Completed", value: quality.statusCompleted, accent: "emerald" },
                    { label: "Busy", value: quality.statusBusy, accent: "amber" },
                    { label: "No answer", value: quality.statusNoAnswer, accent: "slate" },
                    { label: "Failed (carrier)", value: quality.statusFailed, accent: "rose" },
                    { label: "Canceled", value: quality.statusCanceled, accent: "slate" },
                  ]}
                />
              </>
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

        {/* Caller-ID / brand health — spread load; a dropping connect rate can signal spam-flagging */}
        {byBrand.length > 0 && (
          <section className="card card-pad">
            <h2 className="section-title mb-1">Caller-ID / brand health</h2>
            <p className="mb-3 text-xs text-slate-500">
              Volume, connect rate, and cost per brand number. Watch for a brand’s connect rate dropping — a sign its
              caller ID may be getting spam-flagged (rotate / register STIR/SHAKEN).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3">Brand</th>
                    <th className="py-2 pr-3">Calls</th>
                    <th className="py-2 pr-3">Connect rate</th>
                    <th className="py-2 pr-3">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byBrand.map((b) => (
                    <tr key={b.brand} className="border-b border-white/5">
                      <td className="py-2 pr-3 text-slate-200">{b.brand}</td>
                      <td className="py-2 pr-3 tabular-nums text-slate-300">{b.calls.toLocaleString()}</td>
                      <td className="py-2 pr-3 tabular-nums text-slate-300">{pct(b.connected, b.calls)}%</td>
                      <td className="py-2 pr-3 tabular-nums text-slate-300">{fmtMoney(b.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Compliance */}
        <section className="card card-pad">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="section-title">Compliance audit</h2>
            <span className="text-xs text-slate-500">{compRows.length} calls in range</span>
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
          {/* Capped-height + scrollable so a long audit list never dominates the page. */}
          <div className="max-h-[22rem] overflow-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 z-10 bg-panel/95 backdrop-blur">
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Brand</th>
                  <th className="px-3 py-2">Disclosed</th>
                  <th className="px-3 py-2">Consent</th>
                  <th className="px-3 py-2">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {compSlice.map((r) => (
                  <tr key={r.call_id} className="border-b border-white/5">
                    <td className="px-3 py-2 text-slate-400">
                      {r.started_at ? new Date(r.started_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-300">{r.phone_number ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-400">{r.brand ?? "—"}</td>
                    <td className="px-3 py-2">{r.disclosure_logged || r.disclosure_event ? <Yes /> : <No />}</td>
                    <td className="px-3 py-2">{r.consent_captured || r.consent_event ? <Yes /> : <Dash />}</td>
                    <td className="px-3 py-2 text-slate-300">{r.outcome ?? r.disposition ?? "—"}</td>
                  </tr>
                ))}
                {!compRows.length && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500">
                      No completed calls in range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {compRows.length > COMP_PAGE && (
            <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
              <span>
                {compPage * COMP_PAGE + 1}–{Math.min((compPage + 1) * COMP_PAGE, compRows.length)} of {compRows.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCompPage((p) => Math.max(0, p - 1))}
                  disabled={compPage === 0}
                  className="btn btn-ghost btn-xs disabled:opacity-40"
                >
                  ← Prev
                </button>
                <span className="tabular-nums">
                  {compPage + 1} / {compPages}
                </span>
                <button
                  onClick={() => setCompPage((p) => Math.min(compPages - 1, p + 1))}
                  disabled={compPage >= compPages - 1}
                  className="btn btn-ghost btn-xs disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
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
