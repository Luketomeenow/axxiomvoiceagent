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
app.get("/health", (c) => c.json({ ok: true, service: "axxiom-voice-agents" }));

// Outbound campaign API (campaigns, stats, start/pause, call-now, export).
app.route("/", outbound);

app.post("/vapi/webhook", async (c) => {
  // Verify the shared secret Vapi sends with every server message.
  if (env.vapiServerSecret) {
    const provided = c.req.header("x-vapi-secret");
    if (provided !== env.vapiServerSecret) {
      log.warn("Rejected webhook — bad x-vapi-secret");
      return c.json({ error: "unauthorized" }, 401);
    }
  } else {
    log.warn("VAPI_SERVER_SECRET not set — webhook is unauthenticated");
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

// Resume the outbound worker if a campaign was left running (e.g. after a deploy).
if (env.supabaseUrl && env.supabaseServiceRoleKey && env.outboundAssistantId) {
  void (async () => {
    try {
      const { db } = await import("./outbound/db.ts");
      const { startCampaignWorker } = await import("./outbound/dialer.ts");
      const { data } = await db().from("campaign").select("id").eq("status", "running").limit(1).maybeSingle();
      if (data) {
        log.info("Resuming outbound campaign worker (campaign was running)");
        startCampaignWorker();
      }
    } catch (err) {
      log.warn("Could not check for running campaigns at boot", { err: String(err) });
    }
  })();
}

export default {
  port: env.port,
  fetch: app.fetch,
  // Default is 10s; give outbound control calls (e.g. end-call) more headroom.
  idleTimeout: 30,
};
