"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Call } from "@/lib/types";

/**
 * Recently finished calls — the recording (saved in our DB), the AI summary,
 * and the full transcript. Refreshes live via Supabase Realtime as calls end.
 */
export function RecentCalls() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("call")
      .select("*")
      .eq("status", "ended")
      .order("ended_at", { ascending: false })
      .limit(12);
    setCalls((data as Call[]) ?? []);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase
      .channel("recent-calls")
      .on("postgres_changes", { event: "*", schema: "outbound", table: "call" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [load]);

  const fmtDuration = (s: number | null) => {
    if (!s) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="card card-pad">
      <h2 className="section-title mb-3">Recent calls</h2>
      {calls.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 bg-ink/40 px-4 py-6 text-center text-sm text-slate-400">
          No completed calls yet. Recordings and transcripts appear here.
        </p>
      ) : (
        <div className="space-y-3">
          {calls.map((call) => (
            <div key={call.id} className="rounded-xl border border-white/10 bg-ink/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm">{call.phone_number}</span>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  {call.disposition && (
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-slate-200">{call.disposition}</span>
                  )}
                  <span>{fmtDuration(call.duration_seconds)}</span>
                  {call.ended_at && <span>{new Date(call.ended_at).toLocaleString()}</span>}
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
                  {open[call.id] && (
                    <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-black/30 p-2 text-xs text-slate-300">
                      {call.transcript}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
