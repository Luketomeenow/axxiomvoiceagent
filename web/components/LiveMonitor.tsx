"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { Call, CallEvent } from "@/lib/types";

// Active call joined with its campaign name + lead brand (PostgREST embeds).
type ActiveCall = Call & {
  campaign?: { name: string | null } | null;
  lead?: { servicing_brand: string | null; building_name: string | null } | null;
};

/**
 * Live monitor: shows calls that are currently in flight and streams transcript
 * lines as they arrive via Supabase Realtime on outbound.call + outbound.call_event.
 */
export function LiveMonitor() {
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [events, setEvents] = useState<Record<string, CallEvent[]>>({});
  const [ending, setEnding] = useState<Record<string, boolean>>({});
  const eventsRef = useRef(events);
  eventsRef.current = events;

  async function handleEnd(callId: string) {
    setEnding((m) => ({ ...m, [callId]: true }));
    try {
      const res = await api.endCall(callId);
      if (!res?.ok) {
        // Surface the reason but keep the row; status will flip via Realtime if it ends.
        console.warn("End call failed:", res?.reason);
        alert(`Could not end call: ${res?.reason ?? "unknown error"}`);
      }
    } catch (err) {
      alert(`Could not end call: ${String(err)}`);
    } finally {
      setEnding((m) => ({ ...m, [callId]: false }));
    }
  }

  async function loadActive() {
    // Only consider calls started recently. Without webhooks a dead call can be
    // left "ringing" forever; this keeps the monitor honest even if one slips through.
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("call")
      .select("*, campaign:campaign_id(name), lead:lead_id(servicing_brand,building_name)")
      .in("status", ["queued", "ringing", "in-progress"])
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false });
    setActiveCalls((data as ActiveCall[]) ?? []);
  }

  useEffect(() => {
    loadActive();
    const ch = supabase
      .channel("live-monitor")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "call" }, loadActive)
      .on("postgres_changes", { event: "INSERT", schema: "outbound", table: "call_event" }, (payload) => {
        const ev = payload.new as CallEvent;
        if (!ev.call_id) return;
        const next = { ...eventsRef.current };
        const list = next[ev.call_id] ? [...next[ev.call_id]] : [];
        list.push(ev);
        next[ev.call_id] = list.slice(-40);
        setEvents(next);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="card card-pad">
      <div className="mb-3 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${activeCalls.length ? "animate-pulse bg-emerald-400" : "bg-slate-500"}`} />
        <h2 className="section-title">Live calls</h2>
        <span className="text-sm text-slate-400">({activeCalls.length} active)</span>
      </div>
      {activeCalls.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 bg-ink/40 px-4 py-6 text-center text-sm text-slate-400">
          No calls in progress. Start the campaign or use “Call now”.
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
