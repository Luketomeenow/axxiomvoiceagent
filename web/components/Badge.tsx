import type { Disposition } from "@/lib/types";

const COLORS: Record<string, string> = {
  qualified: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  needs_followup: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  not_interested: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  remove: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  dnc: "bg-rose-600/20 text-rose-300 border-rose-600/40",
  bad_number: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
  no_answer: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  voicemail: "bg-indigo-500/20 text-indigo-300 border-indigo-500/40",
  calling: "bg-yellow-500/20 text-yellow-200 border-yellow-500/40 animate-pulse",
  queued: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  new: "bg-slate-600/20 text-slate-300 border-slate-600/40",
};

export function Badge({ value }: { value: string }) {
  const cls = COLORS[value] ?? "bg-slate-600/20 text-slate-300 border-slate-600/40";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

export type { Disposition };
