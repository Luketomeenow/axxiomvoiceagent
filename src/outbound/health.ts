/**
 * Health checks for the dashboard's System logs tab (GET /outbound/system/health)
 * plus a background monitor that LOGS each check when it goes bad (and when it
 * recovers), so problems land in outbound.app_log even when nobody is watching.
 *
 * The routing check exists because of 2026-10-02: after the move to Azure the
 * Vapi assistants still sent their webhooks to the old Railway host, so this
 * server never heard a call end and the dashboard sat on "ringing".
 */

import { env } from "../config/env.ts";
import { fetchWithTimeout } from "../lib/http.ts";
import { scopedLog } from "../lib/logger.ts";
import { countLogs, logStoreStatus } from "../lib/logStore.ts";
import { webhookUrl } from "../assistant/sync.ts";
import { BRANDS } from "../assistant/brands.ts";
import { getBrandAssistantId } from "./brandStore.ts";
import { db } from "./db.ts";

const log = scopedLog("monitor");

export type CheckStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when not ok. */
  fix?: string;
}

export interface HealthReport {
  at: string;
  status: CheckStatus;
  checks: HealthCheck[];
  counts: { errors1h: number; warnings1h: number; errors24h: number; warnings24h: number } | null;
  lastWebhookAt: string | null;
  startedAt: string;
  version: string;
}

const startedAt = new Date().toISOString();
let version = "dev";
let lastWebhookAt: number | null = null;

export function setHealthVersion(v: string): void {
  version = v;
}

/** Called for every authenticated Vapi webhook. */
export function noteWebhook(): void {
  lastWebhookAt = Date.now();
}

const STATUS_RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, error: 2 };
const worst = (checks: HealthCheck[]): CheckStatus =>
  checks.reduce<CheckStatus>((w, c) => (STATUS_RANK[c.status] > STATUS_RANK[w] ? c.status : w), "ok");

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** Run one check with a time limit; a failure or timeout becomes an error result. */
async function guarded(id: string, label: string, fn: () => Promise<HealthCheck>): Promise<HealthCheck> {
  try {
    return await Promise.race([
      fn(),
      new Promise<HealthCheck>((resolve) =>
        setTimeout(() => resolve({ id, label, status: "error", detail: "check timed out after 15s" }), 15_000).unref(),
      ),
    ]);
  } catch (err) {
    return { id, label, status: "error", detail: `check failed: ${String(err)}` };
  }
}

// --- Vapi routing ---------------------------------------------------------------

interface VapiAssistant {
  id: string;
  name?: string;
  server?: { url?: string };
  serverUrl?: string;
}
interface VapiNumber {
  id: string;
  server?: { url?: string };
}

async function vapiGet<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`https://api.vapi.ai${path}`, {
    headers: { Authorization: `Bearer ${env.vapiApiKey}` },
    timeoutMs: 10_000,
  });
  if (!res.ok) throw new Error(`Vapi GET ${path.replace(/\?.*$/, "")} → ${res.status}`);
  return (await res.json()) as T;
}

const hostOf = (url: string | undefined) => {
  if (!url) return "no webhook";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

let routingCache: { at: number; check: HealthCheck } | null = null;
const ROUTING_TTL_MS = 60_000;

async function checkWebhookRouting(fresh: boolean): Promise<HealthCheck> {
  const id = "vapi-routing";
  const label = "Vapi → this server";
  if (!fresh && routingCache && Date.now() - routingCache.at < ROUTING_TTL_MS) return routingCache.check;
  const expected = webhookUrl();
  let check: HealthCheck;
  if (!env.vapiApiKey) {
    check = { id, label, status: "warn", detail: "VAPI_API_KEY isn't set, so the routing can't be checked." };
  } else if (!expected) {
    check = { id, label, status: "error", detail: "SERVER_URL isn't set, so Vapi can't be pointed at this server.", fix: "Set SERVER_URL (sync-app-settings.sh does)." };
  } else {
    // Only the assistants this service manages: inbound, generic outbound, one per brand.
    const managed = new Map<string, string>();
    if (env.vapiAssistantId) managed.set(env.vapiAssistantId, "inbound");
    if (env.outboundAssistantId) managed.set(env.outboundAssistantId, "outbound");
    for (const b of BRANDS) {
      const brandId = await getBrandAssistantId(b.slug);
      if (brandId) managed.set(brandId, b.slug);
    }
    const [assistants, numbers] = await Promise.all([
      vapiGet<VapiAssistant[]>("/assistant?limit=1000"),
      vapiGet<VapiNumber[]>("/phone-number?limit=1000"),
    ]);
    const byId = new Map((Array.isArray(assistants) ? assistants : []).map((a) => [a.id, a]));
    const wrong: string[] = [];
    const missing: string[] = [];
    const hosts = new Set<string>();
    for (const [assistantId, name] of managed) {
      const a = byId.get(assistantId);
      if (!a) {
        missing.push(name);
        continue;
      }
      const url = a.server?.url ?? a.serverUrl;
      if (url !== expected) {
        wrong.push(name);
        hosts.add(hostOf(url));
      }
    }
    const staleNumbers = (Array.isArray(numbers) ? numbers : []).filter(
      (n) => n.server?.url?.endsWith("/vapi/webhook") && n.server.url !== expected,
    );
    for (const n of staleNumbers) hosts.add(hostOf(n.server?.url));
    const fix = "Agent studio → Re-sync Vapi assistants.";
    if (wrong.length || staleNumbers.length) {
      const parts = [
        wrong.length ? `${wrong.length} of ${managed.size} assistants (${wrong.join(", ")})` : "",
        staleNumbers.length ? `${staleNumbers.length} phone number${staleNumbers.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      check = {
        id,
        label,
        status: "error",
        detail:
          `${parts.join(" and ")} send call updates to ${[...hosts].join(", ")}, not this server. ` +
          `Calls still connect, but this dashboard never hears how they ended: they show as "ringing" and their results are lost.`,
        fix,
      };
    } else if (missing.length) {
      check = { id, label, status: "warn", detail: `Assistant ids not found in Vapi: ${missing.join(", ")}.`, fix };
    } else if (!managed.size) {
      check = { id, label, status: "warn", detail: "No assistant ids configured (VAPI_ASSISTANT_ID / OUTBOUND_ASSISTANT_ID).", fix };
    } else {
      check = { id, label, status: "ok", detail: `All ${managed.size} assistants send their webhooks here.` };
    }
  }
  routingCache = { at: Date.now(), check };
  return check;
}

// --- Database-backed checks ------------------------------------------------------

async function checkDatabase(): Promise<HealthCheck> {
  const id = "database";
  const label = "Database";
  const { error } = await db().from("campaign").select("id", { count: "exact", head: true });
  if (error) {
    return { id, label, status: "error", detail: error.message, fix: "Check /ready. The app's identity needs access to the outbound schema." };
  }
  return { id, label, status: "ok", detail: `Connected (${env.dataBackend === "azure" ? "Azure Postgres" : "Supabase"}).` };
}

async function checkCallUpdates(): Promise<HealthCheck> {
  const id = "call-updates";
  const label = "Call results arriving";
  const now = Date.now();
  const last = lastWebhookAt
    ? `Last Vapi webhook ${ago(now - lastWebhookAt)}.`
    : `No Vapi webhook since this server started (${new Date(startedAt).toISOString().slice(11, 16)} UTC).`;
  // A call can't ring for 3 minutes: Vapi reports "in-progress" on answer and
  // an end-of-call when it gives up. Older than 15 min is the stale sweeper's.
  const { count: stuck, error } = await db()
    .from("call")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "ringing"])
    .lt("created_at", new Date(now - 3 * 60_000).toISOString())
    .gte("created_at", new Date(now - 15 * 60_000).toISOString());
  if (error) throw new Error(error.message);
  if (stuck) {
    return {
      id,
      label,
      status: "error",
      detail: `${stuck} call${stuck === 1 ? "" : "s"} placed 3+ minutes ago ${stuck === 1 ? "has" : "have"} had no update from Vapi. ${last}`,
      fix: 'Usually Vapi is sending webhooks elsewhere (see "Vapi → this server"). Stuck calls close on their own after 15 minutes.',
    };
  }
  const { count: swept, error: sweptErr } = await db()
    .from("call")
    .select("id", { count: "exact", head: true })
    .eq("ended_reason", "stale-timeout")
    .gte("created_at", new Date(now - 86_400_000).toISOString());
  if (sweptErr) throw new Error(sweptErr.message);
  if (swept) {
    return {
      id,
      label,
      status: "warn",
      detail: `${swept} call${swept === 1 ? "" : "s"} in the last 24 h never reported an end and ${swept === 1 ? "was" : "were"} closed as stale-timeout. ${last}`,
    };
  }
  return { id, label, status: "ok", detail: last };
}

async function checkDialer(): Promise<HealthCheck> {
  const id = "dialer";
  const label = "Dialer";
  const { count, error } = await db()
    .from("campaign")
    .select("id", { count: "exact", head: true })
    .eq("status", "running");
  if (error) throw new Error(error.message);
  const running = count ? `${count} campaign${count === 1 ? "" : "s"} running` : "no campaign running";
  if (!env.dialerEnabled) {
    return { id, label, status: "warn", detail: `DIALER_ENABLED=false: this server won't place calls (${running}).` };
  }
  return { id, label, status: "ok", detail: `Enabled, ${running}.` };
}

async function checkFailedWrites(): Promise<HealthCheck> {
  const id = "failed-writes";
  const label = "Database writes";
  // Only recent dead letters warn: old unresolved ones (e.g. migrated from the
  // previous host) would otherwise keep this amber forever.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const unresolved = () => db().from("failed_op").select("id", { count: "exact", head: true }).eq("resolved", false);
  const [recent, all] = await Promise.all([unresolved().gte("created_at", weekAgo), unresolved()]);
  if (recent.error || all.error) throw new Error((recent.error ?? all.error)!.message);
  const older = (all.count ?? 0) - (recent.count ?? 0);
  const olderNote = older ? ` ${older} older unresolved (over 7 days).` : "";
  if (recent.count) {
    return {
      id,
      label,
      status: "warn",
      detail: `${recent.count} write${recent.count === 1 ? "" : "s"} in the last 7 days failed after retries and ${recent.count === 1 ? "was" : "were"} saved to outbound.failed_op.${olderNote}`,
      fix: "Replay them: POST /outbound/failed-ops/replay (Analytics shows the count).",
    };
  }
  return { id, label, status: "ok", detail: `No failed writes in the last 7 days.${olderNote}` };
}

function checkLogStore(): HealthCheck {
  const id = "log-store";
  const label = "System log storage";
  const s = logStoreStatus();
  if (s.tableMissing) {
    return {
      id,
      label,
      status: "warn",
      detail: "outbound.app_log doesn't exist yet, so logs stay in this server's memory and are lost on restart.",
      fix: "Re-run scripts/azure/sql/voice_schema.sql in Cloud Shell.",
    };
  }
  if (s.lastError) return { id, label, status: "warn", detail: `Writing logs is failing (retrying): ${s.lastError}` };
  const kept = env.logPersistLevel === "info" ? "Info, warnings and errors" : env.logPersistLevel === "warn" ? "Warnings and errors" : "Errors";
  return { id, label, status: "ok", detail: `${kept} saved to outbound.app_log for ${env.logRetainDays} days.` };
}

function checkAi(): HealthCheck[] {
  const checks: HealthCheck[] = [];
  if (!env.anthropicApiKey) {
    checks.push({ id: "ai", label: "AI analysis (Foundry)", status: "warn", detail: "ANTHROPIC_API_KEY isn't set: insights and transcript analysis are off." });
  } else if (!env.anthropicBaseUrl) {
    checks.push({
      id: "ai",
      label: "AI analysis (Foundry)",
      status: "warn",
      detail: "ANTHROPIC_BASE_URL isn't set, so analysis would call api.anthropic.com instead of Azure AI Foundry.",
      fix: "Set ANTHROPIC_BASE_URL (sync-app-settings.sh does).",
    });
  } else {
    checks.push({ id: "ai", label: "AI analysis (Foundry)", status: "ok", detail: `${env.anthropicModel} on Azure AI Foundry.` });
  }
  if (env.voiceProvider === "foundry") {
    checks.push(
      env.foundryApiKey
        ? { id: "voice-model", label: "Voice agents' model", status: "ok", detail: `${env.voiceModel} on Azure AI Foundry (relay).` }
        : { id: "voice-model", label: "Voice agents' model", status: "error", detail: "VOICE_PROVIDER=foundry but no Foundry key: calls can't think.", fix: "Set FOUNDRY_API_KEY or ANTHROPIC_API_KEY." },
    );
  } else {
    checks.push({
      id: "voice-model",
      label: "Voice agents' model",
      status: "warn",
      detail: `${env.voiceModel} through Anthropic directly (via Vapi), not Azure AI Foundry.`,
      fix: "Set VOICE_PROVIDER=foundry, then re-sync the Vapi assistants.",
    });
  }
  return checks;
}

function checkTwilio(): HealthCheck {
  const ok = Boolean(env.twilioAccountSid && env.twilioAuthToken);
  return ok
    ? { id: "twilio", label: "Twilio cost sync", status: "ok", detail: "Carrier cost and status sync is on." }
    : { id: "twilio", label: "Twilio cost sync", status: "warn", detail: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN aren't set: no carrier cost or answered-by data." };
}

async function recentCounts(): Promise<HealthReport["counts"]> {
  const now = Date.now();
  const [hour, day] = await Promise.all([
    countLogs(new Date(now - 3_600_000).toISOString()),
    countLogs(new Date(now - 86_400_000).toISOString()),
  ]);
  if (!hour || !day) return null;
  return { errors1h: hour.error, warnings1h: hour.warn, errors24h: day.error, warnings24h: day.warn };
}

// --- Report -------------------------------------------------------------------------

let reportCache: { at: number; report: HealthReport } | null = null;
const REPORT_TTL_MS = 20_000;

export async function getHealthReport(opts: { fresh?: boolean } = {}): Promise<HealthReport> {
  if (!opts.fresh && reportCache && Date.now() - reportCache.at < REPORT_TTL_MS) return reportCache.report;
  const [database, routing, callUpdates, dialer, failedWrites, counts] = await Promise.all([
    guarded("database", "Database", checkDatabase),
    guarded("vapi-routing", "Vapi → this server", () => checkWebhookRouting(Boolean(opts.fresh))),
    guarded("call-updates", "Call results arriving", checkCallUpdates),
    guarded("dialer", "Dialer", checkDialer),
    guarded("failed-writes", "Database writes", checkFailedWrites),
    recentCounts().catch(() => null),
  ]);
  const errorsCheck: HealthCheck = counts
    ? counts.errors1h
      ? { id: "recent-errors", label: "Errors", status: "warn", detail: `${counts.errors1h} error${counts.errors1h === 1 ? "" : "s"} in the last hour (${counts.errors24h} in 24 h).`, fix: "Filter the log below to Errors." }
      : { id: "recent-errors", label: "Errors", status: "ok", detail: `None in the last hour (${counts.errors24h} in 24 h).` }
    : { id: "recent-errors", label: "Errors", status: "warn", detail: "Couldn't count recent errors." };
  const checks = [routing, callUpdates, database, dialer, errorsCheck, failedWrites, checkLogStore(), ...checkAi(), checkTwilio()];
  const report: HealthReport = {
    at: new Date().toISOString(),
    status: worst(checks),
    checks,
    counts,
    lastWebhookAt: lastWebhookAt ? new Date(lastWebhookAt).toISOString() : null,
    startedAt,
    version,
  };
  reportCache = { at: Date.now(), report };
  return report;
}

// --- Background monitor -------------------------------------------------------------

const MONITOR_EVERY_MS = 5 * 60_000;
// Self-referential (it counts the monitor's own error lines) — shown, not logged.
const NOT_LOGGED = new Set(["recent-errors"]);
const lastStatus = new Map<string, CheckStatus>();
let monitorTimer: ReturnType<typeof setInterval> | undefined;

async function runMonitor(): Promise<void> {
  try {
    const report = await getHealthReport({ fresh: true });
    for (const c of report.checks) {
      if (NOT_LOGGED.has(c.id)) continue;
      const prev = lastStatus.get(c.id);
      lastStatus.set(c.id, c.status);
      if (prev === c.status) continue;
      const meta = { check: c.id, detail: c.detail, fix: c.fix };
      if (c.status === "error") log.error(`Health check failed: ${c.label}`, meta);
      else if (c.status === "warn") log.warn(`Health check warning: ${c.label}`, meta);
      else if (prev) log.info(`Health check recovered: ${c.label}`, { check: c.id, detail: c.detail });
    }
  } catch (err) {
    log.warn("Health monitor run failed", { err: String(err) });
  }
}

/** Run the checks every 5 minutes and log each change of state. Idempotent. */
export function startHealthMonitor(): void {
  if (monitorTimer) return;
  setTimeout(() => void runMonitor(), 30_000).unref();
  monitorTimer = setInterval(() => void runMonitor(), MONITOR_EVERY_MS);
  monitorTimer.unref();
}
