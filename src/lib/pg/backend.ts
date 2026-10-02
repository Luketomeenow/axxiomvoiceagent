/**
 * Azure Database for PostgreSQL connection (DATA_BACKEND=azure). Same mechanism
 * as axxiommarketinghub (src/lib/pg/backend.ts): no password and no connection
 * string — the pool presents a Microsoft Entra access token AS the Postgres
 * password. In App Service the token comes from the user-assigned managed
 * identity (AZURE_PG_CLIENT_ID); on a laptop / in Cloud Shell the same
 * DefaultAzureCredential chain falls through to `az login`, so AZURE_PG_USER is
 * then your own Entra email and you get exactly that account's grants.
 *
 * The token is fetched lazily per NEW pool connection and cached until 5 minutes
 * before expiry. Postgres only checks it at connect time, so a long-lived pool
 * never dies to token expiry — the next new connection just gets a fresh token.
 *
 * AZURE_PG_PASSWORD (+ AZURE_PG_SSL=disable) is the escape hatch for a LOCAL
 * Postgres (dev, tests). Production never sets it.
 */

import { Pool } from "pg";
import type { TokenCredential } from "@azure/identity";

import { env } from "../../config/env.ts";
import { log } from "../logger.ts";
import { postgrestTypeParser } from "./shim.ts";

const OSSRDBMS_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

let credential: TokenCredential | undefined;
let cachedToken: { token: string; expiresOnTimestamp: number } | null = null;

async function entraToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 5 * 60_000) {
    return cachedToken.token;
  }
  if (!credential) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    credential = new DefaultAzureCredential({ managedIdentityClientId: env.azurePgClientId || undefined });
  }
  const token = await credential.getToken(OSSRDBMS_SCOPE);
  if (!token) throw new Error("no Entra token for Postgres (managed identity not attached, or az login expired)");
  cachedToken = { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  return token.token;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: env.azurePgHost,
      port: env.azurePgPort,
      database: env.azurePgDatabase,
      user: env.azurePgUser,
      password: env.azurePgPassword || (() => entraToken()),
      // Azure always uses TLS; "disable" is only for a local Postgres.
      ssl: env.azurePgSsl === "disable" ? false : { rejectUnauthorized: true },
      max: env.azurePgPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      // timestamptz text output must be UTC for PostgREST parity ("+00:00").
      options: "-c TimeZone=UTC",
      types: { getTypeParser: postgrestTypeParser as never },
    });
    pool.on("error", (err) => log.error("azure-pg idle client error", { err: err.message }));
  }
  return pool;
}

/** Who the pool actually connects as — the identity → token → Postgres proof. */
export async function pgWhoAmI(): Promise<{ user: string; database: string; version: string }> {
  const { rows } = await getPool().query(
    "select current_user as user, current_database() as database, current_setting('server_version') as version",
  );
  return rows[0] as { user: string; database: string; version: string };
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.end().catch(() => {});
}
