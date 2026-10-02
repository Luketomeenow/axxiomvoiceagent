/**
 * Dashboard sign-in (replaces Supabase Auth):
 *   POST /auth/login     { email, password } → session cookie
 *   POST /auth/logout    clears the cookie
 *   GET  /auth/me        the signed-in operator + instance flags (401 if none)
 *   POST /auth/password  { current, next } → new password, signs out other sessions
 */

import { Hono } from "hono";

import { env, sessionSecret } from "../config/env.ts";
import { clearSessionCookie, forgetCachedUser, issueSessionCookie, isSameOriginRequest, requireAuth } from "../lib/auth.ts";
import { log } from "../lib/logger.ts";
import { hashPassword, passwordPolicyError, verifyAgainstDummy, verifyPassword } from "../lib/passwords.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { maskEmail } from "../lib/redact.ts";
import { findUserById, findUserByEmail, setPasswordHash, touchLastLogin } from "./users.ts";

export const auth = new Hono();

// Brute-force brake on the credential endpoints (per client IP).
const credentialLimit = rateLimit({ windowMs: 5 * 60_000, max: 10 });

auth.post("/auth/login", credentialLimit, async (c) => {
  if (!sessionSecret()) {
    log.error("login refused: DASHBOARD_SESSION_SECRET not set (or < 32 chars)");
    return c.json({ error: "auth not configured" }, 503);
  }
  if (!isSameOriginRequest(c)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as Record<string, never>);
  const email = String(body.email ?? "").trim();
  const password = String(body.password ?? "");
  if (!email || !password) return c.json({ error: "email and password are required" }, 400);

  let user;
  try {
    user = await findUserByEmail(email);
  } catch (err) {
    log.error("login: account lookup failed", { err: String(err) });
    return c.json({ error: "sign-in is unavailable right now" }, 503);
  }
  const ok = user && !user.disabled ? await verifyPassword(password, user.password_hash) : await verifyAgainstDummy(password);
  if (!user || !ok) {
    log.warn("login rejected", { email: maskEmail(email) });
    return c.json({ error: "Invalid email or password." }, 401);
  }

  issueSessionCookie(c, user);
  await touchLastLogin(user.id).catch(() => {});
  log.info("login", { email: maskEmail(user.email) });
  return c.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
});

auth.post("/auth/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

auth.get("/auth/me", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({
    user: { email: user.email, name: user.name, role: user.role },
    instance: { dialerEnabled: env.dialerEnabled, dataBackend: env.dataBackend },
  });
});

auth.post("/auth/password", credentialLimit, requireAuth, async (c) => {
  const body = await c.req.json<{ current?: string; next?: string }>().catch(() => ({}) as Record<string, never>);
  const current = String(body.current ?? "");
  const next = String(body.next ?? "");
  const policy = passwordPolicyError(next);
  if (policy) return c.json({ ok: false, error: policy }, 400);

  const user = await findUserById(c.get("user").id);
  if (!user || !(await verifyPassword(current, user.password_hash))) {
    return c.json({ ok: false, error: "Current password is incorrect." }, 400);
  }
  const updated = await setPasswordHash(user, await hashPassword(next));
  forgetCachedUser(user.id);
  issueSessionCookie(c, updated); // this browser stays signed in; every other session is signed out
  log.info("password changed", { email: maskEmail(user.email) });
  return c.json({ ok: true });
});
