import { API_BASE } from "./supabase";

async function post(path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function postForm(path: string, form: FormData) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", body: form });
  return res.json();
}

export interface SheetInfo {
  name: string;
  rows: number;
}

export interface ImportResult {
  ok?: boolean;
  error?: string;
  campaignId?: string | null;
  campaignName?: string;
  sheet?: string;
  totalRows?: number;
  prepared?: number;
  imported?: number;
  deduped?: number;
  badNumbers?: number;
}

export interface BrandInfo {
  name: string;
  count: number;
}

export interface TestCallBody {
  phone: string;
  name?: string;
  buildingName?: string;
  address?: string;
  city?: string;
  problemType?: string;
  violationCodes?: string;
}

export const api = {
  startCampaign: (campaignId?: string) => post("/outbound/campaign/start", { campaignId }),
  pauseCampaign: (campaignId?: string) => post("/outbound/campaign/pause", { campaignId }),
  updateCampaign: (id: string, patch: { name?: string; region?: string }) =>
    post(`/outbound/campaign/${id}/update`, patch),
  deleteCampaign: (id: string) => post(`/outbound/campaign/${id}/delete`),
  callNow: (leadId: string) => post(`/outbound/call-now/${leadId}`),
  endCall: (callId: string) => post(`/outbound/calls/${callId}/end`),
  testCall: (body: TestCallBody) => post("/outbound/test-call", body),
  importPreview: (file: File): Promise<{ sheets?: SheetInfo[]; suggested?: string | null; error?: string }> => {
    const form = new FormData();
    form.append("file", file);
    return postForm("/outbound/import/preview", form);
  },
  importLeads: (file: File, opts: { sheet: string; region?: string; campaign?: string }): Promise<ImportResult> => {
    const form = new FormData();
    form.append("file", file);
    form.append("sheet", opts.sheet);
    if (opts.region) form.append("region", opts.region);
    if (opts.campaign) form.append("campaign", opts.campaign);
    return postForm("/outbound/import", form);
  },
  brands: async (campaignId?: string | null): Promise<BrandInfo[]> => {
    const q = new URLSearchParams();
    if (campaignId) q.set("campaignId", campaignId);
    const res = await fetch(`${API_BASE}/outbound/brands?${q.toString()}`);
    const json = (await res.json()) as { brands?: BrandInfo[] };
    return json.brands ?? [];
  },
  exportUrl: (
    disposition: string | "all",
    format: "csv" | "xlsx",
    campaignId?: string | null,
    brand?: string | null,
  ) => {
    const q = new URLSearchParams({ format });
    if (disposition !== "all") q.set("disposition", disposition);
    if (campaignId) q.set("campaignId", campaignId);
    if (brand) q.set("brand", brand);
    return `${API_BASE}/outbound/export?${q.toString()}`;
  },
};
