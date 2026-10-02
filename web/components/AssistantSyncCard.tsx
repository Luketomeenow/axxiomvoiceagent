"use client";

import { useState } from "react";

import { api, type AssistantSyncResult } from "@/lib/api";

/**
 * Re-apply every Vapi assistant's config from the server (inbound, generic
 * outbound, one per brand) — what the create-*-assistant scripts did from a
 * laptop, which can't reach the Azure database. Run it after a deploy that
 * changes prompts/tools, and at cutover: it also points every webhook at this
 * server's SERVER_URL.
 */
export function AssistantSyncCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssistantSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    if (!confirm("Re-apply the code's config to every live Vapi assistant (and point their webhooks at this server)?")) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.syncAssistants());
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  const tone = (action: string) =>
    action === "failed" ? "text-red-400" : action === "skipped" ? "text-slate-500" : "text-emerald-300";

  return (
    <div className="card card-pad space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="section-title">Vapi assistants</h2>
          <p className="text-xs text-slate-400">
            Push the current prompts, tools, voices and approved prompt overrides to every assistant, and point their
            webhooks at this server. Run after a deploy that changes the agent.
          </p>
        </div>
        <button onClick={sync} disabled={busy} className="btn btn-primary btn-xs">
          {busy ? "Syncing…" : "Re-sync Vapi assistants"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <div className="space-y-1 text-xs">
          <div className={result.ok ? "text-emerald-300" : "text-amber-300"}>
            {result.ok ? "All assistants in sync" : "Finished with problems"} · webhook {result.webhookUrl ?? "(SERVER_URL not set)"}
          </div>
          {result.items.map((item) => (
            <div key={`${item.target}-${item.id ?? ""}`} className="flex gap-2">
              <span className={`w-16 shrink-0 ${tone(item.action)}`}>{item.action}</span>
              <span className="text-slate-300">{item.target}</span>
              {item.detail && <span className="truncate text-slate-500" title={item.detail}>— {item.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
