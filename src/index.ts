/**
 * Axxiom voice agents — HTTP service (Azure App Service, Node 22; `bun run dev` locally).
 *
 *   GET  /health        liveness (App Service health check)
 *   GET  /ready         dependency-aware readiness (database + identity)
 *   POST /vapi/webhook  Vapi server messages (tool-calls, end-of-call-report)
 *   /auth/*             dashboard sign-in (session cookie)
 *   /outbound/*         dashboard API + live SSE stream
 *   everything else     the dashboard itself (Next.js static export)
 *
 * Boots even with empty config so the first deploy is green; each feature warns
 * until its keys are present.
 */

import { readFileSync } from "node:fs";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { databaseConfigured, env, logConfigSummary } from "./config/env.ts";
import { auth } from "./auth/routes.ts";
import { log } from "./lib/logger.ts";
import { safeEqual } from "./lib/auth.ts";
import { dashboardAvailable, serveDashboard } from "./lib/staticDashboard.ts";
import { handleEndOfCallReport, handleToolCalls } from "./vapi/handlers.ts";
import {
  handleOutboundEndOfCall,
  handleOutboundStatusUpdate,
  handleOutboundToolCalls,
  handleOutboundTranscript,
  isOutboundCall,
} from "./outbound/handlers.ts";
import { outbound } from "./outbound/routes.ts";
import type { VapiWebhookBody } from "./vapi/types.ts";

const app = new Hono();

// The deployed git sha (scripts/azure/package-app.sh writes VERSION into the zip).
const VERSION = (() => {
  try {
    return readFileSync("VERSION", "utf8").trim();
  } catch {
    return "dev";
  }
})();

// Fast, dependency-free liveness check for the App Service health probe (stays
// green during boot and while the database is unreachable — see /ready).
app.get("/health", (c) => c.json({ ok: true, service: "axxiom-voice-agents", version: VERSION }));

// Dependency-aware readiness: confirms the database is reachable AND the
// `outbound` schema is there (a missing schema/grant makes every DNC check
// fail-closed, silently halting the dialer while /health stays green). On Azure
// it also reports WHO the app connected as — the managed-identity → Entra token
// → Postgres chain, end to end.
app.get("/ready", async (c) => {
  const checks: Record<string, boolean> = {};
  const info: Record<string, unknown> = { dataBackend: env.dataBackend, dialerEnabled: env.dialerEnabled };
  if (databaseConfigured()) {
    try {
      const { db } = await import("./outbound/db.ts");
      const { error } = await db().from("campaign").select("id", { count: "exact", head: true });
      checks.outboundSchema = !error;
      if (error) info.outboundSchemaError = error.message;
    } catch (err) {
      checks.outboundSchema = false;
      info.outboundSchemaError = String(err);
    }
    if (env.dataBackend === "azure") {
      try {
        const { pgWhoAmI } = await import("./lib/pg/backend.ts");
        const who = await pgWhoAmI();
        info.connectedAs = who.user;
        info.database = who.database;
        info.serverVersion = who.version;
      } catch (err) {
        checks.database = false;
        info.databaseError = String(err);
      }
    }
  } else {
    checks.databaseConfigured = false;
  }
  const ok = Object.values(checks).every(Boolean);
  return c.json({ ok, checks, ...info }, ok ? 200 : 503);
});

// Dashboard sign-in, then the outbound campaign API (campaigns, stats,
// start/pause, call-now, export, live stream).
app.route("/", auth);
app.route("/", outbound);

app.post("/vapi/webhook", async (c) => {
  // Verify the shared secret Vapi sends with every server message. Constant-time
  // compare, and FAIL CLOSED when no secret is configured (503) unless the
  // operator explicitly opted into insecure mode for local dev.
  if (env.vapiServerSecret) {
    const provided = c.req.header("x-vapi-secret") ?? "";
    if (!safeEqual(provided, env.vapiServerSecret)) {
      log.warn("Rejected webhook — bad x-vapi-secret");
      return c.json({ error: "unauthorized" }, 401);
    }
  } else if (!env.allowInsecureWebhook) {
    log.error("Refusing webhook — VAPI_SERVER_SECRET not set (set ALLOW_INSECURE_WEBHOOK=true for local dev only)");
    return c.json({ error: "webhook not configured" }, 503);
  } else {
    log.warn("VAPI_SERVER_SECRET not set — webhook is UNAUTHENTICATED (ALLOW_INSECURE_WEBHOOK)");
  }

  let body: VapiWebhookBody;
  try {
    body = await c.req.json<VapiWebhookBody>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const message = body?.message;
  if (!message?.type) return c.json({ error: "missing message.type" }, 400);

  try {
    // Route outbound campaign calls to their own handlers + schema.
    if (isOutboundCall(message)) {
      switch (message.type) {
        case "tool-calls": {
          const results = await handleOutboundToolCalls(message);
          return c.json(results);
        }
        case "status-update": {
          await handleOutboundStatusUpdate(message);
          return c.json({ ok: true });
        }
        case "transcript": {
          await handleOutboundTranscript(message);
          return c.json({ ok: true });
        }
        case "end-of-call-report": {
          await handleOutboundEndOfCall(message);
          return c.json({ ok: true });
        }
        default:
          return c.json({ ok: true });
      }
    }

    switch (message.type) {
      case "tool-calls": {
        const results = await handleToolCalls(message);
        return c.json(results);
      }
      case "end-of-call-report": {
        await handleEndOfCallReport(message);
        return c.json({ ok: true });
      }
      default:
        // status-update, transcript, speech-update, etc. — ack and ignore.
        return c.json({ ok: true });
    }
  } catch (err) {
    log.error("Webhook handler error", { type: message.type, err: String(err) });
    // Return 200 so Vapi doesn't retry-storm; we've logged the failure.
    return c.json({ ok: false });
  }
});

// The dashboard (static export). Registered last so API routes win; unknown
// API paths get a JSON 404 instead of the dashboard's HTML 404 page.
const API_PREFIXES = ["/outbound/", "/auth/", "/vapi/"];
app.get("*", async (c) => {
  const path = c.req.path;
  if (API_PREFIXES.some((p) => path.startsWith(p))) return c.json({ error: "not found" }, 404);
  const res = await serveDashboard(env.dashboardDir, path);
  if (res) return res;
  if (path === "/") {
    return c.text(`Axxiom voice agents — dashboard not built into ${env.dashboardDir}/ (see /health, /ready)`);
  }
  return c.json({ error: "not found" }, 404);
});

log.info(`Axxiom voice agents starting on :${env.port}`);
logConfigSummary((m) => log.info(m));
void dashboardAvailable(env.dashboardDir).then((ok) =>
  log.info(`Config — Dashboard files: ${ok ? `serving ${env.dashboardDir}/` : `NOT found in ${env.dashboardDir}/`}`),
);

// Loud boot guard: an unconfigured webhook secret now fails closed at request
// time, so surface it clearly at startup rather than silently accepting calls.
if (!env.vapiServerSecret && !env.allowInsecureWebhook) {
  log.error(
    "SECURITY: VAPI_SERVER_SECRET is not set — /vapi/webhook will REFUSE all requests (503). " +
      "Set VAPI_SERVER_SECRET (and match it on the Vapi assistant), or ALLOW_INSECURE_WEBHOOK=true for local dev only.",
  );
}

// Resume the outbound worker if a campaign was left running (e.g. after a
// deploy). Skipped entirely on a non-dialing instance (DIALER_ENABLED=false).
if (databaseConfigured() && env.outboundAssistantId && env.dialerEnabled) {
  void (async () => {
    try {
      const { db } = await import("./outbound/db.ts");
      const { startCampaignWorker } = await import("./outbound/dialer.ts");
      const { data } = await db().from("campaign").select("id").eq("status", "running").limit(1).maybeSingle();
      // Also resume when calls are still live with no campaign running (e.g. a
      // deploy landed right after pause) — the worker must tick until the stale
      // sweeper resolves them, else they sit "ringing" forever.
      const { count: liveCalls } = await db()
        .from("call")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "ringing", "in-progress"]);
      if (data || liveCalls) {
        log.info("Resuming outbound campaign worker", {
          runningCampaign: Boolean(data),
          liveCalls: liveCalls ?? 0,
        });
        startCampaignWorker();
      }
    } catch (err) {
      log.warn("Could not check for running campaigns at boot", { err: String(err) });
    }
  })();
}

// Process-level safety nets. Without these an unhandled rejection could crash
// the process silently; a deploy (SIGTERM) would kill the worker mid-tick.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", { reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  // Log then exit so App Service restarts a clean process rather than limping
  // along in an unknown state.
  log.error("Uncaught exception — exiting for restart", { err: String(err) });
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal} — shutting down gracefully`);
  try {
    // Stop the dialer worker so the interval doesn't fire during teardown.
    const { stopCampaignWorker } = await import("./outbound/dialer.ts");
    stopCampaignWorker();
  } catch (err) {
    log.warn("Error stopping worker on shutdown", { err: String(err) });
  }
  // Give in-flight webhook handlers a moment to finish, then close the
  // database pool and exit.
  setTimeout(() => {
    void import("./lib/pg/backend.ts")
      .then(({ closePool }) => closePool())
      .finally(() => process.exit(0));
  }, 1500);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Bun (local dev: `bun run dev`) serves the default export; Node (App Service:
// `node dist/server.mjs`) needs an explicit HTTP server.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
if (!isBun) {
  serve({ fetch: app.fetch, port: env.port }, (info) => log.info(`Listening on :${info.port} (node)`));
}

export default isBun
  ? {
      port: env.port,
      fetch: app.fetch,
      // Default is 10s; give outbound control calls (e.g. end-call) more
      // headroom. SSE heartbeats (25s) keep dashboard streams under this.
      idleTimeout: 30,
    }
  : undefined;
