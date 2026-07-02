/**
 * Import existing Twilio phone numbers into Vapi so the dialer can call FROM
 * them (per-brand local caller ID) WITHOUT the daily outbound cap that Vapi's
 * own free/bought numbers carry — the exact limit `isSystemicDialError` in
 * src/outbound/dialer.ts currently trips on.
 *
 * Vapi stores your Twilio credentials and places the calls over your Twilio
 * DIDs; you get back a Vapi phoneNumberId (UUID) to drop into
 * src/assistant/brands.ts (`vapiPhoneNumberId`) or the VAPI_PHONE_NUMBER_ID env
 * default. The dialer already routes each brand's calls to its own number, so
 * once the ids are pasted in there is nothing else to change.
 *
 *   # one number, tagged to a brand slug (see brands.ts for slugs)
 *   bun run import-twilio-numbers --brand quality --number +13017999116
 *
 *   # batch: a CSV of `brand,number[,name]` — one per line; header + `#` ok
 *   bun run import-twilio-numbers data/twilio-numbers.csv
 *
 *   # just show what's already registered in Vapi (id → number)
 *   bun run import-twilio-numbers --list
 *
 *   # also attach your webhook (SERVER_URL) so the DID can take INBOUND calls
 *   # (not needed for outbound — the per-call assistant carries its own server)
 *   bun run import-twilio-numbers data/twilio-numbers.csv --server
 *
 * Env: VAPI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (+ optional
 * SERVER_URL / VAPI_SERVER_SECRET for --server). Node fallback:
 * `npm run import-twilio-numbers:node`. Re-running is safe: a number already in
 * Vapi is matched by E.164 and reported instead of being imported twice.
 */

import { readFileSync } from "node:fs";

import { assertTwilio, env } from "../src/config/env.ts";
import { getBrand } from "../src/assistant/brands.ts";
import { toE164 } from "../src/outbound/phone.ts";

const VAPI_API = "https://api.vapi.ai";

async function vapi(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(VAPI_API + path, {
    method,
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Vapi ${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 600)}`);
  return json;
}

interface VapiNumber {
  id: string;
  number?: string;
  provider?: string;
  name?: string;
  status?: string;
}

async function listNumbers(): Promise<VapiNumber[]> {
  const json = await vapi("/phone-number?limit=1000", "GET");
  return Array.isArray(json) ? (json as VapiNumber[]) : [];
}

interface Target {
  brand?: string;
  number: string;
  name?: string;
}

/** Parse a `brand,number[,name]` CSV. The column holding a 7+ digit run is the
 *  number; the column before it (if any) is the brand slug, the one after is a
 *  label. Header rows and `#` comments (lines with no phone number) are skipped. */
function parseFile(path: string): Target[] {
  const rows: Target[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/\d{7,}/.test(line.replace(/\D/g, ""))) continue; // header / non-data line
    const cols = line.split(",").map((c) => c.trim()).filter(Boolean);
    const numIdx = cols.findIndex((c) => /\d{7,}/.test(c.replace(/\D/g, "")));
    if (numIdx < 0) continue;
    rows.push({
      brand: numIdx > 0 ? cols[numIdx - 1] : undefined,
      number: cols[numIdx],
      name: cols[numIdx + 1],
    });
  }
  return rows;
}

function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(t);
    }
  }
  return { flags, positional };
}

const USAGE = `Import Twilio DIDs into Vapi → get phoneNumberId(s) for brands.ts.

  bun run import-twilio-numbers --brand quality --number +13017999116
  bun run import-twilio-numbers data/twilio-numbers.csv        # brand,number[,name]
  bun run import-twilio-numbers --list                         # show existing
  bun run import-twilio-numbers <csv|--number …> --server      # also wire inbound webhook

Env: VAPI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.`;

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(USAGE);
    return;
  }

  assertTwilio();

  const existing = await listNumbers();
  const byE164 = new Map(existing.filter((n) => n.number).map((n) => [n.number as string, n]));

  if (flags.list) {
    console.log(`\n${existing.length} phone number(s) in Vapi:\n`);
    for (const n of existing) {
      console.log(
        `  ${n.id}  ${n.number ?? "(no number)"}  [${n.provider ?? "?"}]` +
          `  ${n.name ?? ""}${n.status ? `  (${n.status})` : ""}`,
      );
    }
    console.log();
    return;
  }

  // Targets come from a CSV file (preferred) or a single --number.
  let targets: Target[] = [];
  if (positional[0]) {
    targets = parseFile(positional[0]);
  } else if (typeof flags.number === "string") {
    targets = [
      {
        brand: typeof flags.brand === "string" ? flags.brand : undefined,
        number: flags.number,
        name: typeof flags.name === "string" ? flags.name : undefined,
      },
    ];
  }
  if (!targets.length) {
    console.error(`Nothing to import.\n\n${USAGE}`);
    process.exit(1);
  }

  const attachServer = !!flags.server;
  if (attachServer && !env.serverUrl) {
    console.error("--server needs SERVER_URL set (the public webhook base, e.g. https://…railway.app).");
    process.exit(1);
  }

  const results: { brand?: string; number: string; id: string }[] = [];
  for (const t of targets) {
    const e164 = toE164(t.number) ?? t.number.trim();
    const brand = t.brand ? getBrand(t.brand) : undefined;
    if (t.brand && !brand) {
      console.warn(`   ⚠️  unknown brand "${t.brand}" — importing anyway; wire the id in manually.`);
    }
    const label = t.name || (brand ? `${brand.displayName} (${brand.slug})` : e164);

    // Idempotent: Vapi rejects a duplicate import, so report the existing id.
    const hit = byE164.get(e164);
    if (hit) {
      console.log(`↩︎  ${e164} already in Vapi → ${hit.id}${t.brand ? `  [${t.brand}]` : ""}`);
      results.push({ brand: t.brand, number: e164, id: hit.id });
      continue;
    }

    const body: Record<string, unknown> = {
      provider: "twilio",
      number: e164,
      twilioAccountSid: env.twilioAccountSid,
      twilioAuthToken: env.twilioAuthToken,
      name: label,
    };
    if (attachServer) {
      body.server = {
        url: `${env.serverUrl.replace(/\/$/, "")}/vapi/webhook`,
        ...(env.vapiServerSecret ? { secret: env.vapiServerSecret } : {}),
      };
    }

    try {
      const created = (await vapi("/phone-number", "POST", body)) as VapiNumber;
      console.log(
        `✅  imported ${e164} → ${created.id}${t.brand ? `  [${t.brand}]` : ""}` +
          `${created.status ? `  (${created.status})` : ""}`,
      );
      results.push({ brand: t.brand, number: e164, id: created.id });
    } catch (err) {
      console.error(`❌  ${e164}: ${String(err)}`);
    }
  }

  // Paste-ready wiring.
  const branded = results.filter((r) => r.brand && getBrand(r.brand));
  if (branded.length) {
    console.log(`\n— set these in src/assistant/brands.ts (each brand's vapiPhoneNumberId) —`);
    for (const r of branded) console.log(`  ${r.brand}:  vapiPhoneNumberId: "${r.id}",`);
  }
  if (results[0]) {
    console.log(`\n— or as the env fallback used when a call has no brand —\n  VAPI_PHONE_NUMBER_ID=${results[0].id}`);
  }
  console.log();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
