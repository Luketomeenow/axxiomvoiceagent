"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CampaignControls } from "@/components/CampaignControls";
import { LiveCampaigns } from "@/components/LiveCampaigns";
import { ImportLeadsCard } from "@/components/ImportLeadsCard";
import { StatsBar } from "@/components/StatsBar";
import { LiveMonitor } from "@/components/LiveMonitor";
import { RecentCalls } from "@/components/RecentCalls";
import { LeadsTable } from "@/components/LeadsTable";
import { ExportButtons } from "@/components/ExportButtons";
import { TestAgentCard } from "@/components/TestAgentCard";
import { VoicePicker } from "@/components/VoicePicker";
import { InsightsPanel } from "@/components/InsightsPanel";
import { AgentSwitcher } from "@/components/AgentSwitcher";
import { LiveStatus } from "@/components/LiveStatus";

/**
 * The console is split into tabs so one page isn't doing everything at once.
 * Every panel stays MOUNTED (inactive ones are CSS-hidden) — LiveMonitor only
 * receives transcript lines via Realtime inserts, so unmounting it mid-call
 * would drop the transcript collected so far; keeping panels mounted also
 * preserves each component's Realtime subscription and avoids refetch churn.
 * The active tab syncs to the URL hash (#calls, #leads, #agent) for deep links.
 */
const TABS = [
  { id: "overview", label: "Overview", hint: "Run campaigns and watch live calls" },
  { id: "calls", label: "Call history", hint: "Recordings, summaries and transcripts" },
  { id: "leads", label: "Leads", hint: "Import, browse and export leads" },
  { id: "agent", label: "Agent studio", hint: "Test calls, voices and AI improvements" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function isTabId(v: string): v is TabId {
  return TABS.some((t) => t.id === v);
}

export default function Page() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace("#", "");
      if (isTabId(h)) setTab(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const selectTab = useCallback((id: TabId) => {
    setTab(id);
    history.replaceState(null, "", id === "overview" ? window.location.pathname : `#${id}`);
  }, []);

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-5">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-emerald-400 text-sm font-black text-ink shadow-glow">
                AX
              </div>
              <div>
                <h1 className="text-lg font-bold leading-tight tracking-tight">Axxiom — Outbound Qualification</h1>
                <p className="text-xs text-slate-400">
                  Elevator-violation leads by region · compliant disclosure + DNC enforced
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/analytics" className="btn btn-ghost btn-xs">
                📊 Analytics
              </Link>
              <Link href="/docs" className="btn btn-ghost btn-xs">
                📖 Docs
              </Link>
              <LiveStatus />
            </div>
          </div>

          <nav role="tablist" aria-label="Console sections" className="flex items-center gap-4 overflow-x-auto pb-2">
            <div className="flex items-center gap-1">
              {TABS.map((t) => {
                const active = t.id === tab;
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => selectTab(t.id)}
                    className={`whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                      active ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <span className="hidden whitespace-nowrap text-xs text-slate-500 md:block">{activeTab.hint}</span>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 p-5">
        {/* Always visible on every tab: hides itself when nothing is running. */}
        <LiveCampaigns
          onSelect={(id) => {
            setCampaignId(id);
            selectTab("overview");
          }}
        />

        <div role="tabpanel" className={tab === "overview" ? "space-y-5" : "hidden"}>
          <CampaignControls campaignId={campaignId} onSelect={setCampaignId} onChange={refresh} />
          <StatsBar refreshKey={refreshKey} campaignId={campaignId} />
          <LiveMonitor />
        </div>

        <div role="tabpanel" className={tab === "calls" ? "space-y-5" : "hidden"}>
          <RecentCalls />
        </div>

        <div role="tabpanel" className={tab === "leads" ? "space-y-5" : "hidden"}>
          <ImportLeadsCard
            onImported={(id) => {
              if (id) setCampaignId(id);
              refresh();
            }}
          />
          <ExportButtons campaignId={campaignId} />
          <LeadsTable onAction={refresh} campaignId={campaignId} refreshKey={refreshKey} />
        </div>

        <div role="tabpanel" className={tab === "agent" ? "space-y-5" : "hidden"}>
          <TestAgentCard />
          <div className="grid gap-5 lg:grid-cols-2">
            <AgentSwitcher />
            <VoicePicker />
          </div>
          <InsightsPanel campaignId={campaignId} />
        </div>
      </main>
    </div>
  );
}
