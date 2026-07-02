"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

/**
 * Client-side auth gate. Requires a Supabase session to view any page except
 * /login; redirects to /login otherwise. The real security boundary is the API
 * (requireAuth) + authenticated-only RLS — this guard just keeps the UI honest.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!session && !isLogin) router.replace("/login");
    if (session && isLogin) router.replace("/");
  }, [ready, session, isLogin, router]);

  if (isLogin) return <>{children}</>;
  if (!ready) return <div className="p-8 text-sm text-slate-400">Loading…</div>;
  if (!session) return null; // redirecting to /login
  return <>{children}</>;
}
