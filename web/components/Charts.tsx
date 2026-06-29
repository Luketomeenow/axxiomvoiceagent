"use client";

/**
 * Lightweight, dependency-free chart primitives (plain SVG + CSS) for the
 * analytics dashboard. Kept in-repo on purpose: the app ships no charting
 * library, and these match the existing dark theme (.card / accent palette).
 */

const ACCENTS: Record<string, string> = {
  emerald: "#34d399",
  sky: "#38bdf8",
  amber: "#fbbf24",
  rose: "#fb7185",
  indigo: "#818cf8",
  slate: "#94a3b8",
  violet: "#a78bfa",
};

/** Horizontal labelled bars — funnel stages, dispositions, etc. */
export function BarList({
  items,
  format,
}: {
  items: { label: string; value: number; accent?: keyof typeof ACCENTS; hint?: string }[];
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const fmt = format ?? ((v: number) => v.toLocaleString());
  return (
    <div className="space-y-2.5">
      {items.map((it) => (
        <div key={it.label} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-300">{it.label}</span>
            <span className="tabular-nums font-semibold text-slate-100">
              {fmt(it.value)}
              {it.hint && <span className="ml-1.5 text-xs font-normal text-slate-500">{it.hint}</span>}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${(it.value / max) * 100}%`, backgroundColor: ACCENTS[it.accent ?? "sky"] }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Vertical columns — e.g. attempts-to-qualify distribution. */
export function ColumnChart({
  data,
  height = 140,
}: {
  data: { label: string; value: number; sub?: number }[];
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <Empty />;
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex w-full flex-1 items-end justify-center">
            <div
              className="relative w-full max-w-[40px] overflow-hidden rounded-t-md bg-sky-500/30"
              style={{ height: `${(d.value / max) * 100}%` }}
              title={`${d.value} leads`}
            >
              {d.sub != null && d.sub > 0 && (
                <div
                  className="absolute bottom-0 w-full bg-emerald-400/80"
                  style={{ height: `${(d.sub / Math.max(1, d.value)) * 100}%` }}
                  title={`${d.sub} qualified`}
                />
              )}
            </div>
          </div>
          <span className="text-[11px] tabular-nums text-slate-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

interface Series {
  key: string;
  label: string;
  accent: keyof typeof ACCENTS;
}

/** Multi-series line chart over a categorical x-axis (days). */
export function LineChart({
  rows,
  xKey,
  series,
  height = 200,
}: {
  rows: Record<string, number | string>[];
  xKey: string;
  series: Series[];
  height?: number;
}) {
  if (!rows.length) return <Empty />;
  const W = 640;
  const H = height;
  const padX = 8;
  const padY = 16;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const max = Math.max(
    1,
    ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)),
  );
  const n = rows.length;
  const x = (i: number) => padX + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padY + innerH - (v / max) * innerH;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ACCENTS[s.accent] }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={padX} x2={W - padX} y1={padY + innerH * g} y2={padY + innerH * g} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        ))}
        {series.map((s) => {
          const pts = rows.map((r, i) => `${x(i)},${y(Number(r[s.key]) || 0)}`).join(" ");
          return (
            <polyline
              key={s.key}
              points={pts}
              fill="none"
              stroke={ACCENTS[s.accent]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <div className="flex justify-between text-[11px] text-slate-500">
        <span>{String(rows[0][xKey])}</span>
        {rows.length > 2 && <span>{String(rows[Math.floor(n / 2)][xKey])}</span>}
        <span>{String(rows[n - 1][xKey])}</span>
      </div>
    </div>
  );
}

/** A donut/ring percentage indicator. */
export function Ring({ pct, label, accent = "emerald" }: { pct: number; label: string; accent?: keyof typeof ACCENTS }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={8} />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={ACCENTS[accent]}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
        />
      </svg>
      <div>
        <div className="text-2xl font-bold tabular-nums">{Math.round(clamped)}%</div>
        <div className="text-xs text-slate-400">{label}</div>
      </div>
    </div>
  );
}

function Empty() {
  return <div className="flex h-24 items-center justify-center text-sm text-slate-500">No data yet</div>;
}
