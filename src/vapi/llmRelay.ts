/**
 * The voice agents' brain inside Azure AI Foundry. With VOICE_PROVIDER=foundry
 * each Vapi assistant uses Vapi's "custom-llm" model pointed at
 * ${SERVER_URL}/vapi/llm; Vapi POSTs OpenAI-format chat completions here and
 * we relay them to the Foundry deployment (VOICE_MODEL, e.g. gpt-5.6-terra),
 * streaming the answer straight back.
 *
 * Why a relay instead of pointing Vapi at Foundry directly:
 *  - Foundry's GPT deployments reject parameters Vapi sends: `max_tokens`
 *    (must be `max_completion_tokens`), a non-default `temperature`, and
 *    `parallel_tool_calls` without tools — each one is an HTTP 400, i.e. a dead
 *    turn mid-call. We rename/drop them here.
 *  - The Foundry key never leaves Azure (Key Vault → this app). Vapi only
 *    holds the webhook secret it already has.
 *  - Claude in Foundry is not served through the OpenAI-compatible API, so a
 *    GPT deployment is used (tested 2026-10: tools ✓, ~1.6–2.2 s to first words).
 */

import type { Context } from "hono";

import { env } from "../config/env.ts";
import { safeEqual } from "../lib/auth.ts";
import { scopedLog } from "../lib/logger.ts";

const log = scopedLog("llm-relay");

// OpenAI chat-completions fields Foundry accepts. Everything else Vapi adds
// (call/metadata objects, sampling knobs the reasoning models reject) is dropped.
const PASS_THROUGH = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "max_completion_tokens",
  "stop",
  "response_format",
  "seed",
  "user",
] as const;

const UPSTREAM_TIMEOUT_MS = 60_000;
const loggedShapes = new Set<string>();

function authorized(c: Context): boolean {
  const secret = env.vapiServerSecret;
  if (!secret) return env.allowInsecureWebhook;
  const header = c.req.header("x-vapi-secret") ?? "";
  const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return (header !== "" && safeEqual(header, secret)) || (bearer !== "" && safeEqual(bearer, secret));
}

/** Map what Vapi sends onto what Foundry accepts. Exported for tests. */
export function toFoundryRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PASS_THROUGH) if (body[key] !== undefined) out[key] = body[key];
  if (out.max_completion_tokens === undefined && typeof body.max_tokens === "number") {
    out.max_completion_tokens = body.max_tokens;
  }
  const hasTools = Array.isArray(out.tools) && out.tools.length > 0;
  if (!hasTools) {
    delete out.tools;
    delete out.tool_choice;
    delete out.parallel_tool_calls;
  }
  out.model = typeof out.model === "string" && out.model ? out.model : env.voiceModel;
  return out;
}

export async function handleLlmRelay(c: Context): Promise<Response> {
  if (!authorized(c)) {
    log.warn("LLM relay rejected — bad or missing secret", {
      hasXVapiSecret: Boolean(c.req.header("x-vapi-secret")),
      hasAuthorization: Boolean(c.req.header("authorization")),
    });
    return c.json({ error: { message: "unauthorized" } }, env.vapiServerSecret ? 401 : 503);
  }
  if (!env.foundryApiKey) {
    log.error("LLM relay: FOUNDRY_API_KEY (or ANTHROPIC_API_KEY) not set");
    return c.json({ error: { message: "voice model not configured" } }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: { message: "invalid json" } }, 400);
  }
  const request = toFoundryRequest(body);

  // Log the SHAPE of what Vapi sends once per distinct key set (keys only — the
  // messages are call content), so a new Vapi parameter shows up in the logs.
  const shape = Object.keys(body).sort().join(",");
  if (!loggedShapes.has(shape) && loggedShapes.size < 20) {
    loggedShapes.add(shape);
    log.info("LLM relay: request shape from Vapi", { keys: shape, model: request.model });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${env.foundryOpenAiUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": env.foundryApiKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    log.error("LLM relay: Foundry unreachable", { err: String(err) });
    return c.json({ error: { message: "voice model unreachable" } }, 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    log.error("LLM relay: Foundry rejected the request", {
      status: upstream.status,
      model: request.model,
      error: text.slice(0, 300),
    });
    return new Response(text, { status: upstream.status, headers: { "Content-Type": "application/json" } });
  }

  // Stream (SSE) or JSON — pass the body straight through, unbuffered.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
