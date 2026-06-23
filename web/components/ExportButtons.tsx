"use client";

import { useEffect, useState } from "react";
import { api, type BrandInfo } from "@/lib/api";

const PRESETS: { label: string; value: string }[] = [
  { label: "Qualified", value: "qualified" },
  { label: "Needs follow-up", value: "needs_followup" },
  { label: "Remove / DNC", value: "remove,dnc" },
  { label: "All", value: "all" },
];

export function ExportButtons({ campaignId }: { campaignId: string | null }) {
  const [disposition, setDisposition] = useState("qualified");
  const [brand, setBrand] = useState(""); // "" = all brands
  const [brands, setBrands] = useState<BrandInfo[]>([]);

  useEffect(() => {
    let active = true;
    api
      .brands(campaignId)
      .then((b) => {
        if (active) setBrands(b);
      })
      .catch(() => {
        if (active) setBrands([]);
      });
    return () => {
      active = false;
    };
  }, [campaignId]);

  const brandLabel = brand || "all brands";

  return (
    <div className="card card-pad flex flex-wrap items-center gap-2">
      <span className="label mr-1">Export</span>

      <select
        value={brand}
        onChange={(e) => setBrand(e.target.value)}
        className="rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-sm outline-none focus:border-sky-500/60"
        title="Filter by servicing brand"
      >
        <option value="">All brands</option>
        {brands.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name} ({b.count})
          </option>
        ))}
      </select>

      <select
        value={disposition}
        onChange={(e) => setDisposition(e.target.value)}
        className="rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-sm outline-none focus:border-sky-500/60"
      >
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>

      <a
        href={api.exportUrl(disposition, "xlsx", campaignId, brand || null)}
        className="btn btn-primary btn-xs"
        title={`Export ${disposition} leads for ${brandLabel} as Excel`}
      >
        Excel
      </a>
      <a
        href={api.exportUrl(disposition, "csv", campaignId, brand || null)}
        className="btn btn-ghost btn-xs"
        title={`Export ${disposition} leads for ${brandLabel} as CSV`}
      >
        CSV
      </a>
    </div>
  );
}
