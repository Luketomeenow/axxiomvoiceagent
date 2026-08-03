/**
 * Provider balance lookups for the analytics dashboard: how much money/credits
 * remain on the Twilio (carrier) and Vapi (voice platform) accounts.
 *
 * Twilio exposes an official Balance endpoint. Vapi has NO documented balance
 * endpoint for plain API keys — but its org endpoint (which embeds the
 * subscription's remaining credits) accepts a self-signed org JWT per Vapi's
 * documented JWT auth (HS256 over { orgId, token: { tag: "private" } } with the
 * private API key). If Vapi rejects that, we degrade gracefully: the dashboard
 * shows "n/a" with a link to the Vapi billing page instead of a number.
 *
 * Results are cached in-memory for 60s so dashboard loads don't hammer either
 * provider (single Railway instance — same assumption as the rest of the app).
 */

import { createHmac } from "node:crypto";

import { env } from "../config/env.ts";
import { fetchWithTimeout } from "../lib/http.ts";
import { log } from "../lib/logger.ts";

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const VAPI_API = "https://api.vapi.ai";

export interface ProviderBalance {
  ok: boolean;
  balance?: number;      // remaining balance/credits in `currency`
  currency?: string;     // "USD" for Twilio; Vapi credits are USD-equivalent
  detail?: string;       // extra context (e.g. Vapi minutes used)
  error?: string;        // why the balance is unavailable
}

export interface BalancesResult {
  twilio: ProviderBalance;
  vapi: ProviderBalance;
  fetchedAt: string;
}

async function getTwilioBalance(): Promise<ProviderBalance> {
  if (!env.twilioAccountSid || !env.twilioAuthToken) {
    return { ok: false, error: "TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set" };
  }
  try {
    const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");
    const res = await fetchWithTimeout(`${TWILIO_API}/Accounts/${env.twilioAccountSid}/Balance.json`, {
      headers: { Authorization: `Basic ${auth}` },
      timeoutMs: 10_000,
    });
    if (!res.ok) return { ok: false, error: `Twilio balance ${res.status}` };
    const json = (await res.json()) as { balance?: string; currency?: string };
    const balance = Number(json.balance);
    if (!Number.isFinite(balance)) return { ok: false, error: "Twilio returned no balance" };
    return { ok: true, balance, currency: json.currency ?? "USD" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Base64url-encode per JWT (no padding). */
function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * Self-signed Vapi org JWT (docs.vapi.ai/customization/jwt-authentication).
 * Signed with VAPI_JWT_SECRET (the org's JWT secret from the Vapi dashboard)
 * when set, else the API key — the org endpoint rejects the latter on most
 * accounts, in which case the dashboard shows how to enable this.
 */
function mintVapiJwt(orgId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ orgId, token: { tag: "private" }, iat: now, exp: now + 3600 }),
  );
  const secret = env.vapiJwtSecret || env.vapiApiKey;
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// The org id never changes for a given API key — resolve it once per process.
let cachedOrgId: string | undefined;

async function getVapiOrgId(): Promise<string | undefined> {
  if (cachedOrgId) return cachedOrgId;
  const res = await fetchWithTimeout(`${VAPI_API}/assistant?limit=1`, {
    headers: { Authorization: `Bearer ${env.vapiApiKey}` },
    timeoutMs: 10_000,
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as Array<{ orgId?: string }>;
  cachedOrgId = json[0]?.orgId;
  return cachedOrgId;
}

async function getVapiBalance(): Promise<ProviderBalance> {
  if (!env.vapiApiKey) return { ok: false, error: "VAPI_API_KEY not set" };
  try {
    const orgId = await getVapiOrgId();
    if (!orgId) return { ok: false, error: "could not resolve Vapi org id" };

    const res = await fetchWithTimeout(`${VAPI_API}/org`, {
      headers: { Authorization: `Bearer ${mintVapiJwt(orgId)}` },
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      // Expected until VAPI_JWT_SECRET is configured: surface a stable message
      // the UI turns into a "check the Vapi dashboard / set the secret" hint.
      const hint = env.vapiJwtSecret
        ? `Vapi org rejected the JWT (${res.status}) — check VAPI_JWT_SECRET`
        : `set VAPI_JWT_SECRET (Vapi dashboard → Org Settings) to enable (org ${res.status})`;
      return { ok: false, error: hint };
    }
    const org = (await res.json()) as {
      subscription?: { credits?: string; minutesUsed?: number; minutesIncluded?: number };
      minutesUsed?: number;
    };
    const credits = Number(org.subscription?.credits);
    if (!Number.isFinite(credits)) return { ok: false, error: "Vapi org has no credits field" };
    const minutes = org.subscription?.minutesUsed ?? org.minutesUsed;
    return {
      ok: true,
      balance: credits,
      currency: "USD",
      detail: minutes != null ? `${Math.round(minutes)} min used this period` : undefined,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

let cache: { at: number; result: BalancesResult } | undefined;
const CACHE_TTL_MS = 60_000;

/** Both providers' remaining balances, cached 60s. */
export async function getProviderBalances(): Promise<BalancesResult> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const [twilio, vapi] = await Promise.all([getTwilioBalance(), getVapiBalance()]);
  if (!twilio.ok) log.warn("balances: Twilio unavailable", { err: twilio.error });
  if (!vapi.ok) log.warn("balances: Vapi unavailable", { err: vapi.error });
  const result: BalancesResult = { twilio, vapi, fetchedAt: new Date().toISOString() };
  cache = { at: Date.now(), result };
  return result;
}
