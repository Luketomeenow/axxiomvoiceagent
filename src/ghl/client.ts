/**
 * Minimal GoHighLevel (LeadConnector v2) client.
 *
 * Mirrors the auth conventions used in axxiommarketinghub
 * (services.leadconnectorhq.com, Version 2021-07-28, Bearer private-integration
 * token) so the same GHL_ACCESS_TOKEN / GHL_LOCATION_ID values carry over.
 */

import { assertGhl, env } from "../config/env.ts";
import { log } from "../lib/logger.ts";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
// Bound each GHL call so a hung endpoint can't stall the webhook (and thus the
// live call) past Vapi's tool timeout. runBookSurvey chains several of these.
const GHL_TIMEOUT_MS = 10_000;

export class GhlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GhlError";
  }
}

interface GhlRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export async function ghlFetch<T = unknown>({ method = "GET", path, query, body }: GhlRequest): Promise<T> {
  assertGhl();

  const url = new URL(GHL_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.ghlAccessToken}`,
        Version: GHL_VERSION,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout (TimeoutError) or network failure — surface as a GhlError so callers
    // handle it uniformly instead of a raw abort propagating up.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    log.error("GHL request failed", { path, err: timedOut ? `timeout after ${GHL_TIMEOUT_MS}ms` : String(err) });
    throw new GhlError(`GHL ${method} ${path} → ${timedOut ? "timeout" : "network error"}`, 0, String(err));
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    log.error("GHL request failed", { path, status: res.status, body: parsed });
    throw new GhlError(`GHL ${method} ${path} → ${res.status}`, res.status, parsed);
  }

  return parsed as T;
}
