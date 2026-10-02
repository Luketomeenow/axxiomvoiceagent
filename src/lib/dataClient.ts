/**
 * The one database client factory. DATA_BACKEND picks the engine:
 *
 *   azure    → Azure Database for PostgreSQL through the PostgREST-compatible
 *              pg shim (src/lib/pg) — managed-identity auth, no secrets;
 *   supabase → the legacy supabase-js service-role client (transition only;
 *              delete this branch once Supabase is decommissioned).
 *
 * Both expose the same query-builder surface and `{ data, error }` results, so
 * call sites neither know nor care which one is active. The SupabaseClient
 * TYPE is kept for both so existing code type-checks unchanged — but on azure
 * only the methods listed at the top of src/lib/pg/shim.ts exist.
 *
 * Every write (insert/upsert/update/delete) is also instrumented to publish a
 * change event once it succeeds (src/lib/changes.ts) — that feeds the
 * dashboard's live stream in place of Supabase Realtime.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assertDatabase, env } from "../config/env.ts";
import { publishChange, type ChangeEvent, type ChangeOp } from "./changes.ts";
import { getPool } from "./pg/backend.ts";
import { createPgRestClient, executorFromPool } from "./pg/shim.ts";

const clients = new Map<string, SupabaseClient>();

/** A client whose `.from(table)` defaults to `schema`. Cached per schema. */
export function dataClient(schema: string): SupabaseClient {
  assertDatabase();
  let client = clients.get(schema);
  if (!client) {
    const raw =
      env.dataBackend === "azure"
        ? (createPgRestClient(executorFromPool(getPool()), schema) as unknown as SupabaseClient)
        : (createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
            db: { schema },
          }) as unknown as SupabaseClient);
    client = instrumentWrites(raw, schema);
    clients.set(schema, client);
  }
  return client;
}

const WRITE_OPS: Record<string, ChangeOp> = {
  insert: "INSERT",
  upsert: "UPSERT",
  update: "UPDATE",
  delete: "DELETE",
};

type Thenable = {
  then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) => unknown;
};

function instrumentWrites(client: SupabaseClient, schema: string): SupabaseClient {
  const from = client.from.bind(client);
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "from") return (table: string) => instrumentTable(from(table), schema, table);
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Wrap a table's write methods so the statement publishes a change event after
 * it resolves without error. Works for both backends because every chained
 * builder method (eq, select, single, …) returns the same builder object, so
 * patching that object's `then` covers whatever the caller chains after it.
 */
function instrumentTable<T extends object>(builder: T, schema: string, table: string): T {
  const qb = builder as Record<string, unknown>;
  for (const [method, op] of Object.entries(WRITE_OPS)) {
    const original = qb[method];
    if (typeof original !== "function") continue;
    qb[method] = (...args: unknown[]) => {
      const filterBuilder = (original as (...a: unknown[]) => Thenable).apply(builder, args);
      const event: ChangeEvent = { schema, table, op };
      if (op === "INSERT" || op === "UPSERT") {
        const value = args[0];
        event.rows = (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
      } else if (op === "UPDATE") {
        event.patch = args[0] as Record<string, unknown>;
      }
      const then = filterBuilder.then.bind(filterBuilder);
      filterBuilder.then = (onfulfilled, onrejected) =>
        then((result) => {
          if (!(result as { error?: unknown } | null)?.error) publishChange(event);
          return onfulfilled ? onfulfilled(result) : result;
        }, onrejected);
      return filterBuilder;
    };
  }
  return builder;
}
