import { API_BASE, getAccessToken, supabase } from "./supabase";

/** Merge the signed-in user's JWT into request headers (Authorization: Bearer). */
async function authHeaders(base: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

// A 401 means the session is gone (expired/revoked) — every subsequent call
// would fail the same way, so sign out once and send the user to /login.
let redirectingToLogin = false;
async function handleUnauthorized(path: string): Promise<never> {
  if (!redirectingToLogin && typeof window !== "undefined") {
    redirectingToLogin = true;
    await supabase.auth.signOut().catch(() => {});
    window.location.assign("/login");
  }
  throw new Error(`API ${path} → 401 (session expired)`);
}

/**
 * Shared request wrapper: every call gets a timeout (a hung backend must not
 * hang the panel), 401s redirect to login, and network/timeout/non-JSON
 * failures throw a labeled Error. Other non-ok statuses still RESOLVE with the
 * parsed JSON body — callers pattern-match `{ok:false, reason}` / `{error}`.
 */
async function request(path: string, init: RequestInit, timeoutMs: number) {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new Error(`API ${path} → ${timedOut ? `timeout after ${timeoutMs}ms` : "network error"}`);
  }
  if (res.status === 401) return handleUnauthorized(path);
  try {
    return await res.json();
  } catch {
    throw new Error(`API ${path} → ${res.status} (invalid response)`);
  }
}

async function get(path: string) {
  return request(path, { headers: await authHeaders() }, 15_000);
}

async function post(path: string, body?: unknown) {
  return request(
    path,
    {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: body ? JSON.stringify(body) : undefined,
    },
    15_000,
  );
}

async function postForm(path: string, form: FormData) {
  // Uploads (lead workbooks) get a longer window.
  return request(path, { method: "POST", headers: await authHeaders(), body: form }, 30_000);
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
  connected: number;
  avg_duration_seconds: number | null;
  avg_talk_seconds: number | null;
  avg_sentiment: number | null;
  transferred: number;
  voicemail: number;
  no_answer: number;
  ivr: number;
  failed: number;
  stale: number;
  ended_customer: number;
  ended_agent: number;
  ended_operator: number;
  ended_system: number;
  // Twilio AMD (present only when machine detection is on) + carrier status.
  answered_human?: number;
  answered_machine?: number;
  answered_fax?: number;
  status_completed?: number;
  status_busy?: number;
  status_no_answer?: number;
  status_failed?: number;
  status_canceled?: number;
  vapi_cost: number | null;
  telephony_cost: number | null;
  total_cost: number | null;
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

export interface HourlyRow {
  campaign_id: string | null;
  hour_pt: number; // 0-23, Pacific
  calls: number;
  connected: number;
  qualified: number;
  reached_machine: number;
}

export interface AnalyticsSummary {
  totalCost: number;
  qualified: number;
  costPerQualified: number | null;
  connectRate: number | null;
  reachedMachine: number;
}

export interface AnalyticsResponse {
  funnel: FunnelRow[];
  quality: QualityRow[];
  daily: DailyRow[];
  attempts: AttemptRow[];
  hourly: HourlyRow[];
  summary?: AnalyticsSummary;
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

// Remaining provider balances (Twilio money, Vapi credits), from GET /outbound/balances.
export interface ProviderBalance {
  ok: boolean;
  balance?: number;
  currency?: string;
  detail?: string;
  error?: string;
}

export interface BalancesResponse {
  twilio: ProviderBalance;
  vapi: ProviderBalance;
  fetchedAt: string;
}

export type WindowStatusGroup = {
  timezone: string;
  tzLabel: string;
  states: string[];
  leads: number;
  localTime: string;
  insideWindow: boolean;
  minutesUntilOpen: number;
  opensAt: string | null;
};

export type WindowStatus = {
  ok: boolean;
  campaignId: string;
  name: string;
  brand: string | null;
  windowStart: number;
  windowEnd: number;
  totalEligible: number;
  dialableNow: number;
  waiting: number;
  sampled: boolean;
  groups: WindowStatusGroup[];
};

let brandListPromise: Promise<BrandInfoOption[]> | null = null;

export const api = {
  analytics: (campaignId?: string | null, days = 30): Promise<AnalyticsResponse> => {
    const q = new URLSearchParams({ days: String(days) });
    if (campaignId) q.set("campaignId", campaignId);
    return get(`/outbound/analytics?${q.toString()}`);
  },
  compliance: (campaignId?: string | null, limit = 100): Promise<ComplianceResponse> => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (campaignId) q.set("campaignId", campaignId);
    return get(`/outbound/analytics/compliance?${q.toString()}`);
  },
  startCampaign: (campaignId?: string, opts?: { maxCalls?: number | null; maxConcurrent?: number }) =>
    post("/outbound/campaign/start", { campaignId, ...opts }),
  windowStatus: (campaignId: string): Promise<WindowStatus> =>
    get(`/outbound/campaign/${campaignId}/window-status`) as Promise<WindowStatus>,
  pauseCampaign: (campaignId?: string) => post("/outbound/campaign/pause", { campaignId }),
  updateCampaign: (
    id: string,
    patch: { name?: string; region?: string; brand?: string; maxConcurrent?: number; maxCalls?: number | null },
  ) => post(`/outbound/campaign/${id}/update`, patch),
  deleteCampaign: (id: string) => post(`/outbound/campaign/${id}/delete`),
  brandList: async (): Promise<BrandInfoOption[]> => {
    // BRANDS is static server config — memo the promise so the several panels
    // that need it on page load share one request (reset on failure to allow retry).
    if (!brandListPromise) {
      brandListPromise = get(`/outbound/brand-list`)
        .then((json: { brands?: BrandInfoOption[] }) => json.brands ?? [])
        .catch((err) => {
          brandListPromise = null;
          throw err;
        });
    }
    return brandListPromise;
  },
  // Continuous improvement (per-brand transcript analysis + self-learning).
  // Slug "default" = the generic/fallback outbound agent.
  analyzeBrand: (slug: string) => post(`/outbound/brand/${encodeURIComponent(slug)}/analyze`),
  brandInsights: async (slug: string): Promise<import("./types").CampaignInsight[]> => {
    const json = (await get(`/outbound/brand/${encodeURIComponent(slug)}/insights`)) as {
      insights?: import("./types").CampaignInsight[];
    };
    return json.insights ?? [];
  },
  // System-level analysis: the whole operation (reach, funnel, failures, cost).
  analyzeSystem: () => post(`/outbound/system/analyze`),
  systemInsights: async (): Promise<import("./types").CampaignInsight[]> => {
    const json = (await get(`/outbound/system/insights`)) as { insights?: import("./types").CampaignInsight[] };
    return json.insights ?? [];
  },
  approveInsight: (id: string, approvedBy?: string) => post(`/outbound/insights/${id}/approve`, { approvedBy }),
  rejectInsight: (id: string) => post(`/outbound/insights/${id}/reject`),
  // Remaining balances on Twilio + Vapi (cached 60s server-side).
  balances: (): Promise<BalancesResponse> => get(`/outbound/balances`),
  // Reconcile authoritative telephony cost/status from Twilio onto call rows.
  syncTwilio: (campaignId?: string | null) =>
    post(`/outbound/twilio/sync${campaignId ? `?campaignId=${campaignId}` : ""}`),
  callNow: (leadId: string) => post(`/outbound/call-now/${leadId}`),
  endCall: (callId: string) => post(`/outbound/calls/${callId}/end`),
  testCall: (body: TestCallBody) => post("/outbound/test-call", body),
  getVoices: (): Promise<VoicesResponse> => get(`/outbound/voices`),
  setVoice: (voiceId: string, target: VoiceTarget) => post("/outbound/voice", { voiceId, target }),
  elAgentSignedUrl: (): Promise<{ ok: boolean; signedUrl?: string; agentId?: string; error?: string }> =>
    get(`/outbound/el-agent/signed-url`),
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
    const json = (await get(`/outbound/brands?${q.toString()}`)) as { brands?: BrandInfo[] };
    return json.brands ?? [];
  },
  // Authenticated download: a bearer header can't ride a bare <a href>, so fetch
  // the export with the JWT and trigger a client-side blob download.
  exportDownload: async (
    disposition: string | "all",
    format: "csv" | "xlsx",
    campaignId?: string | null,
    brand?: string | null,
  ): Promise<void> => {
    const q = new URLSearchParams({ format });
    if (disposition !== "all") q.set("disposition", disposition);
    if (campaignId) q.set("campaignId", campaignId);
    if (brand) q.set("brand", brand);
    const res = await fetch(`${API_BASE}/outbound/export?${q.toString()}`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401) return handleUnauthorized("/outbound/export");
    if (!res.ok) throw new Error(`export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const cd = res.headers.get("Content-Disposition") ?? "";
    a.download = cd.match(/filename="?([^"]+)"?/)?.[1] ?? `axxiom_leads.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
