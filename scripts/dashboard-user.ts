/**
 * Manage dashboard logins (outbound.dashboard_user) — invite-only, no signup.
 *
 *   bun run dashboard-user add you@axxiomelevator.com --name "Your Name" [--admin]
 *   bun run dashboard-user reset you@axxiomelevator.com     # new password, signs out every session
 *   bun run dashboard-user disable you@axxiomelevator.com   # (enable to undo)
 *   bun run dashboard-user list
 *
 * add / reset generate a one-time password (or take --password) and print it
 * ONCE — hand it over out-of-band; the operator can change it from the
 * dashboard header.
 *
 * On Azure a laptop can't reach the database, so add `--sql`: nothing is
 * written, the script prints the SQL instead — paste it into psql in Azure
 * Cloud Shell (connected as described in scripts/azure/sql/voice_schema.sql).
 * Node fallback: npm run dashboard-user:node -- add …
 */

import { hashPassword, generatePassword, passwordPolicyError } from "../src/lib/passwords.ts";

const USAGE = `Usage:
  bun run dashboard-user add <email> [--name "Full Name"] [--admin] [--password P] [--sql]
  bun run dashboard-user reset <email> [--password P] [--sql]
  bun run dashboard-user disable|enable <email> [--sql]
  bun run dashboard-user list`;

const VALUE_FLAGS = new Set(["--name", "--password"]);

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);
const sqlString = (v: string | null) => (v == null ? "null" : `'${v.replace(/'/g, "''")}'`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, rawEmail] = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));
  const email = rawEmail?.trim().toLowerCase();
  const printSql = has("--sql");

  if (command === "list") {
    const { listUsers } = await import("../src/auth/users.ts");
    for (const u of await listUsers()) {
      console.log(`${u.disabled ? "✗" : "✓"} ${u.email.padEnd(40)} ${u.role.padEnd(9)} ${u.name ?? ""}  last login: ${u.last_login_at ?? "never"}`);
    }
    return;
  }
  if (!command || !email || !email.includes("@")) {
    console.error(USAGE);
    process.exit(1);
  }

  if (command === "add" || command === "reset") {
    const password = arg("--password") ?? generatePassword();
    const policy = passwordPolicyError(password);
    if (policy) {
      console.error(policy);
      process.exit(1);
    }
    const hash = await hashPassword(password);
    const name = arg("--name") ?? null;
    const role = has("--admin") ? "admin" : "operator";

    if (printSql) {
      console.log("-- paste into psql (Azure Cloud Shell, connected to axxiom_hub):");
      if (command === "add") {
        console.log(
          `insert into outbound.dashboard_user (email, name, role, password_hash)\n  values (${sqlString(email)}, ${sqlString(name)}, ${sqlString(role)}, ${sqlString(hash)})\n` +
            `  on conflict (email) do update set password_hash = excluded.password_hash, disabled = false,\n` +
            `    session_version = outbound.dashboard_user.session_version + 1, updated_at = now();`,
        );
      } else {
        console.log(
          `update outbound.dashboard_user set password_hash = ${sqlString(hash)},\n` +
            `  session_version = session_version + 1, updated_at = now() where email = ${sqlString(email)};`,
        );
      }
    } else {
      const { db } = await import("../src/outbound/db.ts");
      if (command === "add") {
        const { data: existing } = await db().from("dashboard_user").select("id, session_version").eq("email", email).maybeSingle();
        const row = existing as { id: string; session_version: number } | null;
        const { error } = row
          ? await db()
              .from("dashboard_user")
              .update({ password_hash: hash, disabled: false, session_version: row.session_version + 1, updated_at: new Date().toISOString(), ...(name ? { name } : {}) })
              .eq("id", row.id)
          : await db().from("dashboard_user").insert({ email, name, role, password_hash: hash });
        if (error) throw new Error(error.message);
      } else {
        const { data: user } = await db().from("dashboard_user").select("id, session_version").eq("email", email).maybeSingle();
        const row = user as { id: string; session_version: number } | null;
        if (!row) throw new Error(`no dashboard user ${email}`);
        const { error } = await db()
          .from("dashboard_user")
          .update({ password_hash: hash, session_version: row.session_version + 1, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (error) throw new Error(error.message);
      }
      console.log(`✅ ${command === "add" ? "Saved" : "Reset"} ${email}`);
    }
    if (!arg("--password")) console.log(`\nOne-time password for ${email} (shown once):  ${password}\n`);
    return;
  }

  if (command === "disable" || command === "enable") {
    const disabled = command === "disable";
    if (printSql) {
      console.log(
        `update outbound.dashboard_user set disabled = ${disabled}, session_version = session_version + 1, updated_at = now() where email = ${sqlString(email)};`,
      );
      return;
    }
    const { db } = await import("../src/outbound/db.ts");
    const { data: user } = await db().from("dashboard_user").select("id, session_version").eq("email", email).maybeSingle();
    const row = user as { id: string; session_version: number } | null;
    if (!row) throw new Error(`no dashboard user ${email}`);
    const { error } = await db()
      .from("dashboard_user")
      .update({ disabled, session_version: row.session_version + 1, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    console.log(`✅ ${email} ${disabled ? "disabled (signed out everywhere)" : "enabled"}`);
    return;
  }

  console.error(USAGE);
  process.exit(1);
}

main()
  .then(async () => {
    const { env } = await import("../src/config/env.ts");
    if (env.dataBackend === "azure") await (await import("../src/lib/pg/backend.ts")).closePool();
  })
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
