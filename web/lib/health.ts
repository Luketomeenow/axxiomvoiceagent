"use client";

import { useEffect, useState } from "react";

import { api, type HealthReport } from "./api";

/**
 * The server's health checks (GET /outbound/system/health), polled once a
 * minute and SHARED by every component that asks (the Overview banner, the
 * System logs tab and its tab dot), so one page load is one poll.
 */

interface HealthState {
  report: HealthReport | null;
  error: string | null;
  loading: boolean;
}

const POLL_MS = 60_000;

let state: HealthState = { report: null, error: null, loading: false };
const subscribers = new Set<(s: HealthState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function publish(next: Partial<HealthState>): void {
  state = { ...state, ...next };
  for (const fn of subscribers) fn(state);
}

/** Re-run the checks now (`fresh` skips the server's ~20 s cache). */
export function refreshHealth(fresh = false): Promise<void> {
  if (inFlight && !fresh) return inFlight;
  publish({ loading: true });
  const run = api
    .health(fresh)
    .then((report) => publish({ report, error: null }))
    .catch((err) => publish({ error: String(err instanceof Error ? err.message : err) }))
    .finally(() => {
      publish({ loading: false });
      if (inFlight === run) inFlight = null;
    });
  inFlight = run;
  return run;
}

export function useHealth(): HealthState & { refresh: (fresh?: boolean) => Promise<void> } {
  const [s, setS] = useState<HealthState>(state);
  useEffect(() => {
    subscribers.add(setS);
    if (!state.report && !inFlight) void refreshHealth();
    if (!timer) timer = setInterval(() => void refreshHealth(), POLL_MS);
    return () => {
      subscribers.delete(setS);
      if (!subscribers.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return { ...s, refresh: refreshHealth };
}
