"use client";

import { useEffect, useRef } from "react";

import { API_BASE } from "./api";

/**
 * Live change stream from the backend (GET /outbound/events, server-sent
 * events) — the replacement for Supabase Realtime. ONE EventSource per tab,
 * shared by every panel; each panel subscribes to the tables it shows and
 * refetches through the API (or, for LiveMonitor, appends transcript rows
 * straight from the event).
 *
 * EventSource reconnects on its own (the server asks for 5s). Anything that
 * happened while disconnected was missed, so after a reconnect every
 * subscriber gets a `{ t: "*", op: "RESYNC" }` and refetches.
 */

export interface LiveEventRow {
  call_id: string | null;
  vapi_call_id: string | null;
  type: string;
  role: string | null;
  text: string | null;
  at: string;
}

export interface LiveChange {
  t: string; // table (campaign | call | call_event | lead | campaign_insight), or "*" for RESYNC
  op: "INSERT" | "UPSERT" | "UPDATE" | "DELETE" | "RESYNC";
  status?: string; // call rows: the status written, when the write set one
  rows?: LiveEventRow[]; // call_event inserts
}

type Listener = (change: LiveChange) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let missedEvents = false;

function emit(change: LiveChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      console.warn("live listener failed", err);
    }
  }
}

function connect(): void {
  if (source || typeof window === "undefined") return;
  source = new EventSource(`${API_BASE}/outbound/events`, { withCredentials: true });
  source.addEventListener("ready", () => {
    if (missedEvents) {
      missedEvents = false;
      emit({ t: "*", op: "RESYNC" });
    }
  });
  source.addEventListener("change", (e) => {
    try {
      emit(JSON.parse((e as MessageEvent<string>).data) as LiveChange);
    } catch {
      /* malformed frame — ignore */
    }
  });
  source.onerror = () => {
    missedEvents = true;
    // CONNECTING = the browser is already retrying. CLOSED = it gave up (e.g. a
    // non-200 like 401 while the page redirects to /login) — retry ourselves.
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      if (!reconnectTimer && listeners.size) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (listeners.size) connect();
        }, 5000);
      }
    }
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      source?.close();
      source = null;
    }
  };
}

/** Call `onChange` for every live change to any of `tables` (+ RESYNC after a reconnect). */
export function useLiveChanges(tables: string[], onChange: (change: LiveChange) => void): void {
  const handler = useRef(onChange);
  handler.current = onChange;
  const key = tables.join(",");
  useEffect(() => {
    const wanted = new Set(key.split(","));
    return subscribe((change) => {
      if (change.op === "RESYNC" || wanted.has(change.t)) handler.current(change);
    });
  }, [key]);
}
