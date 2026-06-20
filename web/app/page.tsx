"use client";

import { useCallback, useState } from "react";
import { CampaignControls } from "@/components/CampaignControls";
import { StatsBar } from "@/components/StatsBar";
import { LiveMonitor } from "@/components/LiveMonitor";
import { LeadsTable } from "@/components/LeadsTable";
import { ExportButtons } from "@/components/ExportButtons";

export default function Page() {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <main className="mx-auto max-w-7xl space-y-5 p-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Axxiom — Outbound Qualification</h1>
          <p className="text-sm text-slate-400">
            CA elevator-violation leads · live Vapi campaign · {`compliant disclosure + DNC enforced`}
          </p>
        </div>
      </header>

      <CampaignControls onChange={refresh} />
      <StatsBar refreshKey={refreshKey} />
      <LiveMonitor />
      <ExportButtons />
      <LeadsTable onAction={refresh} />
    </main>
  );
}
