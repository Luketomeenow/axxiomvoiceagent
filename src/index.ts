/**
 * Axxiom inbound voice agent — HTTP service.
 *
 *   GET  /health        Railway health check
 *   POST /vapi/webhook   Vapi server messages (tool-calls, end-of-call-report)
 *
 * Boots even with empty config so the first deploy is green; each feature warns
 * until its keys are present.
 */

import { Hono } from "hono";

import { env, logConfigSummary } from "./config/env.ts";
import { log } from "./lib/logger.ts";
import { safeEqual } from "./lib/auth.ts";
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

app.get("/", (c) => c.text("Axxiom voice agents — see /health"));
// Fast, dependency-free liveness check for Railway (stays green during boot).
app.get("/health", (c) => c.json({ ok: true, service: "axxiom-voice-agents" }));

// Dependency-aware readiness: confirms Supabase is reachable AND the `outbound`
// schema is actually exposed (a common misconfig that makes every DNC check
// fail-closed, silently halting the dialer while /health stays green).
app.get("/ready", async (c) => {
  const checks: Record<string, boolean> = {};
  if (env.supabaseUrl && env.supabaseServiceRoleKey) {
    try {
      const { db } = await import("./outbound/db.ts");
      const { error } = await db().from("campaign").select("id", { count: "exact", head: true });
      checks.outboundSchema = !error;
    } catch {
      checks.outboundSchema = false;
    }
  }
  const ok = Object.values(checks).every(Boolean);
  return c.json({ ok, checks }, ok ? 200 : 503);
});

// Outbound campaign API (campaigns, stats, start/pause, call-now, export).
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

log.info(`Axxiom voice agents starting on :${env.port}`);
logConfigSummary((m) => log.info(m));

// Loud boot guard: an unconfigured webhook secret now fails closed at request
// time, so surface it clearly at startup rather than silently accepting calls.
if (!env.vapiServerSecret && !env.allowInsecureWebhook) {
  log.error(
    "SECURITY: VAPI_SERVER_SECRET is not set — /vapi/webhook will REFUSE all requests (503). " +
      "Set VAPI_SERVER_SECRET (and match it on the Vapi assistant), or ALLOW_INSECURE_WEBHOOK=true for local dev only.",
  );
}

// Resume the outbound worker if a campaign was left running (e.g. after a deploy).
if (env.supabaseUrl && env.supabaseServiceRoleKey && env.outboundAssistantId) {
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
  // Log then exit so Railway (ON_FAILURE) restarts a clean process rather than
  // limping along in an unknown state.
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
  // Give in-flight webhook handlers a moment to finish, then exit.
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export default {
  port: env.port,
  fetch: app.fetch,
  // Default is 10s; give outbound control calls (e.g. end-call) more headroom.
  idleTimeout: 30,
};
