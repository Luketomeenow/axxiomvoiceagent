"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type CallWithContext } from "@/lib/api";
import { useLiveChanges } from "@/lib/live";
import { useDebouncedLoader } from "@/lib/useDebouncedLoader";
import ErrorChip from "./ErrorChip";
import { TranscriptViewer } from "./TranscriptViewer";

const PAGE_SIZE = 8;

// Call rows joined with their campaign name + lead brand (GET /outbound/calls/recent).
type RecentCall = CallWithContext;

/**
 * Recently finished calls — recording, AI summary, and a compact paginated
 * transcript. Each call shows which campaign + brand it belongs to. Refreshes
 * from the live change stream; the list itself paginates client-side.
 */
export function RecentCalls() {
  const [calls, setCalls] = useState<RecentCall[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setCalls(await api.recentCalls(60));
  }, []);

  const { trigger, loadNow, error } = useDebouncedLoader(load);

  useEffect(() => {
    void loadNow();
  }, [loadNow]);
  useLiveChanges(["call"], (change) => {
    // The list only shows ENDED calls — skip the constant status churn of
    // in-flight calls (queued → ringing → in-progress) and refetch only when a
    // call could have entered the list.
    if (change.op === "UPDATE" && change.status && change.status !== "ended") return;
    trigger();
  });

  const fmtDuration = (s: number | null) => {
    if (!s) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  // Who ended the call → a short badge (label + tint).
  const endedBy = (v: string | null): { label: string; cls: string } | null => {
    switch (v) {
      case "customer":
        return { label: "they ended", cls: "border-amber-500/30 bg-amber-500/15 text-amber-300" };
      case "agent":
        return { label: "agent ended", cls: "border-sky-500/30 bg-sky-500/15 text-sky-300" };
      case "operator":
        return { label: "we ended", cls: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" };
      case "system":
        return { label: "system", cls: "border-white/10 bg-white/5 text-slate-400" };
      default:
        return null;
    }
  };

  const pageCount = Math.max(1, Math.ceil(calls.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = calls.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="card card-pad">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="section-title flex items-center gap-2">
          Recent calls
          <ErrorChip error={error} />
        </h2>
        {calls.length > 0 && <span className="text-xs text-slate-400">{calls.length} total</span>}
      </div>

      {calls.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 bg-ink/40 px-4 py-6 text-center text-sm text-slate-400">
          No completed calls yet. Recordings and transcripts appear here.
        </p>
      ) : (
        <>
          <div className="space-y-3">
            {visible.map((call) => {
              const campaign = call.campaign?.name;
              const brand = call.lead?.servicing_brand;
              const who = [call.lead?.building_name, call.lead?.contact_name].filter(Boolean).join(" · ");
              return (
                <div key={call.id} className="rounded-xl border border-white/10 bg-ink/60 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-sm">{call.phone_number}</div>
                      {who && <div className="truncate text-xs text-slate-400">{who}</div>}
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs">
                      <span className="rounded-full border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-sky-300">
                        {campaign || "no campaign"}
                      </span>
                      {brand && (
                        <span className="rounded-full border border-violet-500/30 bg-violet-500/15 px-2 py-0.5 text-violet-300">
                          {brand}
                        </span>
                      )}
                      {call.disposition && (
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-slate-200">{call.disposition}</span>
                      )}
                      {endedBy(call.ended_by) && (
                        <span
                          className={`rounded-full border px-2 py-0.5 ${endedBy(call.ended_by)!.cls}`}
                          title={call.ended_reason ?? undefined}
                        >
                          {endedBy(call.ended_by)!.label}
                        </span>
                      )}
                      <span className="text-slate-400">{fmtDuration(call.duration_seconds)}</span>
                      {call.ended_at && (
                        <span className="text-slate-500">{new Date(call.ended_at).toLocaleString()}</span>
                      )}
                    </div>
                  </div>

                  {call.recording_url ? (
                    <audio controls preload="none" src={call.recording_url} className="mt-2 h-9 w-full">
                      Your browser does not support audio playback.
                    </audio>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">Recording not available yet…</p>
                  )}

                  {call.summary && <p className="mt-2 text-sm text-slate-300">{call.summary}</p>}

                  {call.transcript && (
                    <div className="mt-2">
                      <button
                        onClick={() => setOpen((m) => ({ ...m, [call.id]: !m[call.id] }))}
                        className="text-xs text-sky-300 hover:underline"
                      >
                        {open[call.id] ? "Hide transcript" : "Show transcript"}
                      </button>
                      {open[call.id] && <TranscriptViewer text={call.transcript} />}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {pageCount > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="btn btn-ghost btn-xs disabled:opacity-40"
              >
                ‹ Newer
              </button>
              <span className="tabular-nums">
                Page {safePage + 1} / {pageCount}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
                className="btn btn-ghost btn-xs disabled:opacity-40"
              >
                Older ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
