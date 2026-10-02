"use client";

import { useState } from "react";

import { api } from "@/lib/api";
import { useMe } from "./AuthGuard";

/** Header account menu: who's signed in, change password, sign out. */
export function UserMenu() {
  const me = useMe();
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!me) return null;

  async function signOut() {
    await api.logout().catch(() => {});
    window.location.assign("/login");
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setMessage({ ok: false, text: "New passwords don't match." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const r = await api.changePassword(current, next).catch((err) => ({ ok: false, error: String(err) }));
    setBusy(false);
    if (!r.ok) {
      setMessage({ ok: false, text: r.error ?? "Could not change the password." });
      return;
    }
    setMessage({ ok: true, text: "Password changed — other sessions were signed out." });
    setCurrent("");
    setNext("");
    setConfirm("");
    setChanging(false);
  }

  return (
    <details className="relative">
      <summary className="btn btn-ghost btn-xs cursor-pointer list-none" title={me.user.email}>
        👤 {me.user.name || me.user.email}
      </summary>
      <div className="absolute right-0 z-30 mt-2 w-72 space-y-3 rounded-xl border border-white/10 bg-ink p-3 text-sm shadow-xl">
        <div className="text-xs text-slate-400">
          Signed in as <span className="text-slate-200">{me.user.email}</span>
        </div>
        {changing ? (
          <form onSubmit={changePassword} className="space-y-2">
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              className="field w-full"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="New password (10+ characters)"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={10}
              className="field w-full"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className="field w-full"
            />
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className="btn btn-primary btn-xs">
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setChanging(false)} className="btn btn-ghost btn-xs">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button onClick={() => setChanging(true)} className="btn btn-ghost btn-xs w-full">
            Change password
          </button>
        )}
        {message && <p className={`text-xs ${message.ok ? "text-emerald-300" : "text-red-400"}`}>{message.text}</p>}
        <button onClick={signOut} className="btn btn-ghost btn-xs w-full">
          Sign out
        </button>
      </div>
    </details>
  );
}
