/**
 * Reconcile authoritative telephony data from Twilio onto our call rows. Vapi
 * orchestrates the call + owns the transcript/recording/analysis; Twilio is the
 * carrier and owns the real per-call PRICE, carrier STATUS, and answered-by. We
 * match by the Twilio Call SID (captured from Vapi's phoneCallProviderId) and
 * fill telephony_cost / provider_status / answered_by.
 *
 * Needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN in the server env (App Service settings / Key Vault) — the
 * same creds the import CLI uses. No-ops cleanly if they aren't set.
 */

import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { db } from "./db.ts";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

interface TwilioCall {
  sid: string;
  price: string | null; // negative string once finalized, e.g. "-0.017"; null until then
  price_unit?: string;
  status?: string;
  answered_by?: string | null;
}

async function fetchTwilioCall(sid: string): Promise<TwilioCall | null> {
  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");
  try {
    const res = await fetch(`${TWILIO_API}/Accounts/${env.twilioAccountSid}/Calls/${sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.warn("twilioSync: fetch failed", { sid, status: res.status });
      return null;
    }
    return (await res.json()) as TwilioCall;
  } catch (err) {
    log.warn("twilioSync: fetch threw", { sid, err: String(err) });
    return null;
  }
}

/**
 * Pull Twilio telephony data for recent calls that have a Twilio Call SID but no
 * telephony cost yet. Twilio finalizes price shortly after a call ends, so calls
 * whose price isn't ready are simply left for the next sync.
 */
export async function syncTwilioCosts(
  opts: { campaignId?: string; limit?: number } = {},
): Promise<{ checked: number; updated: number; remaining: number }> {
  if (!env.twilioAccountSid || !env.twilioAuthToken) {
    log.warn("twilioSync: TWILIO creds not set — skipping");
    return { checked: 0, updated: 0, remaining: 0 };
  }

  let q = db()
    .from("call")
    .select("id, provider_call_id")
    .not("provider_call_id", "is", null)
    // Only real Twilio Call SIDs (CA + 32 hex). Calls dialed from Vapi-bought
    // numbers carry a UUID here and would 404 against Twilio on every pass.
    .like("provider_call_id", "CA%")
    .is("telephony_cost", null)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);

  const { data } = await q;
  const rows = (data ?? []) as { id: string; provider_call_id: string }[];

  // Bounded concurrency + a time box: this runs inline in a dashboard request
  // (30s server idleTimeout), and a big backlog done serially (8s timeout per
  // Twilio fetch) could take minutes. Whatever we don't get to is left for the
  // next sync, same as prices Twilio hasn't finalized yet.
  const CHUNK_SIZE = 6;
  const deadline = Date.now() + 20_000;

  let checked = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    if (Date.now() >= deadline) break;
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map(async (row) => {
        const tc = await fetchTwilioCall(row.provider_call_id);
        if (!tc) return false;
        // Twilio price is a negative string (a charge) and only appears once finalized.
        const price = tc.price != null && tc.price !== "" ? Math.abs(Number(tc.price)) : null;
        const patch: Record<string, unknown> = {
          provider_status: tc.status ?? null,
          answered_by: tc.answered_by ?? null,
        };
        const priced = Number.isFinite(price as number);
        if (priced) patch.telephony_cost = price;
        await db().from("call").update(patch).eq("id", row.id);
        return priced;
      }),
    );
    checked += chunk.length;
    updated += results.filter(Boolean).length;
  }

  const remaining = rows.length - checked;
  log.info("twilioSync complete", { checked, updated, remaining });
  return { checked, updated, remaining };
}
