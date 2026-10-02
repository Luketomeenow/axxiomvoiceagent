/**
 * Auth helpers shared by the Vapi webhook (constant-time secret check) and the
 * dashboard API (session-cookie verification).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { env, sessionSecret } from "../config/env.ts";
import { findUserById, type DashboardUser } from "../auth/users.ts";
import { scopedLog } from "./logger.ts";
import { SESSION_COOKIE, signSession, verifySession } from "./session.ts";

const log = scopedLog("auth");

/** The signed-in operator, set on the context by requireAuth. */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
  }
}

/**
 * Constant-time string comparison. Both sides are hashed to a fixed length so a
 * length mismatch neither leaks via timing nor throws in `timingSafeEqual`.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---- Session cookie ---------------------------------------------------------

function sessionTtlSeconds(): number {
  return Math.round(env.dashboardSessionHours * 3600);
}

// Secure everywhere except plain-http local dev (App Service terminates TLS in
// front of the app, so the browser always sees https in production).
function secureCookies(): boolean {
  return process.env.NODE_ENV === "production" || env.serverUrl.startsWith("https://");
}

export function issueSessionCookie(c: Context, user: DashboardUser): void {
  const now = Math.floor(Date.now() / 1000);
  const token = signSession(
    { sub: user.id, email: user.email, ver: user.session_version, iat: now, exp: now + sessionTtlSeconds() },
    sessionSecret(),
  );
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "Lax",
    path: "/",
    maxAge: sessionTtlSeconds(),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookies() });
}

// Positive + negative lookups are cached briefly: the dashboard fires many API
// calls per page, and each would otherwise be a database round trip. A
// disabled user / bumped session_version takes effect within the TTL.
const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map<string, { user: DashboardUser | null; until: number }>();

async function cachedUser(id: string): Promise<DashboardUser | null> {
  const hit = userCache.get(id);
  if (hit && hit.until > Date.now()) return hit.user;
  const user = await findUserById(id);
  if (userCache.size > 500) userCache.clear();
  userCache.set(id, { user, until: Date.now() + USER_CACHE_TTL_MS });
  return user;
}

/** Drop a user from the lookup cache (after a password change / sign-out). */
export function forgetCachedUser(id: string): void {
  userCache.delete(id);
}

// ---- CSRF defense-in-depth ---------------------------------------------------
// The cookie is SameSite=Lax, so browsers already refuse to send it on
// cross-site POSTs. On top of that, reject state-changing requests whose
// Origin is neither this host nor an explicitly allowed dashboard origin.

const allowedOrigins = env.dashboardOrigin
  ? env.dashboardOrigin.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export function isSameOriginRequest(c: Context): boolean {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = c.req.header("origin");
  if (!origin) return true; // non-browser client (curl): the cookie is still required
  if (allowedOrigins.includes(origin)) return true;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Hono middleware: require a signed-in dashboard operator. Verifies the session
 * cookie (HMAC + expiry), then that the account still exists, isn't disabled,
 * and hasn't been signed out (session_version). Renews the cookie while the
 * operator is active. Fails closed: 503 when DASHBOARD_SESSION_SECRET is unset
 * (or shorter than 32 chars) or the account lookup fails.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();

  const secret = sessionSecret();
  if (!secret) {
    log.error("requireAuth: DASHBOARD_SESSION_SECRET not set (or < 32 chars) — refusing (fail closed)");
    return c.json({ error: "auth not configured" }, 503);
  }
  if (!isSameOriginRequest(c)) {
    log.warn("requireAuth: rejected cross-site request", { origin: c.req.header("origin") });
    return c.json({ error: "forbidden" }, 403);
  }

  const claims = verifySession(getCookie(c, SESSION_COOKIE), secret);
  if (!claims) return c.json({ error: "unauthorized" }, 401);

  let user: DashboardUser | null;
  try {
    user = await cachedUser(claims.sub);
  } catch (err) {
    log.error("requireAuth: account lookup failed", { err: String(err) });
    return c.json({ error: "auth unavailable" }, 503);
  }
  if (!user || user.disabled || user.session_version !== claims.ver) {
    clearSessionCookie(c);
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", { id: user.id, email: user.email, name: user.name, role: user.role });
  // Sliding session: renew once less than half the lifetime is left.
  if (claims.exp - Date.now() / 1000 < sessionTtlSeconds() / 2) issueSessionCookie(c, user);
  return next();
};
