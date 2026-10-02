import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";

import { createPgRestClient, executorFromPool, postgrestTypeParser, type PgRestClient } from "./shim.ts";

/**
 * Contract tests for the pg shim against a throwaway local Postgres cluster
 * (TCP on 127.0.0.1, random port). Requires the PostgreSQL server binaries —
 * on the dev Macs: `brew install postgresql@18` (same major as Azure).
 *
 *   bun test
 */
const PG_BIN = ["/opt/homebrew/opt/postgresql@18/bin", "/usr/local/opt/postgresql@18/bin", ""].find((dir) => {
  try {
    execFileSync(dir ? join(dir, "initdb") : "initdb", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
const bin = (name: string) => (PG_BIN ? join(PG_BIN, name) : name);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

let dataDir: string;
let port: number;
let pool: Pool;
let db: PgRestClient;
let out: PgRestClient;

beforeAll(async () => {
  if (PG_BIN === undefined) throw new Error("postgres server binaries not found — brew install postgresql@18");
  dataDir = mkdtempSync(join(tmpdir(), "voice-shimtest-"));
  port = await freePort();
  execFileSync(bin("initdb"), ["-D", dataDir, "-A", "trust", "-U", "postgres", "--no-sync"], { stdio: "ignore" });
  execFileSync(
    bin("pg_ctl"),
    [
      "-D",
      dataDir,
      "-o",
      `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=''`,
      "-w",
      "start",
      "-l",
      join(dataDir, "log"),
    ],
    { stdio: "ignore" },
  );
  pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    max: 3,
    options: "-c TimeZone=UTC",
    types: { getTypeParser: postgrestTypeParser as never },
  });
  db = createPgRestClient(executorFromPool(pool));
  out = createPgRestClient(executorFromPool(pool), "outbound");

  await pool.query(`
    create table things (
      id bigserial primary key,
      name text not null,
      brand text,
      score numeric,
      big bigint,
      day date,
      at timestamptz,
      meta jsonb,
      status text not null default 'new',
      labels text[]
    );
    create table pairs (a text not null, b text not null, val int, note text, primary key (a, b));
    create schema outbound;
    create table outbound.call_event (
      id bigint generated always as identity primary key,
      call_id text,
      type text not null,
      text text,
      payload jsonb,
      at timestamptz not null default now()
    );
    create table outbound.lead (
      id serial primary key,
      device_id text,
      contact_phone text,
      disposition text not null default 'new',
      next_attempt_after timestamptz,
      notes text,
      unique (device_id, contact_phone)
    );
    create function outbound.add_range(p_a int, p_b int default 10) returns table(total int)
      language sql as 'select p_a + p_b';
  `);
  await pool.query(`
    insert into things (name, brand, score, big, day, at, meta, status) values
      ('alpha',   'ax',  1.5,   9007199254740, '2026-08-01', '2026-08-01T10:00:00Z', '{"k":1}', 'open'),
      ('beta',    'ax',  22.25, 42,            '2026-08-02', '2026-08-02T10:00:00Z', null,      'fixed'),
      ('gamma',   'mo',  null,  7,             '2026-08-03', '2026-08-03T10:00:00Z', null,      'ignored'),
      ('delta',   null,  3,     1,             '2026-08-04', '2026-08-04T10:00:00Z', null,      'generating'),
      ('epsilon', 'ax',  10,    2,             '2026-08-05', '2026-08-05T10:00:00Z', null,      'open');
  `);
});

afterAll(async () => {
  await pool?.end();
  if (dataDir) {
    try {
      execFileSync(bin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    } catch {
      /* already stopped */
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("select", () => {
  test("filters, order, limit", async () => {
    const { data, error } = await db
      .from("things")
      .select("name, score")
      .eq("brand", "ax")
      .gte("score", 2)
      .order("score", { ascending: false })
      .limit(2);
    expect(error).toBeNull();
    expect(data).toEqual([
      { name: "beta", score: 22.25 },
      { name: "epsilon", score: 10 },
    ]);
  });

  test("type normalization matches PostgREST JSON", async () => {
    const { data } = await db.from("things").select("*").eq("name", "alpha").single();
    const row = data as Record<string, unknown>;
    expect(row.big).toBe(9007199254740);
    expect(row.score).toBe(1.5);
    expect(row.day).toBe("2026-08-01");
    expect(row.at).toBe("2026-08-01T10:00:00+00:00");
    expect(row.meta).toEqual({ k: 1 });
  });

  test("in / is / not / like / ilike / neq / lt / lte / gt", async () => {
    const names = async (q: PromiseLike<{ data: unknown }>) =>
      ((await q).data as { name: string }[]).map((r) => r.name).sort();
    expect(await names(db.from("things").select("name").in("status", ["open", "fixed"]))).toEqual([
      "alpha",
      "beta",
      "epsilon",
    ]);
    expect(await names(db.from("things").select("name").is("brand", null))).toEqual(["delta"]);
    expect(await names(db.from("things").select("name").not("score", "is", null).lt("score", 3))).toEqual(["alpha"]);
    expect(await names(db.from("things").select("name").not("status", "in", "(open,fixed)"))).toEqual([
      "delta",
      "gamma",
    ]);
    expect(await names(db.from("things").select("name").like("name", "%ta"))).toEqual(["beta", "delta"]);
    expect(await names(db.from("things").select("name").ilike("name", "ALP%"))).toEqual(["alpha"]);
    expect(await names(db.from("things").select("name").neq("brand", "ax"))).toEqual(["gamma"]);
    expect(await names(db.from("things").select("name").lte("big", 2).gt("big", 1))).toEqual(["epsilon"]);
  });

  test("or(): is.null + ISO timestamp values (dots inside the value) + in.()", async () => {
    const { data, error } = await db
      .from("things")
      .select("name")
      .or("brand.is.null,at.lte.2026-08-01T10:00:00.000Z")
      .order("name");
    expect(error).toBeNull();
    expect((data as { name: string }[]).map((r) => r.name)).toEqual(["alpha", "delta"]);
    const inOr = await db.from("things").select("name").or("status.in.(fixed,ignored),name.eq.alpha").order("name");
    expect((inOr.data as { name: string }[]).map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("range is inclusive; nullsFirst ordering", async () => {
    const { data } = await db.from("things").select("name").order("id").range(1, 2);
    expect((data as { name: string }[]).map((r) => r.name)).toEqual(["beta", "gamma"]);
    const nulls = await db.from("things").select("name").order("score", { ascending: false, nullsFirst: false });
    expect((nulls.data as { name: string }[]).at(-1)?.name).toBe("gamma");
  });

  test("single / maybeSingle / returns()", async () => {
    expect((await db.from("things").select("id").eq("name", "nope").maybeSingle()).data).toBeNull();
    expect((await db.from("things").select("id").eq("name", "nope").maybeSingle()).error).toBeNull();
    expect((await db.from("things").select("id").eq("brand", "ax").maybeSingle()).error).not.toBeNull();
    expect((await db.from("things").select("id").eq("name", "nope").single()).error).not.toBeNull();
    const typed = await db.from("things").select("name").eq("name", "beta").returns().single();
    expect(typed.data).toEqual({ name: "beta" });
  });

  test("count exact — head and non-head", async () => {
    const head = await db.from("things").select("id", { count: "exact", head: true }).eq("brand", "ax");
    expect(head).toEqual({ data: null, error: null, count: 3 });
    const page = await db.from("things").select("name", { count: "exact" }).eq("brand", "ax").order("id").limit(1);
    expect(page.count).toBe(3);
    expect(page.data).toEqual([{ name: "alpha" }]);
  });

  test("never throws: bad column / bad uuid / embedded select come back as { error }", async () => {
    const bad = await db.from("things").select("nope");
    expect(bad.data).toBeNull();
    expect(bad.error?.message).toContain("nope");
    const embed = await db.from("things").select("*, lead:lead_id(name)");
    expect(embed.error?.message).toContain("Embedded selects");
  });
});

describe("writes", () => {
  test("insert without select → data null; with select → RETURNING", async () => {
    const plain = await db.from("things").insert({ name: "zeta", brand: "zz" });
    expect(plain).toEqual({ data: null, error: null, count: null });
    const ret = await db.from("things").insert({ name: "eta" }).select("id, status").single();
    expect(ret.error).toBeNull();
    expect((ret.data as { status: string }).status).toBe("new"); // default applied
    expect(typeof (ret.data as { id: number }).id).toBe("number");
  });

  test("undefined means 'not provided': update leaves the column, insert uses the default", async () => {
    await db.from("things").insert({ name: "theta", brand: "keep", status: undefined });
    const inserted = await db.from("things").select("brand, status").eq("name", "theta").single();
    expect(inserted.data).toEqual({ brand: "keep", status: "new" });

    const upd = await db.from("things").update({ status: "done", brand: undefined }).eq("name", "theta");
    expect(upd.error).toBeNull();
    const after = await db.from("things").select("brand, status").eq("name", "theta").single();
    expect(after.data).toEqual({ brand: "keep", status: "done" });

    // An all-undefined patch is a no-op, not an error.
    expect((await db.from("things").update({ brand: undefined }).eq("name", "theta")).error).toBeNull();
    // Explicit null still clears.
    await db.from("things").update({ brand: null }).eq("name", "theta");
    expect((await db.from("things").select("brand").eq("name", "theta").single()).data).toEqual({ brand: null });
  });

  test("json columns: objects, arrays AND plain strings are stored as JSON", async () => {
    await db.from("things").insert([
      { name: "j1", meta: { nested: { ok: true } } },
      { name: "j2", meta: "just text" },
      { name: "j3", meta: [1, 2] },
    ]);
    const { data } = await db.from("things").select("name, meta").in("name", ["j1", "j2", "j3"]).order("name");
    expect(data).toEqual([
      { name: "j1", meta: { nested: { ok: true } } },
      { name: "j2", meta: "just text" },
      { name: "j3", meta: [1, 2] },
    ]);
  });

  test("array columns take JS arrays", async () => {
    await db.from("things").insert({ name: "arr", labels: ["a", "b"] });
    expect((await db.from("things").select("labels").eq("name", "arr").single()).data).toEqual({ labels: ["a", "b"] });
  });

  test("update / delete with select → RETURNING; count exact", async () => {
    const upd = await db.from("things").update({ status: "closed" }).eq("brand", "zz").select("name");
    expect(upd.data).toEqual([{ name: "zeta" }]);
    const del = await db.from("things").delete({ count: "exact" }).eq("name", "zeta");
    expect(del.count).toBe(1);
  });

  test("upsert: multi-column onConflict, PK fallback, ignoreDuplicates", async () => {
    await out.from("lead").upsert(
      [
        { device_id: "D1", contact_phone: "+1555", notes: "first" },
        { device_id: "D2", contact_phone: "+1666", notes: "first" },
      ],
      { onConflict: "device_id,contact_phone" },
    );
    await out
      .from("lead")
      .upsert({ device_id: "D1", contact_phone: "+1555", notes: "second" }, { onConflict: "device_id,contact_phone" });
    const d1 = await out.from("lead").select("notes, disposition").eq("device_id", "D1").single();
    expect(d1.data).toEqual({ notes: "second", disposition: "new" });

    await db.from("pairs").upsert({ a: "x", b: "y", val: 1 });
    await db.from("pairs").upsert({ a: "x", b: "y", val: 2 });
    expect((await db.from("pairs").select("val").eq("a", "x").single()).data).toEqual({ val: 2 });

    await db.from("pairs").upsert({ a: "x", b: "y", val: 99 }, { ignoreDuplicates: true });
    expect((await db.from("pairs").select("val").eq("a", "x").single()).data).toEqual({ val: 2 });
  });

  test("default schema + identity column + or() with ISO timestamp on writes", async () => {
    const ev = await out.from("call_event").insert({ call_id: "c1", type: "transcript", text: "hello" }).select("id").single();
    expect(ev.error).toBeNull();
    expect(typeof (ev.data as { id: number }).id).toBe("number");

    await out.from("lead").update({ next_attempt_after: "2026-09-01T00:00:00.000Z" }).eq("device_id", "D2");
    const due = await out
      .from("lead")
      .select("device_id")
      .or(`next_attempt_after.is.null,next_attempt_after.lte.${new Date("2026-09-02T00:00:00Z").toISOString()}`)
      .order("device_id");
    expect(due.data).toEqual([{ device_id: "D1" }, { device_id: "D2" }]);
  });

  test("rpc resolves in the client's default schema; undefined args use the function default", async () => {
    expect((await out.rpc("add_range", { p_a: 5, p_b: undefined })).data).toEqual([{ total: 15 }]);
  });
});

describe("dataClient (azure) — change events", () => {
  test("publishes one event per successful write, none for failures or reads", async () => {
    // Set the config object itself, not process.env: another test file may have
    // loaded env.ts already (bun shares one module registry across files).
    const { env } = await import("../../config/env.ts");
    Object.assign(env, {
      dataBackend: "azure",
      azurePgHost: "127.0.0.1",
      azurePgPort: port,
      azurePgDatabase: "postgres",
      azurePgUser: "postgres",
      azurePgPassword: "unused",
      azurePgSsl: "disable",
    });
    const { dataClient } = await import("../dataClient.ts");
    const { onChange } = await import("../changes.ts");
    const seen: { table: string; op: string; rows?: unknown[]; patch?: unknown }[] = [];
    const off = onChange((e) => seen.push({ table: e.table, op: e.op, rows: e.rows, patch: e.patch }));

    const client = dataClient("outbound");
    await client.from("call_event").insert({ call_id: "c2", type: "transcript", text: "hi" });
    await client.from("lead").update({ disposition: "queued" }).eq("device_id", "D1");
    await client.from("lead").select("*");
    const failed = await client.from("call_event").insert({ nope: 1 });
    off();

    expect(failed.error).not.toBeNull();
    expect(seen).toEqual([
      { table: "call_event", op: "INSERT", rows: [{ call_id: "c2", type: "transcript", text: "hi" }], patch: undefined },
      { table: "lead", op: "UPDATE", rows: undefined, patch: { disposition: "queued" } },
    ]);
    const { closePool } = await import("./backend.ts");
    await closePool();
  });
});
