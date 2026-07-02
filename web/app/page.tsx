"use client";

import { useCallback, useState } from "react";
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

export default function Page() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3">
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
            <LiveStatus />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 p-5">
        <LiveCampaigns onSelect={setCampaignId} />
        <StatsBar refreshKey={refreshKey} campaignId={campaignId} />
        <CampaignControls campaignId={campaignId} onSelect={setCampaignId} onChange={refresh} />

        <div className="grid gap-5 lg:grid-cols-2">
          <TestAgentCard />
          <ImportLeadsCard
            onImported={(id) => {
              if (id) setCampaignId(id);
              refresh();
            }}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <AgentSwitcher />
          <VoicePicker />
        </div>

        <LiveMonitor />
        <RecentCalls />

        <InsightsPanel campaignId={campaignId} />

        <ExportButtons campaignId={campaignId} />
        <LeadsTable onAction={refresh} campaignId={campaignId} refreshKey={refreshKey} />
      </main>
    </div>
  );
}
