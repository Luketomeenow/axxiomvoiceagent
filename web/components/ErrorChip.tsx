"use client";

/**
 * Small inline indicator for a panel whose last refresh failed — the data shown
 * may be stale. Rendered next to panel titles so failures are visible instead
 * of indistinguishable from "no data".
 */
export default function ErrorChip({ error, label }: { error: string | null; label?: string }) {
  if (!error) return null;
  return (
    <span title={error} className="chip bg-amber-500/15 text-amber-300 border-amber-500/40">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      {label ?? "data may be stale"}
    </span>
  );
}
