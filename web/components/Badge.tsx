import type { Disposition } from "@/lib/types";

const COLORS: Record<string, { cls: string; dot: string }> = {
  qualified: { cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", dot: "bg-emerald-400" },
  needs_followup: { cls: "bg-amber-500/15 text-amber-300 border-amber-500/40", dot: "bg-amber-400" },
  not_interested: { cls: "bg-slate-500/15 text-slate-300 border-slate-500/40", dot: "bg-slate-400" },
  remove: { cls: "bg-rose-500/15 text-rose-300 border-rose-500/40", dot: "bg-rose-400" },
  dnc: { cls: "bg-rose-600/15 text-rose-300 border-rose-600/40", dot: "bg-rose-500" },
  bad_number: { cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/40", dot: "bg-zinc-400" },
  no_answer: { cls: "bg-sky-500/15 text-sky-300 border-sky-500/40", dot: "bg-sky-400" },
  voicemail: { cls: "bg-indigo-500/15 text-indigo-300 border-indigo-500/40", dot: "bg-indigo-400" },
  calling: { cls: "bg-yellow-500/15 text-yellow-200 border-yellow-500/40", dot: "bg-yellow-400 animate-pulse" },
  queued: { cls: "bg-blue-500/15 text-blue-300 border-blue-500/40", dot: "bg-blue-400" },
  new: { cls: "bg-slate-600/15 text-slate-300 border-slate-600/40", dot: "bg-slate-400" },
};

export function Badge({ value }: { value: string }) {
  const c = COLORS[value] ?? { cls: "bg-slate-600/15 text-slate-300 border-slate-600/40", dot: "bg-slate-400" };
  return (
    <span className={`chip ${c.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {value.replace(/_/g, " ")}
    </span>
  );
}

export type { Disposition };
