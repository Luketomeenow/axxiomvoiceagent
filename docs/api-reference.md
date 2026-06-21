# API Reference

Two surfaces: the **HTTP API** (Hono, consumed by Vapi and the dashboard) and the **assistant tools** (functions the LLM calls, dispatched to our webhook).

## HTTP endpoints

### Core

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Railway health check → `{ ok: true }`. |
| `POST` | `/vapi/webhook` | All Vapi server messages (tool-calls, status, transcript, end-of-call) for **both** inbound and outbound. Verifies the `x-vapi-secret` header against `VAPI_SERVER_SECRET`. Routes outbound vs. inbound via call metadata / assistant id. |

### Outbound campaign API (`src/outbound/routes.ts`)

| Method | Path | Request | Purpose |
|--------|------|---------|---------|
| `GET` | `/outbound/campaigns` | — | List all campaigns (feeds the region selector). |
| `GET` | `/outbound/stats` | `?campaignId=` (optional) | Disposition breakdown + total, scoped to a campaign when given. |
| `POST` | `/outbound/campaign/start` | `{ campaignId? }` | Mark campaign(s) `running` and start the worker. Omit `campaignId` to start all non-`done`. |
| `POST` | `/outbound/campaign/pause` | `{ campaignId? }` | Mark campaign(s) `paused` and stop the worker. |
| `POST` | `/outbound/call-now/:leadId` | path `leadId` | Manually dial one existing lead now (ignores the calling window, still honors DNC). |
| `POST` | `/outbound/test-call` | `{ phone, name?, buildingName?, address?, city?, problemType?, violationCodes? }` | Dial an **arbitrary** number to test the agent — no lead row. DNC-checked. |
| `GET` | `/outbound/export` | `?disposition=&campaignId=&format=csv\|xlsx` | Download leads as CSV/XLSX. `disposition` accepts a comma-separated list (e.g. `qualified,needs_followup`); omit for all. |

**`DialResult`** (returned by `call-now` and `test-call`): `{ ok: boolean, reason?: string, vapiCallId?: string, callRowId?: string }` — HTTP 200 when `ok`, else 400.

**Export columns:** `building_name, address, city, state, zip, region, contact_name, contact_title, contact_phone, contact_email, oem_match, problem_type, violation_codes, violation_count, cert_expiry_date, lead_score, lead_tier, disposition, decision_maker, current_provider, timeline, callback_name, callback_phone, callback_email, qualified_at, attempts, notes`.

---

## Assistant tools

When the model calls a tool, Vapi POSTs a `tool-calls` message to `/vapi/webhook`; the matching handler runs and returns a short result string.

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

**`transferCall`** — built-in; warm-transfer to `TRANSFER_PHONE_NUMBER`.

### Outbound (`src/assistant/outbound/tools.ts` → `src/outbound/handlers.ts`)

**`qualifyLead`** — save structured qualification (writes the sales-ready columns).
```jsonc
{
  "interested": "boolean",            // required
  "decisionMaker": "boolean?",
  "currentProvider": "string?",
  "bestCallbackName": "string?", "bestCallbackPhone": "string?", "bestCallbackEmail": "string?",
  "timeline": "string?", "notes": "string?"
}
// required: interested
```

**`recordDisposition`** — set the final outcome (call once before the call ends).
```jsonc
{ "disposition": "qualified | needs_followup | not_interested | remove", "notes": "string?" }
// required: disposition   (sets qualified_at when "qualified")
```

**`lookupViolationCode`** — verified code lookup (reads only `outbound.code_reference`).
```jsonc
{ "code": "string" }   // required. Never guesses; returns "not found → team will confirm" if absent.
```

**`optOut`** — do-not-call. Adds the number to `outbound.dnc_suppression` and marks the lead `dnc`.
```jsonc
{ "reason": "string?" }   // required: none
```

**`transferCall`** / **`endCall`** — built-ins; transfer to `TRANSFER_PHONE_NUMBER` (when set) / hang up cleanly.
