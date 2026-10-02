/**
 * In-process change bus — the replacement for Supabase Realtime. Every write
 * that goes through dataClient() publishes one event per statement (not per
 * row, so a 500-row lead import is one event), and GET /outbound/events fans
 * them out to the dashboard over SSE.
 *
 * In-memory and single-instance, like the rest of the per-call state (see
 * CLAUDE.md). This service is the only writer to these tables — Vapi webhooks,
 * the dialer and the dashboard API all run here — so nothing is missed except
 * hand-run SQL, which the dashboard's reconnect/safety refresh covers.
 */

import { scopedLog } from "./logger.ts";

const log = scopedLog("live-stream");

export type ChangeOp = "INSERT" | "UPSERT" | "UPDATE" | "DELETE";

export interface ChangeEvent {
  schema: string;
  table: string;
  op: ChangeOp;
  /** insert/upsert: the rows as written (undefined values = not provided). */
  rows?: Record<string, unknown>[];
  /** update: the patch as written. */
  patch?: Record<string, unknown>;
}

type Listener = (event: ChangeEvent) => void;

const listeners = new Set<Listener>();

export function onChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishChange(event: ChangeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn("change listener threw", { table: event.table, err: String(err) });
    }
  }
}
