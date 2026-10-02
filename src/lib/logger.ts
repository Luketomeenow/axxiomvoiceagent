/**
 * Tiny structured logger. Every line goes to stdout/stderr as JSON (the App
 * Service log stream) AND to the registered sinks — src/lib/logStore.ts adds
 * one at boot that feeds the dashboard's System logs tab (ring buffer + live
 * tail + outbound.app_log). Keeps call-id context so logs are traceable.
 *
 * Dependency-free on purpose: nearly every module imports it, including the
 * data layer the log store writes through.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  /** Which part of the service logged it (dialer, outbound-call, api, …) — the System logs filter. */
  source: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

type Sink = (entry: LogEntry) => void;

const sinks = new Set<Sink>();

/** Receive every log entry (after it is printed). Returns an unsubscribe. */
export function addLogSink(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function emit(level: LogLevel, source: string, msg: string, meta?: Record<string, unknown>): void {
  const at = new Date().toISOString();
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(JSON.stringify({ t: at, level, src: source, msg, ...(meta ?? {}) }));
  for (const sink of sinks) {
    try {
      sink({ at, level, source, msg, meta });
    } catch {
      /* a sink must never break logging (and must not log about it — recursion) */
    }
  }
}

/** A logger whose lines are tagged with `source`. */
export function scopedLog(source: string): Logger {
  return {
    info: (msg, meta) => emit("info", source, msg, meta),
    warn: (msg, meta) => emit("warn", source, msg, meta),
    error: (msg, meta) => emit("error", source, msg, meta),
  };
}

/** Untagged logger (source "app") for modules without their own scope. */
export const log = scopedLog("app");
