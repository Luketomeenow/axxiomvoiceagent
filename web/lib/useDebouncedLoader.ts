"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Loader {
  /** Debounced + coalesced refetch — realtime/poll handlers call this. */
  trigger: () => void;
  /** Immediate load (mount / dependency change). */
  loadNow: () => Promise<void>;
  loading: boolean;
  /** Last failure message; cleared on the next successful load. */
  error: string | null;
}

/**
 * Shared loader for the live dashboard panels. Realtime events during an active
 * campaign arrive per call/transcript line, and previously each one re-ran the
 * panel's full query fan with no guard — concurrent loads raced (last write
 * wins) and failures were swallowed as empty data.
 *
 * `trigger()` debounces (trailing) and coalesces: if a trigger lands while a
 * load is in flight, exactly one follow-up load runs after it settles. A
 * generation counter ensures only the newest run writes `error`, and `fn` must
 * THROW on failure (the api helpers throw on `{ error }` responses) so the panel can
 * surface a stale-data indicator instead of rendering an empty state.
 */
export function useDebouncedLoader(fn: () => Promise<void>, opts?: { debounceMs?: number }): Loader {
  const debounceMs = opts?.debounceMs ?? 750;

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const run = useCallback(async () => {
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const generation = ++generationRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      await fnRef.current();
      if (mountedRef.current && generation === generationRef.current) setError(null);
    } catch (err) {
      if (mountedRef.current && generation === generationRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
      if (pendingRef.current) {
        pendingRef.current = false;
        if (mountedRef.current) void run();
      }
    }
  }, []);

  const trigger = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void run();
    }, debounceMs);
  }, [run, debounceMs]);

  return { trigger, loadNow: run, loading, error };
}
