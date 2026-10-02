"use client";

import { useHealth } from "@/lib/health";

/**
 * Red strip above every tab when a health check has a real problem (status
 * "error"), e.g. Vapi sending call updates to another server, which makes live
 * calls look stuck on "ringing". Hidden when everything is ok or only warns.
 */
export function HealthBanner({ onOpen }: { onOpen: () => void }) {
  const { report } = useHealth();
  const problems = report?.checks.filter((c) => c.status === "error") ?? [];
  if (!problems.length) return null;
  return (
    <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          {problems.map((c) => (
            <div key={c.id} className="text-sm">
              <span className="font-semibold text-rose-200">{c.label}: </span>
              <span className="text-rose-100/90">{c.detail}</span>
              {c.fix && <span className="text-rose-200/80"> Fix: {c.fix}</span>}
            </div>
          ))}
        </div>
        <button onClick={onOpen} className="btn btn-ghost btn-xs shrink-0">
          Open System logs
        </button>
      </div>
    </div>
  );
}
