"use client";

import { useMemo, useState } from "react";

const LINES_PER_PAGE = 12;

const AGENT = ["ai", "assistant", "bot", "agent", "alex", "axxiom"];
const USER = ["user", "customer", "caller", "human", "them", "prospect"];

/**
 * Compact, scrollable, paginated transcript. Long transcripts no longer sprawl —
 * they show a page of color-coded lines (agent vs. caller) with Prev/Next.
 */
export function TranscriptViewer({ text }: { text: string }) {
  const lines = useMemo(
    () =>
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    [text],
  );
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * LINES_PER_PAGE;
  const slice = lines.slice(start, start + LINES_PER_PAGE);

  function roleOf(line: string): "agent" | "user" | null {
    const m = line.match(/^([a-z]+)\s*[:\-]/i);
    if (!m) return null;
    const w = m[1].toLowerCase();
    if (AGENT.includes(w)) return "agent";
    if (USER.includes(w)) return "user";
    return null;
  }

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-white/10 bg-black/30">
      <div className="max-h-52 space-y-1 overflow-y-auto p-2.5 text-xs leading-relaxed">
        {slice.map((line, i) => {
          const role = roleOf(line);
          return (
            <p
              key={start + i}
              className={role === "agent" ? "text-sky-300" : role === "user" ? "text-slate-200" : "text-slate-400"}
            >
              {line}
            </p>
          );
        })}
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-white/10 px-2 py-1.5 text-xs text-slate-400">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="btn btn-ghost btn-xs disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <span className="tabular-nums">
            Page {safePage + 1} / {pageCount} · {lines.length} lines
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
            className="btn btn-ghost btn-xs disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
