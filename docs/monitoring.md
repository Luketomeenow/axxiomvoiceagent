# Monitoring: System logs + health checks

The dashboard's **System logs** tab shows what the server did and what went wrong, without
anyone needing Azure access: health checks at the top, the server's own log underneath, and
a red banner on every tab when something is actually broken.

## Health checks

`src/outbound/health.ts` runs these on demand (`GET /outbound/system/health`, cached ~20 s)
and in the background every 5 minutes. The background monitor writes a log line whenever a
check changes state (bad → logged as warning/error, recovered → info), so problems are
recorded even when nobody has the dashboard open.

| Check | Problem when | Fix |
|---|---|---|
| **Vapi → this server** | Any assistant this service manages (inbound, generic outbound, one per brand) or any phone number with a `/vapi/webhook` URL points at another host. Calls still connect, but this server never hears how they ended: they sit on "ringing" and their results (dispositions, transcripts) go to the other host. | Agent studio → **Re-sync Vapi assistants**. |
| **Call results arriving** | A call placed 3–15 minutes ago is still `queued`/`ringing` (Vapi reports "in-progress" on answer and sends an end-of-call when it gives up, so this means webhooks aren't arriving). Warns when calls in the last 24 h were closed as `stale-timeout`. Shows when the last Vapi webhook arrived. | Usually the routing above. Stuck calls close on their own after 15 minutes. |
| **Database** | The outbound schema can't be read. | `/ready`; the identity's grants. |
| **Dialer** | `DIALER_ENABLED=false` (warning). Shows running campaigns. | Flip it at cutover only. |
| **Errors** | Any error logged in the last hour (warning). | Filter the log to Errors. |
| **Database writes** | Writes dead-lettered to `outbound.failed_op` in the last 7 days (older unresolved ones are only counted). | `POST /outbound/failed-ops/replay`. |
| **System log storage** | `outbound.app_log` missing or writes failing. | Re-run `voice_schema.sql` in Cloud Shell. |
| **AI analysis (Foundry)** | No Foundry key, or `ANTHROPIC_BASE_URL` unset (would call api.anthropic.com). | `sync-app-settings.sh --apply`. |
| **Voice agents' model** | Error: `VOICE_PROVIDER=foundry` with no key. Warning: still on Anthropic via Vapi, not Foundry. | `VOICE_PROVIDER=foundry`, then re-sync. |
| **Twilio cost sync** | Twilio credentials missing (no carrier cost / answered-by). | Add them to the vault + settings. |

Only **error**-level checks raise the red banner and the dot on the System logs tab; warnings
show in the tab only.

## The log

Every `log.*` line (`src/lib/logger.ts`) is printed to stdout as JSON **and** handed to the log
store (`src/lib/logStore.ts`), which:

- keeps the last 1,000 lines in memory and streams each one to open dashboards (`log` events on
  `GET /outbound/events`), which is the **Live** tail;
- batches lines at or above `LOG_PERSIST_LEVEL` (default `info`) into **`outbound.app_log`**
  every 2 seconds, and deletes rows older than `LOG_RETAIN_DAYS` (default 30);
- masks phone numbers (`+14155557000` → `***7000`) and secret-ish fields before storing, and caps
  a line that repeats (same level, source, message and call) at 10 per 10 minutes, with the next
  kept line noting how many were dropped (e.g. a lead skipped on every 15-second dialer tick).

What gets logged, by **source** (the filter in the tab):

| Source | Lines |
|---|---|
| `outbound-call` | Each call's status changes, how it ended (`twilio-failed-…`, `pipeline-error-…` and other failures as **errors**), tool calls, and webhooks for calls this server has no record of. |
| `inbound-call` | Inbound tool calls and endings (same error classification). |
| `dialer` | Calls placed, leads skipped and why, systemic dial errors (auto-pause), stale sweeps, budget auto-pauses, worker start/stop. |
| `webhook` | Rejected webhooks (bad secret), handler crashes. |
| `http` | Any 5xx response (with its error body) and any route that threw. |
| `server` | Boot (version, instance, config summary), shutdown, crashes (the uncaught-exception line is saved before the process exits). |
| `monitor` | Health checks changing state. |
| others | `api`, `assistant-sync`, `llm-relay`, `ai`, `database`, `auth`, `twilio`, `billing`, `voice`, `ghl`, `settings`. |

**Find everything for one call:** click the `call …` button on any line, or paste a call, lead,
campaign or Vapi call id into the search box. Lines carry these ids when the code logs them as
`callRowId` (ours), `callId` (Vapi's), `leadId` and `campaignId`.

If `outbound.app_log` doesn't exist yet, the tab says so and shows this server's memory only
(lost on restart). It starts saving within ~2 minutes of the table being created.

## Outside the dashboard

- **App Service log stream**: `az webapp log tail -g Axxiom-devs-foundry -n app-axxiom-voice-agents`
  (or `az webapp log download`). `sync-app-settings.sh --apply` turns on container logging to the
  file system, so the app's stdout (including output before the database is reachable) is kept.
- **Application Insights** (`appinsights`) records this app's HTTP requests only, not its log lines.
- **Vapi dashboard**: each call's own record (status, ended reason, transcript, cost), which is
  useful when the routing check is red and the results never reached this server.
