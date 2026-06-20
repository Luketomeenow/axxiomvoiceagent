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

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.ghlAccessToken}`,
      Version: GHL_VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

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
