import { API_BASE } from "./supabase";

async function post(path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
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
  callNow: (leadId: string) => post(`/outbound/call-now/${leadId}`),
  testCall: (body: TestCallBody) => post("/outbound/test-call", body),
  exportUrl: (disposition: string | "all", format: "csv" | "xlsx", campaignId?: string | null) => {
    const q = new URLSearchParams({ format });
    if (disposition !== "all") q.set("disposition", disposition);
    if (campaignId) q.set("campaignId", campaignId);
    return `${API_BASE}/outbound/export?${q.toString()}`;
  },
};
