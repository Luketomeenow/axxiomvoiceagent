"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { api, type Me } from "@/lib/api";

const MeContext = createContext<Me | null>(null);

/** The signed-in operator + instance flags (null on /login). */
export function useMe(): Me | null {
  return useContext(MeContext);
}

/**
 * Client-side auth gate. Requires a dashboard session (httpOnly cookie, checked
 * via GET /auth/me) to view any page except /login; redirects to /login
 * otherwise. The real security boundary is the API (requireAuth on every
 * /outbound/* route) — this guard just keeps the UI honest.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  useEffect(() => {
    let active = true;
    api
      .me()
      .then((m) => {
        if (!active) return;
        setMe(m);
        setError(null);
        setReady(true);
      })
      .catch((err) => {
        if (!active) return;
        setError(String(err instanceof Error ? err.message : err));
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    if (!ready || error) return;
    if (!me && !isLogin) router.replace("/login");
    if (me && isLogin) router.replace("/");
  }, [ready, error, me, isLogin, router]);

  if (isLogin) return <>{children}</>;
  if (!ready) return <div className="p-8 text-sm text-slate-400">Loading…</div>;
  if (error) {
    return (
      <div className="p-8 text-sm text-amber-300">
        Can&apos;t reach the server ({error}). Retrying on reload.
      </div>
    );
  }
  if (!me) return null; // redirecting to /login
  return (
    <MeContext.Provider value={me}>
      {!me.instance.dialerEnabled && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-center text-xs text-amber-200">
          Dialing is disabled on this instance (DIALER_ENABLED=false) — everything is viewable, but no calls will be placed.
        </div>
      )}
      {children}
    </MeContext.Provider>
  );
}
