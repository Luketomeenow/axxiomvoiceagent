/**
 * Dashboard operator accounts (outbound.dashboard_user). Invite-only: there is
 * no signup route — accounts are created with `bun run dashboard-user add`
 * (which can emit SQL to paste into Azure Cloud Shell, since laptops can't
 * reach the Azure Postgres server).
 */

import { db } from "../outbound/db.ts";

export interface DashboardUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  session_version: number;
  password_hash: string;
  last_login_at: string | null;
}

const TABLE = "dashboard_user";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(email: string): Promise<DashboardUser | null> {
  const { data, error } = await db().from(TABLE).select("*").eq("email", normalizeEmail(email)).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DashboardUser | null) ?? null;
}

export async function findUserById(id: string): Promise<DashboardUser | null> {
  const { data, error } = await db().from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DashboardUser | null) ?? null;
}

export async function touchLastLogin(id: string): Promise<void> {
  await db().from(TABLE).update({ last_login_at: new Date().toISOString() }).eq("id", id);
}

/** Set a new password and bump session_version (signs out every other session). */
export async function setPasswordHash(user: DashboardUser, passwordHash: string): Promise<DashboardUser> {
  const { data, error } = await db()
    .from(TABLE)
    .update({
      password_hash: passwordHash,
      session_version: user.session_version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as DashboardUser;
}

export async function listUsers(): Promise<Omit<DashboardUser, "password_hash">[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select("id, email, name, role, disabled, session_version, last_login_at")
    .order("email");
  if (error) throw new Error(error.message);
  return (data ?? []) as Omit<DashboardUser, "password_hash">[];
}
