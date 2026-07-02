/**
 * Supabase access scoped to the `outbound` schema (separate from the inbound
 * `public.ax_voice_call` flow). Used by the dialer, webhook handlers, and the
 * Hono API routes. The Next.js dashboard talks to Supabase directly with the
 * anon key + Realtime; this client uses the service role for writes.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assertSupabase, env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { maskPhone } from "../lib/redact.ts";

let client: SupabaseClient | undefined;

/** Service-role client whose default schema is `outbound`. */
export function db(): SupabaseClient {
  assertSupabase();
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false },
      db: { schema: env.outboundSchema },
    }) as unknown as SupabaseClient;
  }
  return client;
}

// --- Domain types ----------------------------------------------------------

export type Disposition =
  | "new"
  | "queued"
  | "calling"
  | "qualified"
  | "needs_followup"
  | "remove"
  | "no_answer"
  | "voicemail"
  | "bad_number"
  | "not_interested"
  | "dnc";

export interface LeadRow {
  id: string;
  campaign_id: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  owner_phone: string | null;
  dial_phone: string | null;
  building_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  region: string | null;
  oem_match: string | null;
  problem_type: string | null;
  inspection_type: string | null;
  violation_codes: string | null;
  violation_count: number | null;
  violation_details: string | null;
  last_inspection_date: string | null;
  cert_expiry_date: string | null;
  lead_score: number | null;
  lead_tier: string | null;
  servicing_brand: string | null;
  disposition: Disposition;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_after: string | null;
  consent_recording: boolean | null;
  consent_recording_at: string | null;
  dnc: boolean;
  notes: string | null;
  // Structured, sales-ready qualification fields (captured by the agent tools).
  decision_maker: boolean | null;
  current_provider: string | null;
  timeline: string | null;
  callback_name: string | null;
  callback_phone: string | null;
  callback_email: string | null;
  qualified_at: string | null;
}

export interface CallRow {
  id: string;
  lead_id: string | null;
  campaign_id: string | null;
  vapi_call_id: string | null;
  phone_number: string | null;
  status: string;
  outcome: string | null;
  disposition: string | null;
  consent_captured: boolean | null;
  consent_at: string | null;
  disclosed_at: string | null;
  attempt_number: number | null;
  brand: string | null;
  sentiment_score: number | null;
  structured_data: unknown;
  success_evaluation: string | null;
  transferred_to_human: boolean | null;
  duration_seconds: number | null;
  ended_reason: string | null;
  ended_by: string | null; // customer | agent | operator | system
  vapi_cost: number | null; // Vapi platform cost
  telephony_cost: number | null; // Twilio per-call price (reconciled by twilioSync)
  provider_call_id: string | null; // Twilio Call SID
  provider_status: string | null;
  answered_by: string | null;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  raw: unknown;
  started_at: string | null;
  ended_at: string | null;
}

// --- Write resilience ------------------------------------------------------
// Supabase calls resolve with `{ error }` rather than throwing, so a failed
// write used to be silently ignored (the agent kept talking; the lead's data
// was lost). These helpers retry transient failures and, when retries are
// exhausted, persist the attempted write to `failed_op` (a dead-letter table)
// so it's visible + replayable instead of dropped.

/** Record a write that could not be persisted, for later inspection/replay. */
export async function recordFailedOp(op: {
  kind: string;
  ref_id?: string | null;
  payload?: unknown;
  error: string;
}): Promise<void> {
  try {
    await db()
      .from("failed_op")
      .insert({ kind: op.kind, ref_id: op.ref_id ?? null, payload: op.payload ?? null, error: op.error });
  } catch (err) {
    // Last resort: the dead-letter itself is unreachable — log loudly so it's
    // at least in the application logs.
    log.error("dead-letter insert failed", { kind: op.kind, refId: op.ref_id, origError: op.error, err: String(err) });
  }
}

/**
 * Run a write that throws on failure, retrying a couple of times, then
 * dead-lettering. Returns true on success, false if it ultimately failed.
 */
export async function withRetry(
  label: string,
  fn: () => Promise<void>,
  deadLetter?: { kind: string; ref_id?: string | null; payload?: unknown },
  retries = 2,
): Promise<boolean> {
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fn();
      if (attempt > 0) log.info(`${label} succeeded on retry`, { attempt });
      return true;
    } catch (err) {
      lastErr = String(err);
      log.warn(`${label} write failed`, { attempt: attempt + 1, of: retries + 1, err: lastErr });
    }
  }
  log.error(`${label} exhausted retries — dead-lettering`, { err: lastErr });
  if (deadLetter) await recordFailedOp({ ...deadLetter, error: lastErr });
  return false;
}

/** Update a lead with retry + dead-letter. Never throws into the caller. */
export async function updateLead(id: string, patch: Record<string, unknown>): Promise<boolean> {
  return withRetry(
    "lead.update",
    async () => {
      const { error } = await db().from("lead").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    { kind: "lead.update", ref_id: id, payload: patch },
  );
}

/** Update a call with retry + dead-letter. Never throws into the caller. */
export async function updateCall(id: string, patch: Record<string, unknown>): Promise<boolean> {
  return withRetry(
    "call.update",
    async () => {
      const { error } = await db().from("call").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    { kind: "call.update", ref_id: id, payload: patch },
  );
}

// --- Helpers ---------------------------------------------------------------

export type SuppressionCheck =
  | { suppressed: false; reason: "clear" }
  | { suppressed: true; reason: "empty" | "listed" | "lookup_error"; error?: string };

/**
 * Check whether a number is on the suppression list.
 *
 * Fails closed (suppress) on error for compliance, BUT distinguishes a real
 * DNC hit (`listed`) from a Supabase/connectivity problem (`lookup_error`) so
 * callers can surface an actionable reason instead of a misleading "DNC".
 */
export async function checkSuppression(phone: string): Promise<SuppressionCheck> {
  if (!phone) return { suppressed: true, reason: "empty" };
  const { data, error } = await db().from("dnc_suppression").select("phone").eq("phone", phone).maybeSingle();
  if (error) {
    log.warn("DNC lookup failed — suppressing to be safe", { phone: maskPhone(phone), error: error.message });
    return { suppressed: true, reason: "lookup_error", error: error.message };
  }
  return data ? { suppressed: true, reason: "listed" } : { suppressed: false, reason: "clear" };
}

/** True if a number is on the suppression list. Fails closed (suppress) on error. */
export async function isSuppressed(phone: string): Promise<boolean> {
  return (await checkSuppression(phone)).suppressed;
}

/**
 * Re-apply dead-lettered writes (outbound.failed_op) that previously exhausted
 * their in-process retries, marking each resolved on success. Surfaced via
 * POST /outbound/failed-ops/replay so an operator can recover lost lead/call/
 * event writes instead of them only being counted on the analytics card.
 */
export async function replayFailedOps(limit = 200): Promise<{ attempted: number; resolved: number }> {
  const { data, error } = await db()
    .from("failed_op")
    .select("*")
    .eq("resolved", false)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    log.warn("failed_op replay: could not read queue", { err: error.message });
    return { attempted: 0, resolved: 0 };
  }

  let resolved = 0;
  for (const op of data ?? []) {
    const row = op as { id: number; kind: string; ref_id: string | null; payload: Record<string, unknown> | null };
    const payload = { ...(row.payload ?? {}) } as Record<string, unknown>;
    let ok = false;
    try {
      if (row.kind === "lead.update" && row.ref_id) {
        // suppressNumber dead-letters a by-dial_phone update tagged with `by`.
        if (payload.by === "dial_phone") {
          delete payload.by;
          const { error: e } = await db().from("lead").update(payload).eq("dial_phone", row.ref_id);
          ok = !e;
        } else {
          const { error: e } = await db().from("lead").update(payload).eq("id", row.ref_id);
          ok = !e;
        }
      } else if (row.kind === "call.update" && row.ref_id) {
        const { error: e } = await db().from("call").update(payload).eq("id", row.ref_id);
        ok = !e;
      } else if (row.kind === "call_event") {
        const { error: e } = await db().from("call_event").insert(payload);
        ok = !e;
      } else if (row.kind === "dnc_suppression") {
        const { error: e } = await db().from("dnc_suppression").upsert(payload, { onConflict: "phone" });
        ok = !e;
      } else {
        log.warn("failed_op replay: unknown kind, skipping", { kind: row.kind, id: row.id });
        continue;
      }
    } catch (err) {
      log.warn("failed_op replay: write threw", { id: row.id, err: String(err) });
      ok = false;
    }
    if (ok) {
      await db().from("failed_op").update({ resolved: true }).eq("id", row.id);
      resolved++;
    }
  }
  log.info("failed_op replay complete", { attempted: data?.length ?? 0, resolved });
  return { attempted: data?.length ?? 0, resolved };
}

/**
 * Data retention: null out sensitive call content (transcript / recording_url /
 * summary / raw) and call_event text/payload older than `retainDays`. Structural
 * rows + aggregate metrics stay for reporting; only the PII-bearing content is
 * purged. Idempotent — run it on a schedule (or via the retention endpoint).
 */
export async function purgeOldPii(retainDays = env.piiRetainDays): Promise<{ calls: number; events: number }> {
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
  const { data: calls, error: callErr } = await db()
    .from("call")
    .update({ transcript: null, recording_url: null, summary: null, raw: null })
    .lt("created_at", cutoff)
    .not("transcript", "is", null)
    .select("id");
  if (callErr) log.warn("PII purge (calls) failed", { err: callErr.message });
  const { data: events, error: evErr } = await db()
    .from("call_event")
    .update({ text: null, payload: null })
    .lt("at", cutoff)
    .not("payload", "is", null)
    .select("id");
  if (evErr) log.warn("PII purge (events) failed", { err: evErr.message });
  const result = { calls: calls?.length ?? 0, events: events?.length ?? 0 };
  log.info("PII purge complete", { retainDays, ...result });
  return result;
}

/**
 * DSAR / right-to-erasure: delete every lead row for a phone number (their calls
 * + call_events cascade), plus any remaining calls placed to that number, and
 * keep the number on the DNC suppression list (the minimal data we must retain
 * so it's never re-imported or re-dialed). Returns how much was removed.
 */
export async function deleteLeadDataByPhone(phone: string): Promise<{ deletedLeads: number; deletedCalls: number }> {
  const e164 = phone.trim();
  // Suppress first so a concurrent import/dial can't re-add it mid-erasure.
  await suppressNumber(e164, "erasure request (DSAR)", "manual");
  const { data: leads } = await db()
    .from("lead")
    .delete()
    .or(`dial_phone.eq.${e164},contact_phone.eq.${e164},owner_phone.eq.${e164}`)
    .select("id");
  // Catch calls not tied to a (now-deleted) lead — e.g. ad-hoc test calls.
  const { data: calls } = await db().from("call").delete().eq("phone_number", e164).select("id");
  const result = { deletedLeads: leads?.length ?? 0, deletedCalls: calls?.length ?? 0 };
  log.info("DSAR erasure complete", { ...result });
  return result;
}

/** Add a number to the suppression list and mark its lead as DNC. */
export async function suppressNumber(phone: string, reason: string, source = "caller_request"): Promise<void> {
  if (!phone) return;
  // The suppression-list write is the one that MUST land (it's what blocks
  // future dials), so retry + dead-letter it.
  await withRetry(
    "dnc_suppression.upsert",
    async () => {
      const { error } = await db().from("dnc_suppression").upsert({ phone, reason, source }, { onConflict: "phone" });
      if (error) throw new Error(error.message);
    },
    { kind: "dnc_suppression", ref_id: phone, payload: { phone, reason, source } },
  );
  await withRetry(
    "lead.dnc",
    async () => {
      const { error } = await db().from("lead").update({ dnc: true, disposition: "dnc" }).eq("dial_phone", phone);
      if (error) throw new Error(error.message);
    },
    { kind: "lead.update", ref_id: phone, payload: { dnc: true, disposition: "dnc", by: "dial_phone" } },
  );
}

/**
 * Append a live/audit event for a call. Never throws into the caller, but —
 * unlike before — a failure is retried once and then dead-lettered, so a lost
 * compliance event (disclosure/consent/transcript) is recoverable rather than
 * silently gone.
 */
export async function recordEvent(event: {
  call_id?: string | null;
  vapi_call_id?: string | null;
  type: string;
  role?: string | null;
  text?: string | null;
  payload?: unknown;
}): Promise<void> {
  const row = {
    call_id: event.call_id ?? null,
    vapi_call_id: event.vapi_call_id ?? null,
    type: event.type,
    role: event.role ?? null,
    text: event.text ?? null,
    payload: event.payload ?? null,
  };
  await withRetry(
    "call_event.insert",
    async () => {
      const { error } = await db().from("call_event").insert(row);
      if (error) throw new Error(error.message);
    },
    { kind: "call_event", ref_id: event.call_id ?? event.vapi_call_id ?? null, payload: row },
    1,
  );
}
