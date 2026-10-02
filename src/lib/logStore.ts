/**
 * System log store — what the dashboard's System logs tab reads. Installed at
 * boot as a sink on src/lib/logger.ts, so every log line also goes to:
 *
 *   - a ring buffer of the last RING_SIZE entries (the live tail, and the
 *     fallback when the table is missing or the database is down),
 *   - live listeners (forwarded on the dashboard's /outbound/events stream),
 *   - outbound.app_log, batched every FLUSH_MS (or FLUSH_AT entries) for lines
 *     at or above LOG_PERSIST_LEVEL, deleted after LOG_RETAIN_DAYS.
 *
 * Rules:
 *   - never throws, and never logs through `log` itself (a failed insert would
 *     log → enqueue → fail → … forever) — its own problems go to console only;
 *   - masks phone numbers and secret-ish fields before anything is kept;
 *   - a line that repeats (same level + source + message + call) is kept at
 *     most THROTTLE_MAX times per THROTTLE_WINDOW_MS (e.g. a lead skipped on
 *     every 15 s dialer tick); the next kept one says how many were dropped.
 */

import { hostname } from "node:os";

import { databaseConfigured, env } from "../config/env.ts";
import { dataClient } from "./dataClient.ts";
import { addLogSink, type LogEntry, type LogLevel } from "./logger.ts";
import { redactSecretsDeep } from "./redact.ts";

export interface StoredLog {
  /** Database id; null for an entry only in memory (live tail / not persisted). */
  id: number | null;
  at: string;
  level: LogLevel;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
  call_id: string | null;
  vapi_call_id: string | null;
  campaign_id: string | null;
  lead_id: string | null;
}

export interface LogQuery {
  /** Minimum level (warn = warn + error). */
  level?: LogLevel;
  source?: string;
  /** Text in the message, or a call/lead/campaign/Vapi-call id. */
  q?: string;
  /** Page backwards: only rows with id < before. */
  before?: number;
  limit?: number;
}

export interface LogStoreStatus {
  installed: boolean;
  persisting: boolean;
  tableMissing: boolean;
  lastError: string | null;
  queued: number;
  dropped: number;
}

const LEVELS: LogLevel[] = ["info", "warn", "error"];
const rank = (l: LogLevel) => LEVELS.indexOf(l);

const RING_SIZE = 1000;
const FLUSH_MS = 2_000;
const FLUSH_AT = 50;
const BATCH_MAX = 200;
const MAX_QUEUE = 2_000;
const MAX_MESSAGE = 2_000;
const MAX_STRING = 2_000;
const MAX_CONTEXT = 8_000;
const THROTTLE_WINDOW_MS = 10 * 60_000;
const THROTTLE_MAX = 10;
const TABLE_RETRY_MS = 2 * 60_000;
const PURGE_EVERY_MS = 6 * 3_600_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// E.164 (+14155551234) and bare 10/11-digit US numbers inside text.
const PHONE_IN_TEXT = /\+\d{10,15}\b|(?<![\w.+-])1?\d{10}(?![\w.-])/g;

const ring: StoredLog[] = [];
const queue: StoredLog[] = [];
const listeners = new Set<(entry: StoredLog) => void>();
const throttle = new Map<string, { windowStart: number; count: number; suppressed: number }>();

let installed = false;
let instance = "";
let version = "dev";
let flushing: Promise<void> | null = null;
let pausedUntil = 0;
let failures = 0;
let tableMissing = false;
let lastError: string | null = null;
let lastConsoleComplaint = 0;
let dropped = 0;

// --- Shaping (exported for tests) ---------------------------------------------

/** Mask phone numbers in free text: "+14155551234" → "***1234". */
export function maskPhonesInText(s: string): string {
  return s.replace(PHONE_IN_TEXT, (m) => `***${m.slice(-4)}`);
}

function maskDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskPhonesInText(value.slice(0, MAX_STRING));
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, depth + 1);
  return out;
}

const uuidOrNull = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);
const strOrNull = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 100) : null);

/**
 * A log entry as it is stored: masked, size-capped, with the ids the System
 * logs search uses pulled out of its meta. In this codebase `callId` is
 * Vapi's call id and `callRowId` is ours.
 */
export function toStoredLog(entry: LogEntry, suppressed = 0): StoredLog {
  const meta = { ...(entry.meta ?? {}) };
  if (suppressed) meta.suppressedRepeats = suppressed;
  let context: Record<string, unknown> | null = null;
  if (Object.keys(meta).length) {
    context = maskDeep(redactSecretsDeep(meta)) as Record<string, unknown>;
    const json = JSON.stringify(context);
    if (json.length > MAX_CONTEXT) context = { truncated: json.slice(0, MAX_CONTEXT) };
  }
  return {
    id: null,
    at: entry.at,
    level: entry.level,
    source: entry.source,
    message: maskPhonesInText(entry.msg.slice(0, MAX_MESSAGE)),
    context,
    call_id: uuidOrNull(meta.callRowId),
    vapi_call_id: strOrNull(meta.vapiCallId ?? meta.callId),
    campaign_id: uuidOrNull(meta.campaignId),
    lead_id: uuidOrNull(meta.leadId),
  };
}

/**
 * How many repeats were dropped before this one, or null to drop it too.
 * Keyed per call, so concurrent calls' identical lines ("Call status:
 * ringing") never eat each other's budget. Exported for tests.
 */
export function admit(entry: LogEntry, now = Date.now()): number | null {
  const m = entry.meta ?? {};
  const call = m.callRowId ?? m.callId ?? m.vapiCallId ?? "";
  const key = `${entry.level}|${entry.source}|${entry.msg}|${typeof call === "string" ? call : ""}`;
  let t = throttle.get(key);
  if (!t) {
    if (throttle.size > 2_000) throttle.clear();
    t = { windowStart: now, count: 0, suppressed: 0 };
    throttle.set(key, t);
  }
  if (now - t.windowStart >= THROTTLE_WINDOW_MS) {
    t.windowStart = now;
    t.count = 0;
  }
  if (t.count >= THROTTLE_MAX) {
    t.suppressed++;
    return null;
  }
  t.count++;
  const suppressed = t.suppressed;
  t.suppressed = 0;
  return suppressed;
}

// --- Sink ---------------------------------------------------------------------

function onEntry(entry: LogEntry): void {
  const suppressed = admit(entry);
  if (suppressed === null) return;
  const stored = toStoredLog(entry, suppressed);
  ring.push(stored);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  for (const listener of listeners) {
    try {
      listener(stored);
    } catch {
      /* a listener must never break logging */
    }
  }
  if (!databaseConfigured() || rank(stored.level) < rank(env.logPersistLevel)) return;
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    dropped++;
  }
  queue.push(stored);
  if (queue.length >= FLUSH_AT) void flushLogs();
}

/** Start capturing logs. Idempotent; call once at boot, as early as possible. */
export function installLogStore(opts: { version?: string } = {}): void {
  if (installed) return;
  installed = true;
  version = opts.version ?? "dev";
  instance = (process.env.WEBSITE_INSTANCE_ID || hostname()).slice(0, 12);
  addLogSink(onEntry);
  setInterval(() => void flushLogs(), FLUSH_MS).unref();
  if (databaseConfigured()) {
    setTimeout(() => void purgeOldLogs(), 60_000).unref();
    setInterval(() => void purgeOldLogs(), PURGE_EVERY_MS).unref();
  }
}

/** Every kept entry, as it happens (the dashboard's live tail). */
export function onLogEntry(listener: (entry: StoredLog) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function logStoreStatus(): LogStoreStatus {
  return {
    installed,
    persisting: installed && databaseConfigured() && !tableMissing && !lastError,
    tableMissing,
    lastError,
    queued: queue.length,
    dropped,
  };
}

// --- Persistence ----------------------------------------------------------------

function complain(msg: string): void {
  // console only — never `log` (see the header). At most once a minute.
  if (Date.now() - lastConsoleComplaint < 60_000) return;
  lastConsoleComplaint = Date.now();
  console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", src: "log-store", msg }));
}

const isMissingTable = (msg: string) =>
  /relation "?[\w.]*app_log"? does not exist|could not find the table '?[\w.]*app_log|PGRST205/i.test(msg);

function onFlushFailure(message: string, batch: StoredLog[]): void {
  lastError = message;
  if (isMissingTable(message)) {
    // Not created yet (voice_schema.sql not re-run). Keep the ring buffer
    // going; try again in a while instead of hammering the database.
    tableMissing = true;
    pausedUntil = Date.now() + TABLE_RETRY_MS;
    complain(`outbound.app_log is missing — system logs stay in memory only until voice_schema.sql is re-run (${message})`);
    return;
  }
  failures++;
  pausedUntil = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5));
  // Put the batch back (oldest first) as long as there's room.
  const room = MAX_QUEUE - queue.length;
  if (room > 0) queue.unshift(...batch.slice(-room));
  dropped += Math.max(0, batch.length - Math.max(room, 0));
  complain(`writing system logs failed (${failures}x, retrying): ${message}`);
}

/** Write one batch of queued entries. Never throws. */
export function flushLogs(): Promise<void> {
  if (flushing) return flushing;
  if (!queue.length || Date.now() < pausedUntil || !databaseConfigured()) return Promise.resolve();
  flushing = (async () => {
    const batch = queue.splice(0, BATCH_MAX);
    const rows = batch.map((r) => ({
      created_at: r.at,
      level: r.level,
      source: r.source,
      message: r.message,
      context: r.context,
      call_id: r.call_id,
      vapi_call_id: r.vapi_call_id,
      campaign_id: r.campaign_id,
      lead_id: r.lead_id,
      instance,
      version,
    }));
    try {
      const { error } = await dataClient(env.outboundSchema).from("app_log").insert(rows);
      if (error) return onFlushFailure(error.message, batch);
      failures = 0;
      lastError = null;
      tableMissing = false;
    } catch (err) {
      onFlushFailure(String(err), batch);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Flush everything queued, giving up after `timeoutMs` (shutdown / crash path). */
export async function drainLogs(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  pausedUntil = 0;
  while (queue.length && Date.now() < deadline && !tableMissing) {
    const before = queue.length;
    await Promise.race([flushLogs(), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    if (queue.length >= before) break; // not making progress (failing) — stop
    pausedUntil = 0;
  }
}

/** Delete rows older than LOG_RETAIN_DAYS. Never throws. */
export async function purgeOldLogs(days = env.logRetainDays): Promise<void> {
  if (!databaseConfigured() || tableMissing) return;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const { error } = await dataClient(env.outboundSchema).from("app_log").delete().lt("created_at", cutoff);
    if (error && !isMissingTable(error.message)) complain(`purging old system logs failed: ${error.message}`);
  } catch (err) {
    complain(`purging old system logs failed: ${String(err)}`);
  }
}

// --- Reads ----------------------------------------------------------------------

const LOG_COLUMNS = "id, created_at, level, source, message, context, call_id, vapi_call_id, campaign_id, lead_id";

function matchesInMemory(r: StoredLog, query: LogQuery): boolean {
  if (query.level && rank(r.level) < rank(query.level)) return false;
  if (query.source && r.source !== query.source) return false;
  const q = query.q?.trim();
  if (!q) return true;
  if (UUID.test(q)) return [r.call_id, r.vapi_call_id, r.campaign_id, r.lead_id].includes(q);
  return r.message.toLowerCase().includes(q.toLowerCase());
}

function fromRing(query: LogQuery, limit: number): StoredLog[] {
  const out: StoredLog[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    if (matchesInMemory(ring[i], query)) out.push(ring[i]);
  }
  return out;
}

/**
 * Newest-first page of logs. From outbound.app_log when it's there; otherwise
 * from this instance's memory (`persisted: false` — lost on restart).
 */
export async function queryLogs(
  query: LogQuery,
): Promise<{ logs: StoredLog[]; persisted: boolean; note?: string }> {
  const limit = Math.min(500, Math.max(1, query.limit ?? 100));
  if (!databaseConfigured()) {
    return {
      logs: query.before ? [] : fromRing(query, limit),
      persisted: false,
      note: "No database configured. Showing this server's memory only.",
    };
  }
  let b = dataClient(env.outboundSchema)
    .from("app_log")
    .select(LOG_COLUMNS)
    .order("id", { ascending: false })
    .limit(limit);
  if (query.level && query.level !== "info") b = b.in("level", LEVELS.filter((l) => rank(l) >= rank(query.level!)));
  if (query.source) b = b.eq("source", query.source);
  const q = query.q?.trim();
  if (q && UUID.test(q)) {
    b = b.or(`call_id.eq.${q},vapi_call_id.eq.${q},campaign_id.eq.${q},lead_id.eq.${q}`);
  } else if (q) {
    b = b.ilike("message", `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (query.before) b = b.lt("id", query.before);
  const { data, error } = await b;
  if (error) {
    const missing = isMissingTable(error.message);
    if (missing) tableMissing = true;
    return {
      logs: query.before ? [] : fromRing(query, limit),
      persisted: false,
      note: missing
        ? "outbound.app_log doesn't exist yet: re-run scripts/azure/sql/voice_schema.sql. Showing this server's memory only (cleared on restart)."
        : `Couldn't read outbound.app_log (${error.message}). Showing this server's memory only.`,
    };
  }
  if (tableMissing) {
    // It exists now (the schema was just applied): start writing again.
    tableMissing = false;
    pausedUntil = 0;
  }
  const logs = ((data ?? []) as unknown as Array<Omit<StoredLog, "at"> & { created_at: string }>).map(
    ({ created_at, ...r }) => ({ ...r, at: created_at }),
  );
  return { logs, persisted: true };
}

/** Warning/error counts since `sinceIso` (null when the table can't be read). */
export async function countLogs(sinceIso: string): Promise<{ warn: number; error: number } | null> {
  const fromMemory = () => {
    const since = Date.parse(sinceIso);
    const recent = ring.filter((r) => Date.parse(r.at) >= since);
    return {
      warn: recent.filter((r) => r.level === "warn").length,
      error: recent.filter((r) => r.level === "error").length,
    };
  };
  if (!databaseConfigured() || tableMissing) return fromMemory();
  const count = async (level: LogLevel) => {
    const { count: n, error } = await dataClient(env.outboundSchema)
      .from("app_log")
      .select("id", { count: "exact", head: true })
      .eq("level", level)
      .gte("created_at", sinceIso);
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  try {
    const [warn, error] = await Promise.all([count("warn"), count("error")]);
    return { warn, error };
  } catch {
    return null;
  }
}
