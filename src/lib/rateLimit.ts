/**
 * Tiny in-memory fixed-window rate limiter. Single-instance only (like the rest
 * of the per-call state — see CLAUDE.md); fine as defense-in-depth in front of
 * the authenticated dashboard API. Keyed by client IP.
 */

import type { MiddlewareHandler } from "hono";
import { log } from "./logger.ts";

export function rateLimit(opts: { windowMs: number; max: number }): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();

    const now = Date.now();
    const key =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      // New window. Opportunistically drop expired keys so the map can't grow
      // unbounded across many client IPs.
      if (hits.size > 1000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }

    entry.count++;
    if (entry.count > opts.max) {
      log.warn("Rate limit exceeded", { key, count: entry.count });
      return c.json({ error: "rate limited" }, 429);
    }
    return next();
  };
}
