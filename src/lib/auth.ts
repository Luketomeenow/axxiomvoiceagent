/**
 * Auth helpers shared by the Vapi webhook (constant-time secret check) and the
 * dashboard API (Supabase user-JWT verification).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MiddlewareHandler } from "hono";

import { env } from "../config/env.ts";
import { log } from "./logger.ts";

/**
 * Constant-time string comparison. Both sides are hashed to a fixed length so a
 * length mismatch neither leaks via timing nor throws in `timingSafeEqual`.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Lazy Supabase client (anon key) used ONLY to validate dashboard user JWTs —
// never for data access. Auth is independent of the DB schema.
let authClient: SupabaseClient | undefined;
function getAuthClient(): SupabaseClient | undefined {
  if (!env.supabaseUrl || !env.supabaseAnonKey) return undefined;
  if (!authClient) {
    authClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return authClient;
}

// Positive-result token cache: the dashboard fires many API calls with the same
// JWT, and validating each one is a network round-trip to Supabase Auth that
// gates the whole request. Trade-off: a revoked-but-unexpired token stays
// honored for up to the TTL — acceptable for an invite-only operator dashboard.
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX = 500;
const AUTH_TIMEOUT_MS = 8_000;
const authCache = new Map<string, number>(); // sha256(token) -> expiresAt

/**
 * Hono middleware: require a valid Supabase user JWT on the request. Reads
 * `Authorization: Bearer <token>`, validates it with Supabase (cached 60s per
 * token, 8s validation timeout), and 401s on a missing/invalid token.
 * Preflight (OPTIONS) passes through so CORS still works. Fails closed (503)
 * if the backend isn't configured to validate tokens or validation times out.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();

  const client = getAuthClient();
  if (!client) {
    log.error("requireAuth: SUPABASE_URL/SUPABASE_ANON_KEY not set — refusing (fail closed)");
    return c.json({ error: "auth not configured" }, 503);
  }

  const header = c.req.header("Authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const key = createHash("sha256").update(token).digest("hex");
  const cachedUntil = authCache.get(key);
  if (cachedUntil && cachedUntil > Date.now()) return next();

  let result: Awaited<ReturnType<typeof client.auth.getUser>>;
  try {
    result = await Promise.race([
      client.auth.getUser(token),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`auth timeout after ${AUTH_TIMEOUT_MS}ms`)), AUTH_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    log.error("requireAuth: token validation failed", { err: String(err) });
    return c.json({ error: "auth timeout" }, 503);
  }

  const { data, error } = result;
  if (error || !data?.user) {
    log.warn("requireAuth: rejected request — invalid token", { err: error?.message });
    return c.json({ error: "unauthorized" }, 401);
  }

  if (authCache.size >= AUTH_CACHE_MAX) authCache.clear();
  authCache.set(key, Date.now() + AUTH_CACHE_TTL_MS);
  return next();
};
