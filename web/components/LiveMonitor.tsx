"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CallWithContext } from "@/lib/api";
import { useLiveChanges } from "@/lib/live";
import { useDebouncedLoader } from "@/lib/useDebouncedLoader";
import type { CallEvent } from "@/lib/types";
import ErrorChip from "./ErrorChip";

// Active call joined with its campaign name + lead brand (GET /outbound/calls/active).
type ActiveCall = CallWithContext;

// Stream rows carry no database id — number them locally for React keys.
let nextEventKey = 1;

/**
 * Live monitor: shows calls that are currently in flight and streams transcript
 * lines as they arrive on the live change stream (outbound.call + outbound.call_event).
 */
export function LiveMonitor() {
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [events, setEvents] = useState<Record<string, CallEvent[]>>({});
  const [ending, setEnding] = useState<Record<string, boolean>>({});

  async function handleEnd(callId: string) {
    setEnding((m) => ({ ...m, [callId]: true }));
    try {
      const res = await api.endCall(callId);
      if (!res?.ok) {
        // Surface the reason but keep the row; status flips via the live stream if it ends.
        console.warn("End call failed:", res?.reason);
        alert(`Could not end call: ${res?.reason ?? "unknown error"}`);
      }
    } catch (err) {
      alert(`Could not end call: ${String(err)}`);
    } finally {
      setEnding((m) => ({ ...m, [callId]: false }));
    }
  }

  const loadActive = useCallback(async () => {
    // Only calls started in the last 15 minutes (server-side cutoff). Without
    // webhooks a dead call can be left "ringing" forever; this keeps the
    // monitor honest even if one slips through.
    setActiveCalls(await api.activeCalls());
  }, []);

  const { trigger, loadNow, error } = useDebouncedLoader(loadActive);

  // Transcript events stream one row per spoken line — buffer them and flush on
  // a short timer so the whole monitor re-renders once per beat, not per line.
  const pendingEventsRef = useRef<CallEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const batch = pendingEventsRef.current;
    pendingEventsRef.current = [];
    if (!batch.length) return;
    setEvents((prev) => {
      const next = { ...prev };
      for (const ev of batch) {
        if (!ev.call_id) continue;
        next[ev.call_id] = [...(next[ev.call_id] ?? []), ev].slice(-40);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void loadNow();
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [loadNow]);

  useLiveChanges(["call", "call_event"], (change) => {
    if (change.t === "call_event") {
      for (const row of change.rows ?? []) pendingEventsRef.current.push({ id: nextEventKey++, ...row });
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, 300);
      return;
    }
    trigger(); // call status changes + RESYNC
  });

  return (
    <div className="card card-pad">
      <div className="mb-3 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${activeCalls.length ? "animate-pulse bg-emerald-400" : "bg-slate-500"}`} />
        <h2 className="section-title">Live calls</h2>
        <span className="text-sm text-slate-400">({activeCalls.length} active)</span>
        <ErrorChip error={error} />
      </div>
      {activeCalls.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 bg-ink/40 px-4 py-6 text-center text-sm text-slate-400">
          No calls in progress. Start the campaign, or place a test call from Agent studio.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {activeCalls.map((call) => (
            <div key={call.id} className="animate-fade-in rounded-xl border border-white/10 bg-ink/60 p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-sm">{call.phone_number}</span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="rounded-full border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 text-sky-300">
                      {call.campaign?.name || "no campaign"}
                    </span>
                    {call.lead?.servicing_brand && (
                      <span className="rounded-full border border-violet-500/30 bg-violet-500/15 px-1.5 py-0.5 text-violet-300">
                        {call.lead.servicing_brand}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-200">
                    {call.status}
                  </span>
                  <button onClick={() => handleEnd(call.id)} disabled={ending[call.id]} className="btn btn-danger btn-xs">
                    {ending[call.id] ? "Ending…" : "End call"}
                  </button>
                </div>
              </div>
              <div className="h-44 space-y-1 overflow-y-auto text-sm">
                {(events[call.id] ?? [])
                  .filter((e) => e.type === "transcript" || e.type === "tool-call" || e.type === "consent")
                  .map((e) => (
                    <div key={e.id} className={e.role === "assistant" ? "text-sky-300" : "text-slate-200"}>
                      <span className="mr-1 text-xs uppercase text-slate-500">
                        {e.type === "transcript" ? e.role ?? "?" : e.type}
                      </span>
                      {e.text}
                    </div>
                  ))}
                {!events[call.id]?.length && <div className="text-xs text-slate-500">Connecting…</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
