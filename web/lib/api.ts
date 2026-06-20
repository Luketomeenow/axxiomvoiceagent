import { API_BASE } from "./supabase";

async function post(path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const api = {
  startCampaign: (campaignId?: string) => post("/outbound/campaign/start", { campaignId }),
  pauseCampaign: (campaignId?: string) => post("/outbound/campaign/pause", { campaignId }),
  callNow: (leadId: string) => post(`/outbound/call-now/${leadId}`),
  exportUrl: (disposition: string | "all", format: "csv" | "xlsx") => {
    const q = new URLSearchParams({ format });
    if (disposition !== "all") q.set("disposition", disposition);
    return `${API_BASE}/outbound/export?${q.toString()}`;
  },
};
