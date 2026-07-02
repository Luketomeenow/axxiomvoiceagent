/**
 * Per-lead calling-window timezone (TCPA is about the CALLED party's local time).
 * The campaign/brand timezone is a poor proxy — e.g. the AmeriTex brand spans
 * TX + CA on America/Chicago, so a California lead would otherwise be gated on
 * Central hours and could be dialed at 6am Pacific. We resolve the lead's own
 * timezone from its US state instead.
 *
 * Multi-zone states map to their PREDOMINANT zone (where most of the population
 * is). For stricter compliance you could intersect the windows of every zone a
 * state spans, or resolve by phone area code; state-predominant fixes the
 * concrete over-calling bug and is what most dialers use.
 */
const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  DC: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/New_York",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
};

/** IANA timezone for a US state code (e.g. "CA" → "America/Los_Angeles"), or undefined. */
export function timezoneForState(state: string | null | undefined): string | undefined {
  if (!state) return undefined;
  return STATE_TZ[state.trim().toUpperCase()];
}
