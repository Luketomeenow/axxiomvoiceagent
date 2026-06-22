"use client";

import { useRef, useState } from "react";
import { api, type ImportResult, type SheetInfo } from "@/lib/api";

/**
 * Upload the leads workbook and pick the campaign-ready sheet to import.
 * Two steps: (1) upload -> the backend lists the sheets + suggests the
 * campaign-ready one; (2) choose sheet + region/campaign -> import.
 */
export function ImportLeadsCard({ onImported }: { onImported?: (campaignId?: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<SheetInfo[] | null>(null);
  const [sheet, setSheet] = useState("");
  const [region, setRegion] = useState("");
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setFile(null);
    setSheets(null);
    setSheet("");
    setRegion("");
    setCampaign("");
    setError(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onPick(f: File | null) {
    setError(null);
    setResult(null);
    setSheets(null);
    setFile(f);
    if (!f) return;
    setBusy(true);
    try {
      const res = await api.importPreview(f);
      if (res.error || !res.sheets) {
        setError(res.error ?? "Could not read workbook.");
        return;
      }
      setSheets(res.sheets);
      setSheet(res.suggested ?? res.sheets[0]?.name ?? "");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    if (!file || !sheet) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.importLeads(file, {
        sheet,
        region: region.trim() || undefined,
        campaign: campaign.trim() || undefined,
      });
      if (res.ok === false || res.error) {
        setError(res.error ?? "Import failed.");
        return;
      }
      setResult(res);
      onImported?.(res.campaignId ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const selectedRows = sheets?.find((s) => s.name === sheet)?.rows ?? 0;

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Import leads</h2>
          <p className="text-sm text-slate-400">
            Upload the leads workbook (.xlsx) and choose the campaign-ready sheet to load.
          </p>
        </div>
        {(file || result) && (
          <button onClick={reset} className="rounded-md border border-white/10 px-3 py-1 text-sm hover:bg-white/5">
            Reset
          </button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-sky-500 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-sky-400"
      />

      {busy && !sheets && <p className="mt-3 text-sm text-slate-400">Reading workbook…</p>}

      {sheets && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-slate-400">Campaign-ready sheet</span>
            <select
              value={sheet}
              onChange={(e) => setSheet(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-ink px-3 py-2 text-sm"
            >
              {sheets.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.rows} rows)
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-slate-400">Region (optional)</span>
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="e.g. CA — Bay Area"
              className="mt-1 w-full rounded-lg border border-white/10 bg-ink px-3 py-2 text-sm"
            />
          </label>
          <label className="block md:col-span-2">
            <span className="text-xs uppercase tracking-wide text-slate-400">Campaign name (optional)</span>
            <input
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              placeholder={region.trim() || "Defaults to the region or sheet name"}
              className="mt-1 w-full rounded-lg border border-white/10 bg-ink px-3 py-2 text-sm"
            />
          </label>
          <div className="md:col-span-2 flex items-center gap-3">
            <button
              onClick={onImport}
              disabled={busy || !sheet}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-ink hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? "Importing…" : `Import ${selectedRows} leads`}
            </button>
            <span className="text-xs text-slate-400">Phones are normalized, deduped, and re-import is safe.</span>
          </div>
        </div>
      )}

      {error && <p className="mt-3 rounded-md bg-rose-500/15 px-3 py-2 text-sm text-rose-300">{error}</p>}

      {result && (
        <div className="mt-3 rounded-md bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200">
          Imported {result.imported} leads into <span className="font-semibold">{result.campaignName}</span> — deduped{" "}
          {result.deduped} of {result.totalRows}, flagged {result.badNumbers} as bad numbers.
        </div>
      )}
    </div>
  );
}
