"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * /docs — in-app product documentation for the Axxiom voice agents. Styled to
 * match the dashboard (dark navy + sky/emerald accents, the shared card /
 * section-title classes). Sits behind AuthGuard like the rest of the app.
 */

const SECTIONS = [
  { id: "overview", label: "Overview", fl: "01" },
  { id: "architecture", label: "Architecture", fl: "02" },
  { id: "inbound", label: "Inbound agent", fl: "03" },
  { id: "outbound", label: "Outbound campaign", fl: "04" },
  { id: "brands", label: "The six brands", fl: "05" },
  { id: "compliance", label: "Compliance", fl: "06" },
  { id: "analytics", label: "Analytics", fl: "07" },
  { id: "platform", label: "Platform", fl: "08" },
  { id: "status", label: "Status", fl: "09" },
];

const BRANDS = [
  { name: "Quality Elevator", region: "MD · DC · N. Virginia", cid: "+1 240", cidSub: "", voice: "Clara" },
  { name: "Motion Elevator", region: "South Florida", cid: "+1 954", cidSub: "", voice: "Layla" },
  { name: "Liftech Elevator", region: "California — SoCal", cid: "+1 562", cidSub: "", voice: "Sid" },
  { name: "Axxiom Elevator FL", region: "Florida", cid: "+1 561", cidSub: "", voice: "Kai" },
  { name: "Arizona Elevator", region: "Arizona", cid: "+1 928", cidSub: "", voice: "Elliot" },
  { name: "AmeriTex Elevator", region: "Texas + SF Bay Area", cid: "+1 325 / +1 510", cidSub: "by lead state", voice: "Savannah" },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-sky-400">
      <span className="h-px w-5 bg-sky-400/50" />
      {children}
    </p>
  );
}

function Mini({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-panel/70 p-4">
      <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-100">
        <span className="font-mono text-sky-400">▚</span>
        {title}
      </h4>
      <p className="text-[13px] text-slate-400">{children}</p>
    </div>
  );
}

function Node({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div
      className={`min-w-[130px] rounded-lg border bg-panel px-4 py-2.5 text-center ${
        accent ? "border-sky-500/40" : "border-white/10"
      }`}
    >
      <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-[0.1em] text-slate-500">{k}</span>
      <span className={`text-sm font-semibold ${accent ? "text-sky-300" : "text-slate-200"}`}>{v}</span>
    </div>
  );
}

export default function DocsPage() {
  const [active, setActive] = useState<string>("overview");

  useEffect(() => {
    const sections = SECTIONS.map((s) => document.getElementById(s.id)).filter(Boolean) as HTMLElement[];
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 },
    );
    sections.forEach((s) => spy.observe(s));
    return () => spy.disconnect();
  }, []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-sky-400 text-sm font-black text-ink shadow-glow">
              AX
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight tracking-tight">Documentation</h1>
              <p className="text-xs text-slate-400">Axxiom voice agents · product reference</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Live · soft launch
            </span>
            <Link href="/" className="btn btn-ghost btn-xs">
              ← Console
            </Link>
            <Link href="/analytics" className="btn btn-ghost btn-xs">
              Analytics
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-7xl px-5 py-14 sm:py-20">
          <p className="mb-5 font-mono text-xs uppercase tracking-[0.2em] text-sky-400">Product documentation</p>
          <h2 className="max-w-[16ch] text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
            AI voice agents for Axxiom Elevator.
          </h2>
          <p className="mt-5 max-w-[60ch] text-lg text-slate-400">
            Two AI agents that sound natural on the phone, know the elevator business, and are wired straight into the
            CRM and call database. One answers every inbound call around the clock; the other runs compliant outbound
            campaigns that turn elevator-violation records into qualified leads — monitored, measured, and continuously
            improved.
          </p>
          <div className="mt-9 flex flex-wrap gap-x-12 gap-y-5">
            {[
              ["2", "Voice agents"],
              ["6", "Regional brands"],
              ["24/7", "Inbound coverage"],
              ["~14.5k", "Leads in pipeline"],
            ].map(([n, l]) => (
              <div key={l}>
                <div className="text-3xl font-extrabold tracking-tight tabular-nums">{n}</div>
                <div className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-slate-500">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Directory + content */}
      <div className="mx-auto max-w-7xl gap-10 px-5 py-12 lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Section directory" className="mb-6 lg:sticky lg:top-[84px] lg:mb-0 lg:self-start">
          <div className="mb-3 hidden pl-3.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-slate-500 lg:block">
            Directory
          </div>
          <ul className="flex overflow-x-auto border-b border-white/10 lg:flex-col lg:gap-px lg:border-b-0 lg:border-l-2 lg:border-white/10">
            {SECTIONS.map((s) => {
              const on = active === s.id;
              return (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                      history.replaceState(null, "", `#${s.id}`);
                    }}
                    className={`flex items-baseline gap-2.5 whitespace-nowrap px-3.5 py-2 text-sm transition-colors lg:-ml-0.5 lg:border-l-2 ${
                      on
                        ? "border-sky-400 font-semibold text-sky-300 lg:border-l-2"
                        : "border-transparent font-medium text-slate-400 hover:text-slate-100"
                    }`}
                  >
                    <span className={`hidden font-mono text-[10px] lg:inline ${on ? "text-sky-400" : "text-slate-600"}`}>
                      {s.fl}
                    </span>
                    {s.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 space-y-14">
          {/* Overview */}
          <section id="overview" className="scroll-mt-20">
            <Eyebrow>Overview</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">One platform, two agents, six brands.</h3>
            <p className="mt-3 max-w-[66ch] text-lg text-slate-400">
              Vapi runs the voice pipeline; this service owns the business logic. The two agents share one webhook
              backend but do very different jobs.
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="card card-pad">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-sky-400">
                  Inbound · answers 24/7
                </span>
                <h4 className="mt-2 text-lg font-bold">Triage &amp; booking</h4>
                <p className="mt-2 text-sm text-slate-400">
                  Answers every call, tells new leads from existing customers, books site surveys onto the calendar, and
                  hands trapped or injured callers straight to a human. Scope is inquiries and leads — not emergency
                  dispatch.
                </p>
              </div>
              <div className="card card-pad">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-sky-400">
                  Outbound · places calls
                </span>
                <h4 className="mt-2 text-lg font-bold">Compliant qualification</h4>
                <p className="mt-2 text-sm text-slate-400">
                  Dials building owners whose elevators show overdue inspections or expired permits, discloses and
                  captures consent, qualifies interest, and drops sales-ready leads into an export — one customized
                  agent per brand.
                </p>
              </div>
            </div>
            <p className="mt-5 max-w-[68ch] text-slate-300">
              The hard-won value lives in the orchestration layer: the dialing engine and its guardrails, the CRM and
              call-log integrations, the live dashboard, the analytics, and a human-gated loop that lets the agents
              improve their own scripts over time.
            </p>
          </section>

          {/* Architecture */}
          <section id="architecture" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>Architecture</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">How a call flows.</h3>
            <p className="mt-3 max-w-[68ch] text-slate-300">
              The caller is connected over Twilio; Vapi runs speech-to-text, Claude, and the voice; and every mid-call
              action and end-of-call report is posted to this service, which reads and writes the CRM and the call
              database. The dashboard reads that data live.
            </p>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-ink/50 p-5 sm:p-7">
              <div className="mx-auto flex min-w-[360px] max-w-2xl flex-col items-center">
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Node k="Caller" v="Building owner / PM" />
                  <span className="font-mono text-sm text-slate-500">↔</span>
                  <Node k="Carrier" v="Twilio" />
                </div>
                <div className="my-1.5 h-6 w-0.5 rounded bg-gradient-to-b from-white/10 to-sky-500/60" />
                <Node k="Voice pipeline · Vapi" v="Deepgram → Claude → ElevenLabs / Vapi voice" accent />
                <div className="my-1.5 h-6 w-0.5 rounded bg-gradient-to-b from-white/10 to-sky-500/60" />
                <Node k="This service · Hono on Bun" v="Webhook · dialer + guardrails · handlers" accent />
                <div className="my-1.5 h-6 w-0.5 rounded bg-gradient-to-b from-white/10 to-sky-500/60" />
                <div className="flex flex-wrap justify-center gap-2.5 rounded-lg border border-dashed border-white/15 p-3">
                  <Node k="CRM" v="GoHighLevel" />
                  <Node k="Database" v="Supabase" />
                  <Node k="Telephony truth" v="Twilio REST" />
                </div>
                <div className="my-1.5 h-6 w-0.5 rounded bg-gradient-to-b from-white/10 to-sky-500/60" />
                <Node k="Operators" v="Next.js dashboard — live monitor + analytics" />
              </div>
            </div>
            <p className="mt-4 max-w-[68ch] text-sm text-slate-500">
              Vapi owns the conversation (transcript, recording, sentiment, its own cost). Twilio is the carrier and
              owns the authoritative per-call cost, carrier status, and answered-by. The dashboard reads Supabase
              directly over Realtime as the logged-in user.
            </p>
          </section>

          {/* Inbound */}
          <section id="inbound" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>Inbound agent</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">Answers every call, day or night.</h3>
            <p className="mt-3 max-w-[68ch] text-slate-300">
              A missed call is a missed lead. The inbound agent picks up 24/7, discloses that it&apos;s an AI on a
              recorded line, and routes the caller — with a safety net that always comes first.
            </p>
            <ol className="mt-5 space-y-0">
              {[
                ["Safety check first", "If anyone is trapped or injured, it stops everything and transfers to a human immediately — it never qualifies during an emergency."],
                ["Identifies the caller", "Looks the number up in the CRM to tell a new prospect from an existing customer."],
                ["New prospect → qualify & book", "Gathers name, callback, building, elevator count and the issue, then books a free site survey onto the calendar."],
                ["Existing customer", "Helps with the question, or transfers / takes a message for account, billing, and complaints."],
              ].map(([t, d], i) => (
                <li key={t} className="grid grid-cols-[30px_1fr] items-start gap-3.5 border-b border-dashed border-white/10 py-3 last:border-0">
                  <span className="grid h-7 w-7 place-items-center rounded-md bg-sky-500/15 font-mono text-xs font-bold text-sky-300">
                    {i + 1}
                  </span>
                  <span>
                    <b className="font-semibold text-slate-100">{t}</b>
                    <span className="mt-0.5 block text-sm text-slate-400">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* Outbound */}
          <section id="outbound" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>Outbound campaign</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">From public record to sales-ready lead.</h3>
            <p className="mt-3 max-w-[68ch] text-slate-300">
              Thousands of buildings have elevators that are out of compliance — a real problem for the owner and a
              genuine reason to call. The outbound agent works those lists region by region, and only ever says what the
              public record proves.
            </p>

            <h4 className="mt-7 text-base font-bold text-slate-100">The call: disclose → consent → qualify</h4>
            <ol className="mt-3 space-y-0">
              {[
                ["Deterministic opener", "Fixed first words disclose the AI and the recorded line, then lead with the building's real overdue-inspection or expired-permit status."],
                ["Explicit consent", "A dedicated tool records the actual “yes” to continue on a recorded line — before any qualifying begins."],
                ["Qualification", "Decision-maker? Current provider? Open to a free survey? Best callback? Captured into clean, structured columns."],
                ["Disposition", "Every lead ends qualified, needs-follow-up, not-interested, remove, voicemail, IVR, or DNC — exported for the sales team."],
              ].map(([t, d], i) => (
                <li key={t} className="grid grid-cols-[30px_1fr] items-start gap-3.5 border-b border-dashed border-white/10 py-3 last:border-0">
                  <span className="grid h-7 w-7 place-items-center rounded-md bg-sky-500/15 font-mono text-xs font-bold text-sky-300">
                    {i + 1}
                  </span>
                  <span>
                    <b className="font-semibold text-slate-100">{t}</b>
                    <span className="mt-0.5 block text-sm text-slate-400">{d}</span>
                  </span>
                </li>
              ))}
            </ol>

            <h4 className="mt-7 text-base font-bold text-slate-100">Reaching a real person — the core lever</h4>
            <p className="mt-2 max-w-[68ch] text-slate-300">
              Most cold dials hit a switchboard, voicemail, or phone-tree. The agent reads who answered and adapts
              instead of pitching a machine: it navigates automated menus (pressing 0 for an operator), asks a
              gatekeeper for whoever handles elevator maintenance, leaves a compliant voicemail, and dispositions
              machines for a smarter retry.
            </p>

            <h4 className="mt-7 text-base font-bold text-slate-100">The dialing engine&apos;s guardrails</h4>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Mini title="Calling window">8am–9pm in the lead&apos;s own timezone, not the campaign&apos;s.</Mini>
              <Mini title="Do-not-call">Suppression checked before every dial; fails closed on error.</Mini>
              <Mini title="Frequency caps">Per-lead attempts + per-number daily cap, day-part-spread retries.</Mini>
              <Mini title="Per-run budget">&ldquo;Dial N this run,&rdquo; then the campaign auto-pauses.</Mini>
              <Mini title="Concurrency">Many campaigns at once, each on its own budget — no starving.</Mini>
              <Mini title="Self-healing">Stuck calls swept up; account-level errors auto-pause the run.</Mini>
            </div>
          </section>

          {/* Brands */}
          <section id="brands" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>The six brands</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">A local agent for every market.</h3>
            <p className="mt-3 max-w-[68ch] text-slate-300">
              Each brand gets its own customized agent — same proven flow, but branded by name, voice, value props,
              state-specific compliance, and its own local Twilio caller ID. The right brand is resolved automatically
              per lead; operators never have to pick a voice.
            </p>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left font-mono text-[10.5px] uppercase tracking-[0.1em] text-slate-500">
                    <th className="bg-panel/60 px-4 py-3 font-semibold">Brand</th>
                    <th className="bg-panel/60 px-4 py-3 font-semibold">Region</th>
                    <th className="bg-panel/60 px-4 py-3 font-semibold">Caller ID</th>
                    <th className="bg-panel/60 px-4 py-3 font-semibold">Voice</th>
                  </tr>
                </thead>
                <tbody>
                  {BRANDS.map((b) => (
                    <tr key={b.name} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                      <td className="px-4 py-3 font-semibold text-slate-100">{b.name}</td>
                      <td className="px-4 py-3 text-slate-400">{b.region}</td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[13px] text-sky-300">{b.cid}</span>
                        {b.cidSub && <div className="text-xs text-slate-500">{b.cidSub}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-300">{b.voice}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-[68ch] text-sm text-slate-500">
              Dialing from a real local number — not a generic line — means better answer rates and a truthful caller
              identity. AmeriTex picks a Texas or California number depending on where the lead is.
            </p>
          </section>

          {/* Compliance */}
          <section id="compliance" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>Compliance</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">Compliant by design, not by hope.</h3>
            <p className="mt-3 max-w-[68ch] text-slate-300">
              Cold-calling at scale carries real legal exposure. Every guardrail below is enforced in code — the agent
              can&apos;t skip it, and every one is auditable.
            </p>
            <ul className="mt-5 grid gap-3">
              {[
                ["Honest AI disclosure, every call.", "The first words — inbound, outbound, even voicemail — state it's an AI on a recorded line. Fixed text, never improvised."],
                ["Explicit recording consent.", "A genuine “yes” is required and recorded before any qualifying; the strictest all-party standard applies everywhere."],
                ["Calling hours by the lead's own clock.", "8am–9pm in the callee's timezone, resolved from their state."],
                ["Do-not-call, fail-safe.", "The suppression list is checked before every dial; if the check itself fails, the call is blocked."],
                ["Frequency limits.", "Capped attempts per lead and per number, with cooling-off between retries."],
                ["A permanent audit trail.", "Every disclosure, consent moment, tool action, and transcript line is logged append-only, with a coverage scorecard on the dashboard."],
                ["Privacy lifecycle.", "Transcripts and recordings purge after a retention window; any person can be fully erased on request — keeping only their do-not-call entry."],
              ].map(([t, d]) => (
                <li key={t} className="grid grid-cols-[18px_1fr] gap-3 text-[15px] text-slate-300">
                  <span className="font-mono text-xs leading-6 text-sky-400">▚</span>
                  <span>
                    <b className="font-semibold text-slate-100">{t}</b> {d}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-6 flex gap-3.5 rounded-2xl border border-sky-500/25 bg-sky-500/[0.07] px-5 py-4">
              <span className="font-mono text-sm font-bold text-sky-300">Note</span>
              <p className="text-sm text-slate-300">
                Open items sit with counsel, not engineering: state telemarketing registration and bonds, the evolving
                federal consent standard, and a data-processing/privacy review of the vendor chain.
              </p>
            </div>
          </section>

          {/* Analytics */}
          <section id="analytics" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>Analytics &amp; measurement</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">Run it like a business.</h3>
            <p className="mt-3 max-w-[68ch] text-slate-300">
              Operators run everything from a secure, login-gated dashboard, and every call becomes a number leadership
              can act on.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Mini title="Live monitor">Every running campaign, calls in flight, transcripts streaming in real time.</Mini>
              <Mini title="Who we reached">A real human-vs-machine split from Twilio answering-machine detection.</Mini>
              <Mini title="Cost per qualified">AI cost + authoritative carrier cost, reconciled from Twilio.</Mini>
              <Mini title="Conversion funnel">Leads → contacted → qualified, with attempts-to-qualify.</Mini>
              <Mini title="Best time to call">Connect rate by hour, so we dial when people answer.</Mini>
              <Mini title="Compliance audit">Disclosure and consent coverage across every call.</Mini>
            </div>
            <h4 className="mt-7 text-base font-bold text-slate-100">It improves itself — with a human in the loop</h4>
            <p className="mt-2 max-w-[68ch] text-slate-300">
              After a batch of calls, an AI analyst reviews the transcripts and proposes a plain-English improvement
              report plus an improved script. Nothing goes live on its own: a human approves it, and a guardrail
              automatically blocks any change that would weaken the compliance language.
            </p>
          </section>

          {/* Platform */}
          <section id="platform" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>Platform &amp; security</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">The stack under the hood.</h3>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="card card-pad">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-sky-400">
                  Voice &amp; intelligence
                </span>
                <h4 className="mt-2 text-lg font-bold">Vapi · Claude · Twilio</h4>
                <p className="mt-2 text-sm text-slate-400">
                  Vapi orchestrates the pipeline (Deepgram speech-to-text, Anthropic&apos;s Claude for the brain,
                  ElevenLabs / Vapi voices). Twilio carries the calls on Axxiom&apos;s own numbers. Post-call analysis
                  runs on Claude.
                </p>
              </div>
              <div className="card card-pad">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-sky-400">Service &amp; data</span>
                <h4 className="mt-2 text-lg font-bold">Hono · Supabase · GHL</h4>
                <p className="mt-2 text-sm text-slate-400">
                  A TypeScript service on Bun (Railway) owns the logic; a Next.js dashboard on Netlify. Supabase Postgres
                  stores calls and leads; GoHighLevel is the CRM. Call data mirrors into Microsoft Fabric.
                </p>
              </div>
            </div>
            <h4 className="mt-7 text-base font-bold text-slate-100">Security</h4>
            <ul className="mt-3 grid gap-3">
              {[
                ["Fail-closed webhook.", "Vapi calls are verified with a shared secret, compared in constant time; no secret, no traffic."],
                ["Authenticated dashboard.", "Every API call needs a signed-in user; access is invite-only, CORS-locked, and rate-limited."],
                ["Row-level database security.", "Reads run as the logged-in user; the inbound call log is service-role only. PII is redacted from logs."],
              ].map(([t, d]) => (
                <li key={t} className="grid grid-cols-[18px_1fr] gap-3 text-[15px] text-slate-300">
                  <span className="font-mono text-xs leading-6 text-sky-400">▚</span>
                  <span>
                    <b className="font-semibold text-slate-100">{t}</b> {d}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* Status */}
          <section id="status" className="scroll-mt-20 border-t border-white/10 pt-12">
            <Eyebrow>Status</Eyebrow>
            <h3 className="section-title !text-2xl sm:!text-3xl">Where things stand.</h3>
            <p className="mt-3 max-w-[68ch] text-slate-300">
              Both agents, all six brand assistants, the dashboard, analytics, compliance controls, cost sync, and the
              self-improvement loop are built and deployed. The system soft-launched in July 2026 and is in active
              tuning — with reaching a live decision-maker (versus a switchboard) as the current focus.
            </p>
            <div className="mt-6 flex gap-3.5 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.07] px-5 py-4">
              <span className="font-mono text-sm font-bold text-emerald-300">Next</span>
              <p className="text-sm text-slate-300">
                <b className="font-semibold text-slate-100">The flywheel:</b> voice agents book surveys and qualify leads
                → jobs generate service history → everything lands in the warehouse → analytics and a violation-monitoring
                agent feed the dialer its next leads. Each piece makes the others&apos; data more valuable.
              </p>
            </div>
          </section>

          <footer className="border-t border-white/10 pt-8 text-sm text-slate-500">
            <div className="font-mono text-[11px] uppercase tracking-[0.08em]">Axxiom Elevator · Voice Agents</div>
            <p className="mt-2 max-w-[60ch]">
              Internal product documentation. For the full technical guides — setup, API reference, database schema, and
              the compliance checklist — see the <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-xs text-sky-300">docs/</code> directory in the repository.
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
