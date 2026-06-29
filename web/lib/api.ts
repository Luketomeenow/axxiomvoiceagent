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

export interface VoiceOption {
  voiceId: string;
  name: string;
  category?: string;
  previewUrl?: string;
}

export type VoiceTarget = "vapi" | "elevenlabs";

export interface VoicesResponse {
  voices: VoiceOption[];
  current: Record<VoiceTarget, string>;
  error?: string;
}

export interface BrandInfoOption {
  slug: string;
  displayName: string;
  serviceArea: string;
}

export interface TestCallBody {
  phone: string;
  name?: string;
  buildingName?: string;
  address?: string;
  city?: string;
  problemType?: string;
  violationCodes?: string;
  brand?: string; // optional brand slug → test that brand's agent (voice + caller ID)
}

// --- Analytics (tracking dashboard) ---------------------------------------

export interface FunnelRow {
  campaign_id: string;
  name: string;
  region: string | null;
  brand: string | null;
  status: string;
  total_leads: number;
  contacted: number;
  qualified: number;
  needs_followup: number;
  not_interested: number;
  no_contact: number;
  removed: number;
  dnc_flagged: number;
  total_attempts: number;
}

export interface QualityRow {
  campaign_id: string | null;
  brand: string | null;
  calls: number;
  completed: number;
  avg_duration_seconds: number | null;
  avg_sentiment: number | null;
  transferred: number;
  voicemail: number;
  no_answer: number;
  failed: number;
}

export interface DailyRow {
  day: string;
  campaign_id: string | null;
  calls: number;
  qualified: number;
  transferred: number;
  voicemail: number;
  no_answer: number;
  failed: number;
  avg_duration_seconds: number | null;
}

export interface AttemptRow {
  campaign_id: string | null;
  attempts: number;
  leads: number;
  qualified: number;
}

export interface AnalyticsResponse {
  funnel: FunnelRow[];
  quality: QualityRow[];
  daily: DailyRow[];
  attempts: AttemptRow[];
  unresolvedFailures: number;
  days: number;
  error?: string;
}

export interface ComplianceRow {
  call_id: string;
  campaign_id: string | null;
  phone_number: string | null;
  brand: string | null;
  started_at: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  disposition: string | null;
  transferred_to_human: boolean | null;
  disclosure_logged: boolean;
  disclosure_event: boolean;
  consent_captured: boolean | null;
  consent_event: boolean;
  consent_at: string | null;
}

export interface ComplianceResponse {
  rows: ComplianceRow[];
  summary: { total: number; disclosed: number; consented: number };
  error?: string;
}

export const api = {
  analytics: async (campaignId?: string | null, days = 30): Promise<AnalyticsResponse> => {
    const q = new URLSearchParams({ days: String(days) });
    if (campaignId) q.set("campaignId", campaignId);
    const res = await fetch(`${API_BASE}/outbound/analytics?${q.toString()}`);
    return res.json();
  },
  compliance: async (campaignId?: string | null, limit = 100): Promise<ComplianceResponse> => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (campaignId) q.set("campaignId", campaignId);
    const res = await fetch(`${API_BASE}/outbound/analytics/compliance?${q.toString()}`);
    return res.json();
  },
  startCampaign: (campaignId?: string) => post("/outbound/campaign/start", { campaignId }),
  pauseCampaign: (campaignId?: string) => post("/outbound/campaign/pause", { campaignId }),
  updateCampaign: (id: string, patch: { name?: string; region?: string; brand?: string }) =>
    post(`/outbound/campaign/${id}/update`, patch),
  deleteCampaign: (id: string) => post(`/outbound/campaign/${id}/delete`),
  brandList: async (): Promise<BrandInfoOption[]> => {
    const res = await fetch(`${API_BASE}/outbound/brand-list`);
    const json = (await res.json()) as { brands?: BrandInfoOption[] };
    return json.brands ?? [];
  },
  callNow: (leadId: string) => post(`/outbound/call-now/${leadId}`),
  endCall: (callId: string) => post(`/outbound/calls/${callId}/end`),
  testCall: (body: TestCallBody) => post("/outbound/test-call", body),
  getVoices: async (): Promise<VoicesResponse> => {
    const res = await fetch(`${API_BASE}/outbound/voices`);
    return res.json();
  },
  setVoice: (voiceId: string, target: VoiceTarget) => post("/outbound/voice", { voiceId, target }),
  elAgentSignedUrl: async (): Promise<{ ok: boolean; signedUrl?: string; agentId?: string; error?: string }> => {
    const res = await fetch(`${API_BASE}/outbound/el-agent/signed-url`);
    return res.json();
  },
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
