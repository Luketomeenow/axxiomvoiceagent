"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type CheckStatus, type HealthCheck } from "@/lib/api";
import { useHealth } from "@/lib/health";
import { useLiveLogs, type LiveLog } from "@/lib/live";
import ErrorChip from "./ErrorChip";

/**
 * System logs tab: the server's health checks, then its own log (warnings,
 * errors and key events from outbound.app_log) with filters, a live tail over
 * the shared event stream, and paging back through history.
 */

const SOURCES: { id: string; label: string }[] = [
  { id: "outbound-call", label: "Outbound calls" },
  { id: "inbound-call", label: "Inbound calls" },
  { id: "dialer", label: "Dialer" },
  { id: "webhook", label: "Vapi webhooks" },
  { id: "monitor", label: "Health monitor" },
  { id: "http", label: "HTTP errors" },
  { id: "api", label: "Dashboard API" },
  { id: "server", label: "Server (boot/shutdown)" },
  { id: "assistant-sync", label: "Assistant sync" },
  { id: "llm-relay", label: "Foundry relay" },
  { id: "ai", label: "AI analysis" },
  { id: "database", label: "Database" },
  { id: "auth", label: "Sign-in" },
  { id: "twilio", label: "Twilio" },
  { id: "billing", label: "Balances" },
  { id: "voice", label: "Voices" },
  { id: "ghl", label: "GoHighLevel" },
  { id: "settings", label: "Settings" },
];

const LEVELS = [
  { id: "all", label: "All" },
  { id: "warn", label: "Warnings + errors" },
  { id: "error", label: "Errors" },
] as const;
type LevelFilter = (typeof LEVELS)[number]["id"];

const PAGE = 100;
const MAX_ROWS = 2_000;

// A stable React key per row (live-tail lines have no database id yet).
type Row = LiveLog & { key: string };
let liveSeq = 0;
const keyed = (entry: LiveLog, origin: "db" | "live"): Row => ({
  ...entry,
  key: entry.id !== null && origin === "db" ? `db-${entry.id}` : `${origin}-${++liveSeq}`,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_STYLE: Record<CheckStatus, { dot: string; ring: string; text: string; label: string }> = {
  ok: { dot: "bg-emerald-400", ring: "border-white/10", text: "text-emerald-300", label: "OK" },
  warn: { dot: "bg-amber-400", ring: "border-amber-500/30", text: "text-amber-300", label: "Warning" },
  error: { dot: "bg-rose-500 animate-pulse", ring: "border-rose-500/40", text: "text-rose-300", label: "Problem" },
};

const LEVEL_CHIP: Record<LiveLog["level"], string> = {
  info: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  warn: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  error: "border-rose-500/40 bg-rose-500/15 text-rose-300",
};

function fmtTime(at: string): { short: string; full: string } {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return {
    short: today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`,
    full: d.toLocaleString(),
  };
}

function since(at: string | null): string {
  if (!at) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** Same filter the server applies, for live-tail lines. */
function matches(entry: LiveLog, level: LevelFilter, source: string, q: string): boolean {
  if (level === "warn" && entry.level === "info") return false;
  if (level === "error" && entry.level !== "error") return false;
  if (source && entry.source !== source) return false;
  const term = q.trim();
  if (!term) return true;
  if (UUID.test(term)) return [entry.call_id, entry.vapi_call_id, entry.campaign_id, entry.lead_id].includes(term);
  return entry.message.toLowerCase().includes(term.toLowerCase());
}

function CheckTile({ check }: { check: HealthCheck }) {
  const s = STATUS_STYLE[check.status];
  return (
    <div className={`rounded-xl border ${s.ring} bg-ink/40 p-3`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
          {check.label}
        </div>
        <span className={`text-[11px] font-medium uppercase tracking-wide ${s.text}`}>{s.label}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{check.detail}</p>
      {check.fix && check.status !== "ok" && <p className="mt-1 text-xs text-slate-400">Fix: {check.fix}</p>}
    </div>
  );
}

function HealthChecks() {
  const { report, error, loading, refresh } = useHealth();
  const problems = report?.checks.filter((c) => c.status !== "ok").length ?? 0;
  return (
    <div className="card card-pad space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="section-title">Health checks</h2>
            <ErrorChip error={error} label="couldn't refresh" />
          </div>
          <p className="text-xs text-slate-400">
            The server re-runs these every 5 minutes and writes any change to the log below.
            {report && (
              <>
                {" "}
                Checked {since(report.at)} · version {report.version.slice(0, 7)} · up since{" "}
                {fmtTime(report.startedAt).short} · last Vapi webhook {since(report.lastWebhookAt)}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {report && (
            <span className={`text-xs ${problems ? "text-amber-300" : "text-emerald-300"}`}>
              {problems ? `${problems} need${problems === 1 ? "s" : ""} attention` : "All good"}
            </span>
          )}
          <button onClick={() => void refresh(true)} disabled={loading} className="btn btn-ghost btn-xs">
            {loading ? "Checking…" : "Re-check"}
          </button>
        </div>
      </div>
      {report ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {report.checks.map((c) => (
            <CheckTile key={c.id} check={c} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-500">{error ? "Health checks unavailable." : "Running checks…"}</p>
      )}
    </div>
  );
}

function LogRow({ entry, onFind }: { entry: LiveLog; onFind: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const t = fmtTime(entry.at);
  const ref = entry.call_id ?? entry.vapi_call_id;
  const hasContext = Boolean(entry.context && Object.keys(entry.context).length);
  return (
    <div className="border-b border-white/5 py-1.5 last:border-0">
      <div
        className={`flex items-start gap-2 text-xs ${hasContext ? "cursor-pointer" : ""}`}
        onClick={() => hasContext && setOpen((o) => !o)}
      >
        <span className="w-[4.5rem] shrink-0 font-mono text-slate-500 sm:w-28" title={t.full}>
          {t.short}
        </span>
        <span className={`chip shrink-0 px-2 py-0 text-[10px] uppercase ${LEVEL_CHIP[entry.level]}`}>{entry.level}</span>
        <span className="hidden w-28 shrink-0 truncate text-slate-400 sm:block" title={entry.source}>
          {entry.source}
        </span>
        <span className={`min-w-0 flex-1 break-words ${entry.level === "error" ? "text-rose-100" : "text-slate-200"}`}>
          {entry.message}
          {hasContext && <span className="ml-1 text-slate-500">{open ? "▾" : "▸"}</span>}
        </span>
        {ref && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFind(ref);
            }}
            className="shrink-0 rounded border border-white/10 px-1.5 text-[10px] text-sky-300 hover:bg-white/5"
            title="Show every line for this call"
          >
            call {ref.slice(0, 8)}
          </button>
        )}
      </div>
      {open && entry.context && (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-white/10 bg-ink/70 p-2 text-[11px] leading-relaxed text-slate-300 sm:ml-[7.5rem]">
          {JSON.stringify(entry.context, null, 2)}
        </pre>
      )}
    </div>
  );
}

function LogTable() {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(true);
  const [logs, setLogs] = useState<Row[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);

  // Debounce typing into the search box.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const res = await api.logs({ level, source, q, limit: PAGE });
      if (gen !== generation.current) return;
      setLogs(res.logs.map((l) => keyed(l, "db")));
      setPersisted(res.persisted);
      setNote(res.note);
      setHasMore(res.persisted && res.logs.length === PAGE);
      setError(null);
    } catch (err) {
      if (gen === generation.current) setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [level, source, q]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = async () => {
    const ids = logs.map((l) => l.id).filter((id): id is number => typeof id === "number");
    if (!ids.length) return;
    setLoading(true);
    try {
      const res = await api.logs({ level, source, q, before: Math.min(...ids), limit: PAGE });
      setLogs((prev) => [...prev, ...res.logs.map((l) => keyed(l, "db"))].slice(0, MAX_ROWS));
      setHasMore(res.persisted && res.logs.length === PAGE);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  };

  useLiveLogs((entry) => {
    if (!matches(entry, level, source, q)) return;
    setLogs((prev) => [keyed(entry, "live"), ...prev].slice(0, MAX_ROWS));
  }, live);

  const findCall = (id: string) => {
    setSearch(id);
    setQ(id);
    setLevel("all");
    setSource("");
  };

  return (
    <div className="card card-pad space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="section-title">System log</h2>
            <ErrorChip error={error} />
          </div>
          <p className="text-xs text-slate-400">
            What the server did and what went wrong: calls placed and ended, Vapi webhooks, dialer decisions, server
            errors, crashes and health-check changes. Phone numbers are masked. Click a line for details.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-300">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-emerald-400" />
            Live
            {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
          </label>
          <button onClick={() => void load()} disabled={loading} className="btn btn-ghost btn-xs">
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-white/10 p-0.5">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              onClick={() => setLevel(l.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                level === l.id ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value)} className="field w-auto py-1.5 text-xs">
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search messages, or paste a call / lead / campaign id"
          className="field min-w-[14rem] flex-1 py-1.5 text-xs"
        />
        {(search || source || level !== "all") && (
          <button
            onClick={() => {
              setSearch("");
              setQ("");
              setSource("");
              setLevel("all");
            }}
            className="btn btn-ghost btn-xs"
          >
            Clear
          </button>
        )}
      </div>

      {!persisted && note && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{note}</p>
      )}

      <div className="max-h-[38rem] overflow-y-auto pr-1">
        {logs.length ? (
          logs.map((entry) => <LogRow key={entry.key} entry={entry} onFind={findCall} />)
        ) : (
          <p className="py-6 text-center text-xs text-slate-500">{loading ? "Loading…" : "Nothing logged for these filters."}</p>
        )}
      </div>

      {hasMore && (
        <div className="text-center">
          <button onClick={() => void loadOlder()} disabled={loading} className="btn btn-ghost btn-xs">
            Load older
          </button>
        </div>
      )}
    </div>
  );
}

export function SystemLogs() {
  return (
    <div className="space-y-5">
      <HealthChecks />
      <LogTable />
    </div>
  );
}
