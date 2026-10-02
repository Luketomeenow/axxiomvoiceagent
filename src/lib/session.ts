/**
 * Dashboard session tokens: `<base64url(json claims)>.<base64url(hmac-sha256)>`,
 * carried in an httpOnly, SameSite=Lax cookie. Stateless — the claims carry
 * the user's `session_version`, and requireAuth re-checks it against the
 * database (briefly cached), so bumping the version (password change, disable)
 * signs that user out everywhere.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "axv_session";

export interface SessionClaims {
  sub: string; // dashboard_user.id
  email: string;
  ver: number; // dashboard_user.session_version at sign-in
  iat: number; // seconds
  exp: number; // seconds
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signSession(claims: SessionClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, nowMs = Date.now()): SessionClaims | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const expected = Buffer.from(sign(body, secret));
  const provided = Buffer.from(token.slice(dot + 1));
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (
    typeof claims?.sub !== "string" ||
    typeof claims.email !== "string" ||
    typeof claims.ver !== "number" ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= nowMs
  ) {
    return null;
  }
  return claims;
}
