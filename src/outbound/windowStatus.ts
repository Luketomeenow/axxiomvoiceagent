/**
 * Pre-start calling-window preview for a campaign: how many eligible leads are
 * inside their TCPA window right now, and when each timezone group opens next.
 * Mirrors the dialer's own guard (timezoneForState(lead.state) → campaign tz
 * fallback), so what the Start-confirmation popup says matches what
 * placeCall() will actually do.
 */
import { env } from "../config/env.ts";
import { db } from "./db.ts";
import { timezoneForState } from "./timezone.ts";

const PAGE = 1000;
const MAX_LEADS = 15_000;

export type WindowGroup = {
  timezone: string;
  tzLabel: string; // e.g. "PDT"
  states: string[];
  leads: number;
  localTime: string; // e.g. "6:12 AM"
  insideWindow: boolean;
  minutesUntilOpen: number; // 0 when inside
  opensAt: string | null; // ISO instant of next open (null when inside)
};

export type WindowStatus = {
  campaignId: string;
  name: string;
  brand: string | null;
  windowStart: number;
  windowEnd: number;
  totalEligible: number;
  dialableNow: number;
  waiting: number;
  sampled: boolean; // true if we stopped counting at MAX_LEADS
  groups: WindowGroup[];
};

export async function campaignWindowStatus(campaignId: string): Promise<WindowStatus | null> {
  const { data: camp, error } = await db()
    .from("campaign")
    .select("id,name,brand,timezone,call_window_start,call_window_end,max_attempts")
    .eq("id", campaignId)
    .single();
  if (error || !camp) return null;

  const windowStart = camp.call_window_start ?? env.callWindowStart;
  const windowEnd = camp.call_window_end ?? env.callWindowEnd;
  const maxAttempts = camp.max_attempts ?? env.maxCallAttempts;
  const fallbackTz = camp.timezone || env.outboundTimezone;

  // Count eligible leads per state — the same criteria the worker's lead query uses.
  const byState = new Map<string, number>();
  let sampled = false;
  for (let from = 0; ; from += PAGE) {
    if (from >= MAX_LEADS) {
      sampled = true;
      break;
    }
    const { data, error: lErr } = await db()
      .from("lead")
      .select("state")
      .eq("campaign_id", campaignId)
      .eq("dnc", false)
      .not("dial_phone", "is", null)
      .in("disposition", ["new", "queued", "no_answer", "voicemail"])
      .lt("attempts", maxAttempts)
      .range(from, from + PAGE - 1);
    if (lErr) break;
    for (const r of data ?? []) {
      const s = (r.state ?? "").trim().toUpperCase() || "?";
      byState.set(s, (byState.get(s) ?? 0) + 1);
    }
    if (!data || data.length < PAGE) break;
  }

  const now = new Date();
  const groups = new Map<string, WindowGroup & { stateSet: Set<string> }>();
  for (const [state, count] of byState) {
    const tz = timezoneForState(state) ?? fallbackTz;
    let g = groups.get(tz);
    if (!g) {
      const { hour, minute } = localHourMinute(now, tz);
      const insideWindow = hour >= windowStart && hour < windowEnd;
      const minutesUntilOpen = insideWindow
        ? 0
        : hour < windowStart
          ? (windowStart - hour) * 60 - minute
          : (24 - hour) * 60 - minute + windowStart * 60;
      g = {
        timezone: tz,
        tzLabel: tzShort(now, tz),
        states: [],
        stateSet: new Set<string>(),
        leads: 0,
        localTime: localClock(now, tz),
        insideWindow,
        minutesUntilOpen,
        opensAt: insideWindow ? null : new Date(now.getTime() + minutesUntilOpen * 60_000).toISOString(),
      };
      groups.set(tz, g);
    }
    g.leads += count;
    g.stateSet.add(state);
  }

  const list: WindowGroup[] = [...groups.values()]
    .map(({ stateSet, ...g }) => ({ ...g, states: [...stateSet].sort() }))
    .sort((a, b) => b.leads - a.leads);
  const totalEligible = list.reduce((a, g) => a + g.leads, 0);
  const dialableNow = list.filter((g) => g.insideWindow).reduce((a, g) => a + g.leads, 0);

  return {
    campaignId: camp.id,
    name: camp.name,
    brand: camp.brand ?? null,
    windowStart,
    windowEnd,
    totalEligible,
    dialableNow,
    waiting: totalEligible - dialableNow,
    sampled,
    groups: list,
  };
}

function localHourMinute(now: Date, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: num("hour"), minute: num("minute") };
}

function localClock(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(now);
}

function tzShort(now: Date, tz: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? tz
  );
}
