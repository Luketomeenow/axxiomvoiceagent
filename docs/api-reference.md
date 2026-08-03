# API Reference

Two surfaces: the **HTTP API** (Hono, consumed by Vapi and the dashboard) and the **assistant tools** (functions the LLM calls, dispatched to our webhook).

## Authentication

| Surface | Auth |
|---------|------|
| `/health`, `/ready` | Public. |
| `POST /vapi/webhook` | `x-vapi-secret` header, compared constant-time against `VAPI_SERVER_SECRET`. **Fails closed**: 503 if the secret is unset (unless `ALLOW_INSECURE_WEBHOOK=true`, local dev only), 401 on mismatch. |
| `/outbound/*` (everything below) | **Supabase user JWT** — `Authorization: Bearer <access_token>`, validated via `auth.getUser` (`requireAuth` in `src/lib/auth.ts`). 401 without a valid token; 503 if the server lacks `SUPABASE_URL`/`SUPABASE_ANON_KEY`. Plus: **CORS** locked to `DASHBOARD_ORIGIN` (fail-closed) and a **rate limit** of 120 requests/min per client IP. The dashboard forwards the JWT automatically (`web/lib/api.ts`). |

## HTTP endpoints

### Core

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Dependency-free liveness (Railway health check) → `{ ok: true }`. |
| `GET` | `/ready` | Readiness: verifies Supabase is reachable **and** the `outbound` schema is exposed (`checks.outboundSchema`). 503 when not. |
| `POST` | `/vapi/webhook` | All Vapi server messages (tool-calls, status, transcript, end-of-call) for **both** agents. Routed outbound vs. inbound via `isOutboundCall(message)`. Handler errors return 200 `{ok:false}` so Vapi doesn't retry-storm. |

### Campaigns & dialing (`src/outbound/routes.ts`)

| Method | Path | Request | Purpose |
|--------|------|---------|---------|
| `GET` | `/outbound/campaigns` | — | List all campaigns (newest first). |
| `GET` | `/outbound/stats` | `?campaignId=` | Disposition breakdown + total, scoped to a campaign when given. |
| `POST` | `/outbound/campaign/start` | `{ campaignId?, maxCalls?, maxConcurrent? }` | Mark the campaign `running`, reset `run_started_at` (each Start is a fresh batch), optionally set the per-run call budget + concurrency, auto-assign its brand, and start the worker. Omit `campaignId` to start all non-`done` (no budget). |
| `POST` | `/outbound/campaign/pause` | `{ campaignId? }` | Pause one (or all) campaigns; the worker stops only when none remain running **and no calls are still live** (it keeps ticking so the stale sweeper can close in-flight calls). |
| `GET` | `/outbound/campaign/:id/window-status` | — | Pre-start preview: the campaign's eligible leads grouped by **their own timezone** — how many are dialable right now vs. when each group's calling window opens. Backs the Start-confirmation popup. |
| `POST` | `/outbound/campaign/:id/update` | `{ name?, region?, brand?, maxConcurrent?, maxCalls? }` | Rename / re-region / set brand (also sets campaign `timezone` from the brand) / tune concurrency + per-run budget. |
| `POST` | `/outbound/campaign/:id/delete` | — | Delete a campaign **and all its leads** (calls/events cascade). |
| `GET` | `/outbound/brand-list` | — | Registry brands for the campaign dropdown (`slug`, `displayName`, `serviceArea`). |
| `GET` | `/outbound/brands` | `?campaignId=` | Distinct `servicing_brand` values in the leads (for the export brand filter). |
| `POST` | `/outbound/call-now/:leadId` | — | Manually dial one lead now (bypasses the calling window; still honors DNC + the per-lead and per-number in-flight guards). |
| `POST` | `/outbound/calls/:id/end` | — | End an in-flight call from the dashboard (per-call Vapi control URL; marks `ended_by='operator'`). If the control URL times out/rejects (call usually already over), the row is still marked ended so the monitor clears; a late end-of-call webhook reconciles the real outcome. |
| `POST` | `/outbound/test-call` | `{ phone, name?, buildingName?, address?, city?, problemType?, violationCodes?, brand? }` | Dial an **arbitrary** number to test the agent — no lead row. Optional `brand` slug routes to that brand's assistant + caller ID. DNC-checked. |

### Leads: import & export

| Method | Path | Request | Purpose |
|--------|------|---------|---------|
| `POST` | `/outbound/import/preview` | multipart `file` | List a workbook's sheets + row counts; suggests the campaign-ready sheet. 413 over 15 MB. |
| `POST` | `/outbound/import` | multipart `file`, `sheet`, `region?`, `campaign?` | Import leads from an uploaded workbook (same pipeline as the CLI; auto-assigns the campaign brand). 413 over 15 MB. |
| `GET` | `/outbound/export` | `?disposition=&campaignId=&brand=&format=csv\|xlsx` | Download leads in a fixed sales-ready column layout (building/contact/violation context + qualification + disposition). `disposition` and `brand` accept comma-separated lists; omit for all. |

### Analytics, costs & data lifecycle

| Method | Path | Request | Purpose |
|--------|------|---------|---------|
| `GET` | `/outbound/analytics` | `?campaignId=&days=` (default 30, max 180) | Pre-aggregated views: `v_campaign_funnel`, `v_call_quality` (incl. costs + who-ended + per-brand health), `v_daily_metrics`, `v_attempt_distribution`, plus the unresolved `failed_op` count. |
| `GET` | `/outbound/analytics/compliance` | `?campaignId=&limit=` (default 100, max 500) | Per-call audit rows from `v_compliance_audit` + `{ summary: { total, disclosed, consented } }`. |
| `POST` | `/outbound/twilio/sync` | `?campaignId=` | Pull authoritative cost / carrier status / answered-by from Twilio onto recent call rows (keyed by the Twilio Call SID). Also runs automatically every ~5 min while the worker ticks. |
| `POST` | `/outbound/failed-ops/replay` | — | Re-apply dead-lettered writes from `outbound.failed_op`. |
| `POST` | `/outbound/retention/purge` | `{ days? }` (default `PII_RETAIN_DAYS`) | Null out transcripts/recordings/raw payloads older than N days; keeps structural rows + metrics. |
| `POST` | `/outbound/dsar/delete` | `{ phone }` | Right-to-erasure: delete all lead/call data for a phone, keeping only the DNC entry. |

### AI insights (self-learning)

| Method | Path | Request | Purpose |
|--------|------|---------|---------|
| `POST` | `/outbound/campaign/:id/analyze` | — | Analyze the campaign's recent transcripts now → writes a `campaign_insight` (report + proposed prompt). Needs `ANTHROPIC_API_KEY` + ≥3 transcripts. Also runs automatically every `INSIGHT_EVERY_N_CALLS` ended calls. |
| `GET` | `/outbound/campaign/:id/insights` | `?limit=` (default 20, max 50) | List that campaign's insight rows. |
| `POST` | `/outbound/insights/:id/approve` | `{ approvedBy? }` | Apply the proposed prompt: PATCH the live Vapi assistant + persist a `brand_prompt:<slug>` override. **400 if the compliance guardrail blocked it.** |
| `POST` | `/outbound/insights/:id/reject` | — | Mark the proposal rejected (no live change). |

### Voices & POC

| Method | Path | Request | Purpose |
|--------|------|---------|---------|
| `GET` | `/outbound/voices` | — | ElevenLabs voices + each agent's current voice `{ vapi, elevenlabs }`. Needs `ELEVENLABS_API_KEY`. |
| `POST` | `/outbound/voice` | `{ voiceId, target: "vapi"\|"elevenlabs" }` | Set + apply a voice to one agent (independent per target). |
| `GET` | `/outbound/el-agent/signed-url` | — | Signed URL for the in-browser ElevenLabs Convai POC session (key stays server-side). |

**`DialResult`** (returned by `call-now` and `test-call`): `{ ok: boolean, reason?: string, vapiCallId?: string, callRowId?: string }` — HTTP 200 when `ok`, else 400.

---

## Assistant tools

When the model calls a tool, Vapi POSTs a `tool-calls` message to `/vapi/webhook`; the matching handler runs and returns a short result string. Handlers carry an anti-loop guard (a repeated identical tool call gets a firm redirect instead of re-running) and log every call to `outbound.call_event`.

### Inbound (`src/assistant/tools.ts` → `src/vapi/handlers.ts`)

**`lookupContact`** — look up an existing customer.
```jsonc
{ "phone": "string (optional; defaults to caller)", "email": "string (optional)" }
// required: none
```

**`bookSurvey`** — create the lead + book a site survey.
```jsonc
{
  "fullName": "string", "phone": "string", "email": "string?",
  "buildingName": "string?", "buildingAddress": "string",
  "numberOfElevators": "number?", "issueSummary": "string?", "preferredTime": "string?"
}
// required: fullName, phone, buildingAddress
```

**`transferCall`** — built-in; warm-transfer to `TRANSFER_PHONE_NUMBER` (only wired when set).

### Outbound (`src/assistant/outbound/tools.ts` → `src/outbound/handlers.ts`)

**`confirmConsent`** — record the recorded-line consent moment, **before any qualifying**. Only an explicit "yes" passes `granted: true`; a decline is recorded too (the agent then wraps up or offers an unrecorded human follow-up). Stamps `consent_captured`/`consent_at` and writes the CIPA audit event.
```jsonc
{ "granted": "boolean" }   // required: granted — true ONLY on an explicit yes
```

**`qualifyLead`** — save structured qualification (writes the sales-ready columns). **Does not record consent** — that's `confirmConsent`'s job, and the prompt gates qualifying on consent having been granted.
```jsonc
{
  "interested": "boolean",            // required
  "decisionMaker": "boolean?",
  "currentProvider": "string?",
  "bestCallbackName": "string?", "bestCallbackPhone": "string?", "bestCallbackEmail": "string?",
  "timeline": "string?", "notes": "string?"
}
```

**`recordDisposition`** — set the final outcome (call once before the call ends).
```jsonc
{ "disposition": "qualified | needs_followup | not_interested | remove", "notes": "string?" }
// required: disposition   (sets qualified_at when "qualified")
```

**`lookupViolationCode`** — verified lookup of a compliance topic (e.g. "overdue inspection") or specific code. Reads only `outbound.code_reference`; never guesses — returns "not found → team will confirm" if absent.
```jsonc
{ "code": "string" }   // required
```

**`optOut`** — do-not-call. Adds the number to `outbound.dnc_suppression` and marks the lead `dnc`.
```jsonc
{ "reason": "string?" }   // required: none
```

**`transferCall`** / **`endCall`** — built-ins; transfer to the brand's own line (`localPhone`, falling back to `TRANSFER_PHONE_NUMBER`) / hang up cleanly.
