import { createClient } from "@supabase/supabase-js";

// Fallbacks keep `next build` from crashing when env isn't set yet; real values
// are inlined at build time from web/.env.local for any actual deploy.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost:54321";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "anon-key-not-set";

/**
 * Browser Supabase client scoped to the `outbound` schema. Reads + Realtime for
 * the dashboard. Writes/actions go through the Hono API (service role).
 *
 * Requires the `outbound` schema to be exposed in Supabase API settings, with
 * read RLS policies + Realtime enabled (see scripts/sql/outbound_schema.sql).
 */
export const supabase = createClient(url, anon, {
  db: { schema: "outbound" },
  auth: { persistSession: false },
});

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3000";
