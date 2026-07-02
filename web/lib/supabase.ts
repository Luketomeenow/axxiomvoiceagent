import { createClient } from "@supabase/supabase-js";

// Fallbacks keep `next build` from crashing when env isn't set yet; real values
// are inlined at build time from web/.env.local for any actual deploy.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost:54321";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "anon-key-not-set";

/**
 * Browser Supabase client scoped to the `outbound` schema. Reads + Realtime for
 * the dashboard (as the logged-in `authenticated` user). Writes/actions go
 * through the Hono API (service role), authenticated with the user's JWT.
 *
 * Requires the `outbound` schema to be exposed in Supabase API settings, with
 * `authenticated`-only RLS policies + Realtime enabled (see
 * scripts/sql/outbound_schema.sql). The session is persisted so reads +
 * Realtime run as the signed-in user and getAccessToken() can authorize the API.
 */
export const supabase = createClient(url, anon, {
  db: { schema: "outbound" },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3000";

/** The current user's Supabase access token (JWT) for authorizing API calls, or null. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
