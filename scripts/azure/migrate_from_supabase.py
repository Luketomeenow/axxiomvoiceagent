#!/usr/bin/env python3
"""
Voice agents data move: Supabase → Azure Postgres (psql-axxiom-marketing / axxiom_hub).
Run in Azure Cloud Shell as your Entra login (upload this file — Cloud Shell has no repo).

Copies every table of the `outbound` schema that exists on both sides (except
dashboard_user, which only exists on Azure) plus public.ax_voice_call, then
proves exact row counts per table. Modeled on the marketing hub's
final_data_cutover.py (COPY streaming — no pg_dump version mismatches).

  python3 -m pip install --user -q "psycopg[binary]"
  export SUPABASE_DB_PASSWORD=$(az keyvault secret show --vault-name kv-axxiom-marketing --name supabase-db-password --query value -o tsv)
  python3 migrate_from_supabase.py --dry-run   # counts + safety checks, no writes
  python3 migrate_from_supabase.py             # trial copy (Azure app must have DIALER_ENABLED=false)
  python3 migrate_from_supabase.py --final     # cutover copy: Supabase must be quiet (see below)

Safety rails:
  * Refuses when Azure already has calls NEWER than Supabase's newest — Azure has
    taken over and a copy would wipe live data. (--force overrides; don't.)
  * --final refuses while any campaign is 'running' or any call is live on
    Supabase — pause everything and let calls finish on the old host first.
  * Azure rows are deleted in ONE transaction (reverse FK order) — a privilege
    error aborts before anything is written; each table then loads in its own
    transaction; identity sequences are re-synced; counts are verified.

Prereq: scripts/azure/sql/voice_schema.sql applied on Azure (it creates the tables).
Env overrides (defaults = production): AZ_PG_USER (your Entra email), AZ_PG_HOST,
AZ_PG_DATABASE, SUPABASE_HOST, SUPABASE_USER. --source-dsn / --target-dsn replace
the connections entirely (local testing).
"""

import argparse
import os
import subprocess
import sys
import time
from collections import defaultdict

try:
    import psycopg
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "--user", "-q", "psycopg[binary]"], check=True)
    import psycopg
from psycopg import sql

EXCLUDE = {("outbound", "dashboard_user")}
EXTRA = [("public", "ax_voice_call")]
LIVE_STATUSES = ("queued", "ringing", "in-progress")

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--dry-run", action="store_true", help="discovery, counts and safety checks only")
parser.add_argument("--final", action="store_true", help="cutover copy: require no running campaign / live call on Supabase")
parser.add_argument("--force", action="store_true", help="skip the 'Azure has newer data' refusal (dangerous)")
parser.add_argument("--no-checksum", action="store_true", help="verify row counts only (skip the content checksums)")
parser.add_argument("--source-dsn", help="override the Supabase connection (conninfo string)")
parser.add_argument("--target-dsn", help="override the Azure connection (conninfo string)")
args = parser.parse_args()

AZ_HOST = os.environ.get("AZ_PG_HOST", "psql-axxiom-marketing.postgres.database.azure.com")
AZ_DB = os.environ.get("AZ_PG_DATABASE", "axxiom_hub")
AZ_USER = os.environ.get("AZ_PG_USER", "luke.fernandez@axxiomelevator.com")


def supabase_connect():
    # Both sides in UTC so timestamptz text (COPY + checksums) is identical.
    if args.source_dsn:
        return psycopg.connect(args.source_dsn, options="-c TimeZone=UTC")
    return psycopg.connect(
        host=os.environ.get("SUPABASE_HOST", "aws-1-ap-northeast-1.pooler.supabase.com"),
        port=5432,
        dbname="postgres",
        user=os.environ.get("SUPABASE_USER", "postgres.cdlssoeqqfrgckpxewhn"),
        password=os.environ["SUPABASE_DB_PASSWORD"],
        sslmode="require",
        options="-c TimeZone=UTC",
    )


def azure_connect():
    if args.target_dsn:
        conn = psycopg.connect(args.target_dsn, options="-c TimeZone=UTC")
    else:
        token = subprocess.check_output(
            ["az", "account", "get-access-token", "--resource-type", "oss-rdbms", "--query", "accessToken", "-o", "tsv"],
            text=True,
        ).strip()
        conn = psycopg.connect(
            host=AZ_HOST, dbname=AZ_DB, user=AZ_USER, password=token, sslmode="require", options="-c TimeZone=UTC"
        )
    conn.autocommit = True  # each `with conn.transaction()` below is then a real transaction
    # Your login defaults to role dataservices@… — act as yourself (you own these tables).
    with conn.cursor() as cur:
        cur.execute("select session_user")
        me = cur.fetchone()[0]
        cur.execute(sql.SQL("set role {}").format(sql.Identifier(me)))
    return conn


def q(conn, query, params=None):
    with conn.cursor() as cur:
        cur.execute(query, params or ())
        return cur.fetchall() if cur.description else []


def rel(t):
    return f'"{t[0]}"."{t[1]}"'


def base_tables(conn):
    rows = q(
        conn,
        """select table_schema, table_name from information_schema.tables
            where table_type = 'BASE TABLE'
              and (table_schema = 'outbound' or (table_schema, table_name) in (('public', 'ax_voice_call')))""",
    )
    return {(s, t) for s, t in rows}


def fk_order(conn, tables):
    """FK targets before referrers (Kahn); cycles appended last."""
    deps = defaultdict(set)
    for cs, ct, ps, pt in q(
        conn,
        """select tc.table_schema, tc.table_name, ccu.table_schema, ccu.table_name
             from information_schema.table_constraints tc
             join information_schema.constraint_column_usage ccu
               on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
            where tc.constraint_type = 'FOREIGN KEY'""",
    ):
        child, parent = (cs, ct), (ps, pt)
        if child in tables and parent in tables and child != parent:
            deps[child].add(parent)
    ordered, remaining = [], set(tables)
    while remaining:
        ready = sorted(t for t in remaining if not (deps[t] & remaining))
        if not ready:
            ordered += sorted(remaining)
            break
        ordered += ready
        remaining -= set(ready)
    return ordered


def columns(conn, t):
    return [
        r[0]
        for r in q(
            conn,
            """select a.attname from pg_attribute a
                 join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = %s and c.relname = %s and a.attnum > 0 and not a.attisdropped
                  and a.attgenerated = ''
                order by a.attnum""",
            t,
        )
    ]


def count(conn, t):
    return q(conn, f"select count(*) from {rel(t)}")[0][0]


def pk_columns(conn, t):
    return [
        r[0]
        for r in q(
            conn,
            """select a.attname from pg_index i
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                where i.indrelid = %s::regclass and i.indisprimary
                order by array_position(i.indkey, a.attnum)""",
            (rel(t),),
        )
    ]


def checksum(conn, t, cols, order_by):
    """md5 over every copied column of every row, in primary-key order — proves
    the CONTENT matches, not just the row count (column order-independent)."""
    row = ", ".join(f'"{c}"' for c in cols)
    order = ", ".join(f'"{c}"' for c in order_by)
    return q(conn, f"select md5(coalesce(string_agg(md5(row({row})::text), '' order by {order}), '')) from {rel(t)}")[0][0]


def newest_call(conn):
    return q(conn, 'select max(created_at) from "outbound"."call"')[0][0]


def main():
    t0 = time.time()
    supa = supabase_connect()
    supa.autocommit = True  # read-only source; a failed COPY must not poison later reads
    az = azure_connect()

    src_tables = base_tables(supa)
    dst_tables = base_tables(az)
    wanted = {t for t in src_tables if t[0] == "outbound" and t not in EXCLUDE} | {t for t in EXTRA if t in src_tables}
    missing = sorted(t for t in wanted if t not in dst_tables)
    if missing:
        print("STOP: missing on Azure (apply scripts/azure/sql/voice_schema.sql first):", ", ".join(rel(t) for t in missing))
        sys.exit(1)
    order = fk_order(supa, wanted)
    print(f"== {len(order)} tables, FK-safe order: {', '.join(t[1] for t in order)}")

    # ---- safety checks --------------------------------------------------------
    running = q(supa, """select count(*) from "outbound"."campaign" where status = 'running'""")[0][0]
    live = q(supa, 'select count(*) from "outbound"."call" where status = any(%s)', (list(LIVE_STATUSES),))[0][0]
    print(f"== Supabase: {running} running campaign(s), {live} live call(s)")
    if args.final and (running or live):
        print("STOP (--final): pause every campaign and let live calls finish on the old host, then re-run.")
        sys.exit(1)
    s_new, a_new = newest_call(supa), newest_call(az)
    print(f"== newest call — Supabase: {s_new}  Azure: {a_new}")
    if a_new and s_new and a_new > s_new and not args.force:
        print("STOP: Azure already has calls newer than Supabase — it has taken over. Copying would wipe them.")
        sys.exit(1)

    src = {t: count(supa, t) for t in order}
    print(f"== Supabase rows: {sum(src.values()):,} — " + ", ".join(f"{t[1]} {n:,}" for t, n in src.items()))
    if args.dry_run:
        print("dry run — no writes.")
        return

    print("== wipe Azure rows (one transaction, reverse FK order)")
    try:
        with az.transaction(), az.cursor() as cur:
            for t in reversed(order):
                cur.execute(f"delete from {rel(t)}")
    except Exception as e:
        print("STOP: wipe failed, nothing loaded —", str(e).strip().splitlines()[0])
        print("      (a table owned by someone else? its owner grants you DELETE, or runs this)")
        sys.exit(1)

    print("== copy Supabase → Azure")
    failed, skipped_cols, copied_cols = {}, {}, {}
    for t in order:
        src_cols, dst_cols = columns(supa, t), set(columns(az, t))
        cols = [c for c in src_cols if c in dst_cols]
        copied_cols[t] = cols
        if len(cols) < len(src_cols):
            skipped_cols[t] = [c for c in src_cols if c not in dst_cols]
        collist = ", ".join(f'"{c}"' for c in cols)
        try:
            with az.transaction(), az.cursor() as dst, supa.cursor() as s:
                with s.copy(f"copy {rel(t)} ({collist}) to stdout") as out, dst.copy(f"copy {rel(t)} ({collist}) from stdin") as inp:
                    for chunk in out:
                        inp.write(chunk)
            print(f"   {rel(t)}: {src[t]:,} rows")
        except Exception as e:
            failed[t] = str(e).strip().splitlines()[0]
            print(f"   {rel(t)}: FAILED — {failed[t][:160]}")

    print("== re-sync identity/serial sequences")
    n = 0
    with az.transaction(), az.cursor() as cur:
        for schema, table, col, seq in q(
            az,
            """select c.table_schema, c.table_name, c.column_name,
                      pg_get_serial_sequence(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), c.column_name)
                 from information_schema.columns c
                where (c.table_schema = 'outbound' or (c.table_schema, c.table_name) in (('public', 'ax_voice_call')))
                  and pg_get_serial_sequence(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), c.column_name) is not null""",
        ):
            cur.execute(f'select setval(%s, coalesce((select max("{col}") from "{schema}"."{table}"), 0) + 1, false)', (seq,))
            n += 1
    print(f"   {n} sequence(s) set")

    print("== verify exact counts" + ("" if args.no_checksum else " + content checksums") + " (Supabase vs Azure)")
    mism = 0
    for t in order:
        dst_n = count(az, t)
        ok = src[t] == dst_n
        note = ""
        if ok and not args.no_checksum and t not in failed:
            pk = pk_columns(supa, t) or copied_cols[t]
            same = checksum(supa, t, copied_cols[t], pk) == checksum(az, t, copied_cols[t], pk)
            ok, note = same, ("  content ✓" if same else "  CONTENT DIFFERS")
        mism += 0 if ok else 1
        print(f"   {'MATCH   ' if ok else 'MISMATCH'} {rel(t):36s} {src[t]:>9,} → {dst_n:>9,}{note}")
    print(f"--- {mism} mismatches / {len(order)} tables in {int(time.time() - t0)}s")
    if failed:
        print("failed tables:", {rel(t): e for t, e in failed.items()})
    if skipped_cols:
        print("COLUMNS NOT ON AZURE (schema drift — add them to voice_schema.sql and re-run):",
              {rel(t): c for t, c in skipped_cols.items()})
    campaigns = q(az, 'select status, count(*) from "outbound"."campaign" group by 1 order by 1')
    print("== Azure campaigns by status:", ", ".join(f"{s} {c}" for s, c in campaigns) or "none")
    if mism or failed:
        sys.exit(1)


main()
