/**
 * PostgREST-compatible shim over node-postgres, for the Supabase → Azure
 * Postgres move. Ported from axxiommarketinghub (src/lib/pg/shim.ts) so both
 * apps speak the same dialect against the same server, and extended for the
 * surface THIS codebase uses (see src/lib/pg/shim.test.ts for the contract):
 *
 *   from() select/insert/upsert/update/delete eq neq gt gte lt lte like ilike
 *   is in not(col,op,val) or(str) order limit range single maybeSingle returns
 *   select-with-{count:"exact"[,head:true]}, write+select => RETURNING,
 *   upsert {onConflict, ignoreDuplicates, count}, rpc(), schema().
 *
 * Contract rules (every call site depends on them):
 *   - every execution resolves to { data, error, count } and NEVER throws;
 *   - error only needs `.message`;
 *   - maybeSingle(): 0 rows => data null, error null; >1 rows => error;
 *   - single(): exactly 1 row or error;
 *   - writes without .select() => data null; with .select(cols) => RETURNING;
 *   - builders are lazy, chainable, and reusable until awaited (thenable);
 *   - `undefined` values mean "not provided", exactly like supabase-js (which
 *     drops them when it JSON-encodes the body): an update never touches the
 *     column, an insert lets the column default apply. (The hub's copy wrote
 *     NULL here — in this codebase that would wipe fields like ended_reason
 *     whenever a webhook omitted them.)
 *
 * Type normalization matches PostgREST JSON output, not node-pg defaults:
 * bigint/numeric => number, date => "YYYY-MM-DD", timestamp(tz) => ISO string.
 */

import { types as pgTypes, type Pool } from "pg";

type PgError = { message: string } | null;
type Envelope = { data: unknown; error: PgError; count: number | null };

export type QueryExecutor = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function parseSelectCols(cols: string): string {
  const trimmed = cols.trim();
  if (trimmed === "*" || trimmed === "") return "*";
  return trimmed
    .split(",")
    .map((c) => {
      const col = c.trim();
      // Embedded resources (`campaign:campaign_id(name)`) are a PostgREST
      // feature with no SQL equivalent here — fail loudly, not with a
      // confusing "column does not exist".
      if (col.includes("(")) throw new Error(`Embedded selects are not supported by the pg shim: ${col}`);
      return quoteIdent(col);
    })
    .join(", ");
}

type Filter =
  | { kind: "cmp"; col: string; op: string; value: unknown }
  | { kind: "in"; col: string; values: unknown[]; negated: boolean }
  | { kind: "isnull"; col: string; negated: boolean }
  | { kind: "or"; raw: string };

type Order = { col: string; ascending: boolean; nullsFirst?: boolean };

const OR_OPS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  ilike: "ILIKE",
  like: "LIKE",
};

/** Split a PostgREST list on commas that are not inside parentheses. */
function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** Parse a PostgREST .or() string: comma-separated `column.op.value` terms. */
function orToSql(raw: string, params: unknown[]): string {
  const parts: string[] = [];
  for (const term of splitTopLevel(raw)) {
    const first = term.indexOf(".");
    const second = term.indexOf(".", first + 1);
    if (first < 0 || second < 0) throw new Error(`Unsupported .or() term: ${term}`);
    const col = term.slice(0, first);
    const op = term.slice(first + 1, second);
    const value = term.slice(second + 1);
    if (op === "is") {
      if (value === "null") parts.push(`${quoteIdent(col)} IS NULL`);
      else if (value === "not.null") parts.push(`${quoteIdent(col)} IS NOT NULL`);
      else throw new Error(`Unsupported .or() is-term: ${term}`);
      continue;
    }
    if (op === "in") {
      params.push(parseListLiteral(value));
      parts.push(`${quoteIdent(col)} = ANY($${params.length})`);
      continue;
    }
    const sqlOp = OR_OPS[op];
    if (!sqlOp) throw new Error(`Unsupported .or() operator: ${op}`);
    params.push(value);
    parts.push(`${quoteIdent(col)} ${sqlOp} $${params.length}`);
  }
  if (!parts.length) throw new Error(`Empty .or() filter: ${raw}`);
  return `(${parts.join(" OR ")})`;
}

/** PostgREST list literal "(a,b,c)" → values array. */
function parseListLiteral(raw: string): string[] {
  const inner = raw.trim().replace(/^\(/, "").replace(/\)$/, "");
  return inner
    .split(",")
    .map((v) => v.trim().replace(/^"(.*)"$/, "$1"))
    .filter((v) => v.length > 0);
}

/** Drop `undefined` values — supabase-js never sends them (see header). */
function defined(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out;
}

type WriteOp =
  | { kind: "insert"; rows: Record<string, unknown>[] }
  | {
      kind: "upsert";
      rows: Record<string, unknown>[];
      onConflict?: string;
      ignoreDuplicates?: boolean;
    }
  | { kind: "update"; patch: Record<string, unknown> }
  | { kind: "delete" };

/** Cache of primary-key column lists for upserts without onConflict. */
const pkCache = new Map<string, string[]>();

async function primaryKeyColumns(exec: QueryExecutor, schema: string, table: string): Promise<string[]> {
  const key = `${schema}.${table}`;
  const cached = pkCache.get(key);
  if (cached) return cached;
  const { rows } = await exec(
    `select a.attname as col
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
      where i.indisprimary and n.nspname = $1 and c.relname = $2
      order by a.attnum`,
    [schema, table],
  );
  const cols = rows.map((r) => String(r.col));
  if (cols.length) pkCache.set(key, cols);
  return cols;
}

export class PgQueryBuilder implements PromiseLike<Envelope> {
  private selectCols: string | null = null;
  private countMode: "exact" | null = null;
  private headMode = false;
  private write: WriteOp | null = null;
  private filters: Filter[] = [];
  private orders: Order[] = [];
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(
    private readonly exec: QueryExecutor,
    private readonly schemaName: string,
    private readonly table: string,
  ) {}

  select(cols = "*", opts?: { count?: "exact"; head?: boolean }): this {
    this.selectCols = cols;
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headMode = true;
    return this;
  }

  insert(rows: Record<string, unknown> | Record<string, unknown>[], opts?: { count?: "exact" }): this {
    this.write = { kind: "insert", rows: (Array.isArray(rows) ? rows : [rows]).map(defined) };
    if (opts?.count) this.countMode = opts.count;
    return this;
  }

  upsert(
    rows: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean; count?: "exact" },
  ): this {
    this.write = {
      kind: "upsert",
      rows: (Array.isArray(rows) ? rows : [rows]).map(defined),
      onConflict: opts?.onConflict,
      ignoreDuplicates: opts?.ignoreDuplicates,
    };
    if (opts?.count) this.countMode = opts.count;
    return this;
  }

  update(patch: Record<string, unknown>, opts?: { count?: "exact" }): this {
    this.write = { kind: "update", patch: defined(patch) };
    if (opts?.count) this.countMode = opts.count;
    return this;
  }

  delete(opts?: { count?: "exact" }): this {
    this.write = { kind: "delete" };
    if (opts?.count) this.countMode = opts.count;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ kind: "cmp", col, op: "=", value });
    return this;
  }
  neq(col: string, value: unknown): this {
    this.filters.push({ kind: "cmp", col, op: "<>", value });
    return this;
  }
  gt(col: string, value: unknown): this {
    this.filters.push({ kind: "cmp", col, op: ">", value });
    return this;
  }
  gte(col: string, value: unknown): this {
    this.filters.push({ kind: "cmp", col, op: ">=", value });
    return this;
  }
  lt(col: string, value: unknown): this {
    this.filters.push({ kind: "cmp", col, op: "<", value });
    return this;
  }
  lte(col: string, value: unknown): this {
    this.filters.push({ kind: "cmp", col, op: "<=", value });
    return this;
  }
  like(col: string, pattern: string): this {
    this.filters.push({ kind: "cmp", col, op: "LIKE", value: pattern });
    return this;
  }
  ilike(col: string, pattern: string): this {
    this.filters.push({ kind: "cmp", col, op: "ILIKE", value: pattern });
    return this;
  }

  in(col: string, values: unknown[]): this {
    this.filters.push({ kind: "in", col, values, negated: false });
    return this;
  }

  is(col: string, value: null | boolean): this {
    if (value !== null) {
      this.filters.push({ kind: "cmp", col, op: "=", value });
      return this;
    }
    this.filters.push({ kind: "isnull", col, negated: false });
    return this;
  }

  /** 3-arg PostgREST form: .not("transcript","is",null), .not("status","in","(a,b)") */
  not(col: string, op: string, value: unknown): this {
    if (op === "is" && value === null) {
      this.filters.push({ kind: "isnull", col, negated: true });
      return this;
    }
    if (op === "in" && typeof value === "string") {
      this.filters.push({ kind: "in", col, values: parseListLiteral(value), negated: true });
      return this;
    }
    const sqlOp = OR_OPS[op];
    if (!sqlOp) throw new Error(`Unsupported .not() operator: ${op}`);
    this.filters.push({ kind: "cmp", col, op: `!${sqlOp}`, value });
    return this;
  }

  or(raw: string): this {
    this.filters.push({ kind: "or", raw });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orders.push({ col, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  single(): this {
    this.mode = "single";
    return this;
  }

  maybeSingle(): this {
    this.mode = "maybeSingle";
    return this;
  }

  /** Type-level cast in supabase-js (`.returns<T>()`); a no-op at runtime. */
  returns(): this {
    return this;
  }

  then<TResult1 = Envelope, TResult2 = never>(
    onfulfilled?: ((value: Envelope) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private whereSql(params: unknown[]): string {
    const parts: string[] = [];
    for (const f of this.filters) {
      if (f.kind === "cmp") {
        const negated = f.op.startsWith("!");
        const op = negated ? f.op.slice(1) : f.op;
        params.push(f.value);
        const clause = `${quoteIdent(f.col)} ${op} $${params.length}`;
        parts.push(negated ? `NOT (${clause})` : clause);
      } else if (f.kind === "in") {
        params.push(f.values);
        parts.push(`${f.negated ? "NOT " : ""}(${quoteIdent(f.col)} = ANY($${params.length}))`);
      } else if (f.kind === "isnull") {
        parts.push(`${quoteIdent(f.col)} IS ${f.negated ? "NOT " : ""}NULL`);
      } else {
        parts.push(orToSql(f.raw, params));
      }
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  private orderSql(): string {
    if (!this.orders.length) return "";
    const parts = this.orders.map((o) => {
      let s = `${quoteIdent(o.col)} ${o.ascending ? "ASC" : "DESC"}`;
      if (o.nullsFirst !== undefined) s += o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
      return s;
    });
    return ` ORDER BY ${parts.join(", ")}`;
  }

  private limitOffsetSql(): string {
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      // PostgREST .range() is inclusive.
      const limit = this.rangeTo - this.rangeFrom + 1;
      return ` LIMIT ${Math.max(0, limit)} OFFSET ${Math.max(0, this.rangeFrom)}`;
    }
    if (this.limitN !== null) return ` LIMIT ${Math.max(0, this.limitN)}`;
    return "";
  }

  private async run(): Promise<Envelope> {
    try {
      return await this.runInner();
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) }, count: null };
    }
  }

  private shapeRows(rows: Record<string, unknown>[]): { data: unknown; error: PgError } {
    if (this.mode === "single") {
      if (rows.length !== 1) {
        return {
          data: null,
          error: { message: `JSON object requested, multiple (or no) rows returned (got ${rows.length})` },
        };
      }
      return { data: rows[0], error: null };
    }
    if (this.mode === "maybeSingle") {
      if (rows.length > 1) {
        return { data: null, error: { message: `Expected at most one row, got ${rows.length}` } };
      }
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  private async runInner(): Promise<Envelope> {
    const rel = quoteQualified(this.schemaName, this.table);

    if (!this.write) {
      // ---- SELECT ----
      if (this.countMode === "exact") {
        const countParams: unknown[] = [];
        const countSql = `SELECT count(*)::int AS n FROM ${rel}${this.whereSql(countParams)}`;
        if (this.headMode) {
          const { rows } = await this.exec(countSql, countParams);
          return { data: null, error: null, count: Number(rows[0]?.n ?? 0) };
        }
        // {count:"exact"} without head: PostgREST returns the rows AND the
        // total matching count (ignoring limit/range).
        const [page, total] = await Promise.all([this.selectRows(rel), this.exec(countSql, countParams)]);
        return { ...page, count: Number(total.rows[0]?.n ?? 0) };
      }
      return { ...(await this.selectRows(rel)), count: null };
    }

    // ---- WRITES ----
    const params: unknown[] = [];
    const returning = this.selectCols !== null ? ` RETURNING ${parseSelectCols(this.selectCols)}` : "";
    const kinds =
      this.write.kind === "delete"
        ? new Map<string, ColumnKind>()
        : await columnKindsFor(this.exec, this.schemaName, this.table);

    let sql: string;
    if (this.write.kind === "insert" || this.write.kind === "upsert") {
      const rows = this.write.rows;
      if (!rows.length) return { data: this.selectCols !== null ? [] : null, error: null, count: 0 };
      const colSet: string[] = [];
      for (const r of rows) {
        for (const k of Object.keys(r)) if (!colSet.includes(k)) colSet.push(k);
      }
      if (!colSet.length) {
        // Every value was undefined — insert a row of defaults (what PostgREST does for `{}`).
        sql = `INSERT INTO ${rel} DEFAULT VALUES${returning}`;
      } else {
        const valuesSql = rows
          .map(
            (r) =>
              `(${colSet
                .map((c) => {
                  if (!(c in r)) return "DEFAULT";
                  params.push(prepareValue(r[c], kinds.get(c)));
                  return `$${params.length}`;
                })
                .join(", ")})`,
          )
          .join(", ");
        sql = `INSERT INTO ${rel} (${colSet.map(quoteIdent).join(", ")}) VALUES ${valuesSql}`;

        if (this.write.kind === "upsert") {
          let conflictCols: string[];
          if (this.write.onConflict) {
            conflictCols = this.write.onConflict.split(",").map((c) => c.trim());
          } else {
            conflictCols = await primaryKeyColumns(this.exec, this.schemaName, this.table);
            if (!conflictCols.length) {
              throw new Error(`upsert on ${this.schemaName}.${this.table}: no primary key found and no onConflict given`);
            }
          }
          const target = `(${conflictCols.map(quoteIdent).join(", ")})`;
          if (this.write.ignoreDuplicates) {
            sql += ` ON CONFLICT ${target} DO NOTHING`;
          } else {
            const updatable = colSet.filter((c) => !conflictCols.includes(c));
            sql += updatable.length
              ? ` ON CONFLICT ${target} DO UPDATE SET ${updatable
                  .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
                  .join(", ")}`
              : ` ON CONFLICT ${target} DO NOTHING`;
          }
        }
        sql += returning;
      }
    } else if (this.write.kind === "update") {
      const patch = this.write.patch;
      const cols = Object.keys(patch);
      if (!cols.length) {
        // Nothing provided (all undefined) — nothing to change.
        return { data: this.selectCols !== null ? [] : null, error: null, count: 0 };
      }
      const sets = cols.map((c) => {
        params.push(prepareValue(patch[c], kinds.get(c)));
        return `${quoteIdent(c)} = $${params.length}`;
      });
      sql = `UPDATE ${rel} SET ${sets.join(", ")}${this.whereSql(params)}${returning}`;
    } else {
      sql = `DELETE FROM ${rel}${this.whereSql(params)}${returning}`;
    }

    const { rows, rowCount } = await this.exec(sql, params);
    const count = this.countMode === "exact" ? (rowCount ?? 0) : null;
    if (this.selectCols === null) return { data: null, error: null, count };
    return { ...this.shapeRows(rows), count };
  }

  private async selectRows(rel: string): Promise<{ data: unknown; error: PgError }> {
    const params: unknown[] = [];
    const cols = parseSelectCols(this.selectCols ?? "*");
    const sql = `SELECT ${cols} FROM ${rel}${this.whereSql(params)}${this.orderSql()}${this.limitOffsetSql()}`;
    const { rows } = await this.exec(sql, params);
    return this.shapeRows(rows);
  }
}

type ColumnKind = "array" | "json";

/**
 * Serialize a value the way PostgREST would store it:
 *  - json/jsonb columns: always JSON-encode (a JS string becomes a JSON string,
 *    not raw text that Postgres would fail to parse as JSON);
 *  - array columns (text[], uuid[] …): pass JS arrays through so node-pg emits a
 *    Postgres array literal (stringifying produced '["a","b"]'::text[] →
 *    "malformed array literal" in the hub on 2026-09-11);
 *  - any other object: JSON text (Date/Buffer pass through natively).
 */
function prepareValue(v: unknown, kind?: ColumnKind): unknown {
  if (v === null || v === undefined) return null;
  if (kind === "json") return JSON.stringify(v);
  if (typeof v !== "object") return v;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (kind === "array" && Array.isArray(v)) return v;
  return JSON.stringify(v);
}

/** Array- and json-typed columns per relation, looked up once per process. */
const columnKindCache = new Map<string, Promise<Map<string, ColumnKind>>>();

async function columnKindsFor(exec: QueryExecutor, schema: string, table: string): Promise<Map<string, ColumnKind>> {
  const key = `${schema}.${table}`;
  let pending = columnKindCache.get(key);
  if (!pending) {
    pending = exec(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND data_type IN ('ARRAY', 'json', 'jsonb')`,
      [schema, table],
    )
      .then(
        (r) =>
          new Map(
            r.rows.map((row) => [String(row.column_name), row.data_type === "ARRAY" ? "array" : "json"] as const),
          ),
      )
      .catch(() => {
        columnKindCache.delete(key); // transient failure → retry next write
        return new Map<string, ColumnKind>();
      });
    columnKindCache.set(key, pending);
  }
  return pending;
}

class PgSchemaHandle {
  constructor(
    private readonly exec: QueryExecutor,
    private readonly schemaName: string,
  ) {}

  from(table: string): PgQueryBuilder {
    return new PgQueryBuilder(this.exec, this.schemaName, table);
  }
}

export class PgRestClient {
  constructor(
    private readonly exec: QueryExecutor,
    private readonly defaultSchema = "public",
  ) {}

  from(table: string): PgQueryBuilder {
    return new PgQueryBuilder(this.exec, this.defaultSchema, table);
  }

  schema(name: string): PgSchemaHandle {
    return new PgSchemaHandle(this.exec, name);
  }

  async rpc(name: string, args?: Record<string, unknown>): Promise<Envelope> {
    try {
      const params: unknown[] = [];
      const argSql = Object.entries(args ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => {
          params.push(prepareValue(v));
          return `${quoteIdent(k)} := $${params.length}`;
        })
        .join(", ");
      const fn = `${quoteIdent(this.defaultSchema)}.${quoteIdent(name)}`;
      const { rows } = await this.exec(`SELECT * FROM ${fn}(${argSql})`, params);
      return { data: rows, error: null, count: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) }, count: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Pool wiring (PostgREST-compatible type output)
// ---------------------------------------------------------------------------

/** Type parsers matching PostgREST's JSON output instead of node-pg defaults. */
export function postgrestTypeParser(oid: number): (value: string) => unknown {
  switch (oid) {
    case 20: // int8
      return (v) => Number(v);
    case 1700: // numeric
      return (v) => Number(v);
    case 1082: // date — keep "YYYY-MM-DD"
      return (v) => v;
    case 1114: // timestamp (no tz) — PostgREST emits "YYYY-MM-DDTHH:MM:SS.ffffff"
      return (v) => v.replace(" ", "T");
    case 1184: // timestamptz — PostgREST emits ISO with a full offset ("+00:00").
      // pg text is "YYYY-MM-DD HH:MM:SS.ffffff+00" — keep precision, fix format.
      return (v) => v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    default:
      return pgTypes.getTypeParser(oid);
  }
}

export function executorFromPool(pool: Pool): QueryExecutor {
  return async (sql, params) => {
    const res = await pool.query({ text: sql, values: params as unknown[] });
    return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
  };
}

export function createPgRestClient(exec: QueryExecutor, defaultSchema = "public"): PgRestClient {
  return new PgRestClient(exec, defaultSchema);
}
