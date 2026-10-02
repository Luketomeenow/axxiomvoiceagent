/**
 * Tiny in-memory fixed-window rate limiter. Single-instance only (like the rest
 * of the per-call state — see CLAUDE.md); fine as defense-in-depth in front of
 * the authenticated dashboard API. Keyed by client IP.
 */

import type { Context, MiddlewareHandler } from "hono";
import { log } from "./logger.ts";

/**
 * The client IP. App Service's front end APPENDS "ip:port" to X-Forwarded-For,
 * so the right-most hop is the one it added (anything earlier is
 * client-supplied), and the port must be stripped — keyed on the raw value,
 * every new connection looked like a new client and the limit never tripped.
 */
export function clientIp(c: Context): string {
  const hop = c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || c.req.header("x-real-ip") || "";
  if (!hop) return "unknown";
  if (hop.startsWith("[")) return hop.slice(1, hop.indexOf("]")); // [ipv6]:port
  const colons = hop.split(":").length - 1;
  return colons === 1 ? hop.slice(0, hop.indexOf(":")) : hop; // ipv4:port → ipv4; bare ipv6 stays
}

export function rateLimit(opts: { windowMs: number; max: number }): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();

    const now = Date.now();
    const key = clientIp(c);

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
