/**
 * Brand registry — the source of truth for per-brand outbound voice agents.
 *
 * All six are Axxiom regional brands with the same service model (repair,
 * maintenance, modernization, code compliance; 24/7; all elevator brands;
 * IUEC-certified) but different geography, local number, voice, and state
 * compliance. Each brand gets its own customized Vapi assistant generated from
 * this profile (see scripts/create-brand-assistants.ts) and the dialer routes a
 * campaign's calls to the matching brand's assistant + caller ID.
 *
 * ⚠️ DRAFT — Axxiom to verify the copy + compliance posture before live calls.
 *
 * TO FINISH WIRING (per brand):
 *   - vapiPhoneNumberId : the Vapi number this brand calls FROM (its local caller ID)
 *   - voiceId           : ElevenLabs voice (optional; falls back to the shared default,
 *                         and is tunable per brand in the dashboard voice picker)
 *   - assistantId       : filled in automatically after create-brand-assistants runs
 */

import { env } from "../config/env.ts";

/** Recording-consent posture: two-party states need explicit consent before substantive talk. */
export type ConsentPosture = "all-party" | "one-party";

export interface Brand {
  slug: string; // stable key (used for routing + storage)
  displayName: string; // what the agent says it's calling from
  legalName: string;
  agentName: string; // the persona's first name
  serviceArea: string; // spoken phrase, e.g. "the South Florida area"
  states: string[]; // routing hint (campaign.brand is the source of truth)
  localPhone: string; // human transfer line / caller-ID reference
  tollFree?: string;
  website: string;
  since?: string;
  positioning: string; // one-line brand promise
  valueProps: string[]; // talking points for the prompt
  consentPosture: ConsentPosture; // policy: all-party everywhere (safest)
  timezone: string; // IANA tz for this brand's region → drives TCPA calling hours
  complianceNote: string; // state-specific, drafted — verify with counsel
  voiceProvider?: "vapi" | "11labs"; // "vapi" = native voice (default for brands); "11labs" = ElevenLabs voiceId
  voiceId?: string; // voice id/name for the provider above (tunable in dashboard)
  vapiPhoneNumberId?: string; // Vapi caller-ID number to dial FROM (fill in)
  assistantId?: string; // set after create-brand-assistants (or stored in DB)
}

export const BRANDS: Brand[] = [
  {
    slug: "quality",
    vapiPhoneNumberId: "a873e36d-7cdd-4715-bdf8-8ac2d75a447d",
    voiceProvider: "vapi",
    voiceId: "Clara", // Vapi native — warm, professional (Mid-Atlantic polish)
    displayName: "Quality Elevator",
    legalName: "Quality Elevator, an Axxiom Elevator Company",
    agentName: "Alex",
    serviceArea: "Maryland, D.C., and Northern Virginia",
    states: ["MD", "DC", "VA"],
    localPhone: "301-779-9116",
    tollFree: "800-669-9116",
    website: "qualityelevator.com",
    positioning: "Reliability in Motion — your trusted Mid-Atlantic elevator partner",
    valueProps: [
      "24/7 emergency response",
      "IUEC-certified technicians across all major elevator brands",
      "complete code compliance & safety",
      "solutions for healthcare, hospitality, education, and more",
    ],
    consentPosture: "all-party", // MD two-party; all-party everywhere is our policy
    timezone: "America/New_York",
    complianceNote: "MD all-party recording consent (DC/VA one-party); TCPA + state calling hours 8am–9pm ET; disclose AI + recorded line up front.",
  },
  {
    slug: "motion",
    vapiPhoneNumberId: "3bd5c212-3ce9-45db-9bab-f2c070756062",
    voiceProvider: "vapi",
    voiceId: "Layla", // Vapi native — warm, bright, cheerful (South FL)
    displayName: "Motion Elevator",
    legalName: "Motion Elevator, Inc., an Axxiom Elevator Company",
    agentName: "Alex",
    serviceArea: "Broward, Miami-Dade, and Palm Beach counties",
    states: ["FL"],
    localPhone: "954-970-0020",
    website: "motionelevator.com",
    since: "1995",
    positioning: "Reliability in Motion — South Florida's trusted elevator partner since 1995",
    valueProps: [
      "serving South Florida since 1995",
      "24/7 emergency response",
      "services all elevator brands",
      "unmatched code compliance & safety, competitive pricing",
    ],
    consentPosture: "all-party", // FL two-party (§934.03)
    timezone: "America/New_York",
    complianceNote: "FL all-party recording consent (§934.03) + FTSA telemarketing/DNC; calling hours 8am–9pm ET; disclose AI + recorded line up front.",
  },
  {
    slug: "liftech",
    vapiPhoneNumberId: "42a14aec-ef5b-4e08-a516-686af3a40679",
    voiceProvider: "vapi",
    voiceId: "Sid", // Vapi native — laid-back, smooth, deep (SoCal)
    displayName: "Liftech Elevator Services",
    legalName: "Liftech Elevator Services, an Axxiom Elevator Company",
    agentName: "Alex",
    serviceArea: "the Signal Hill, Los Angeles, and Palm Desert areas",
    states: ["CA"],
    localPhone: "562-997-3639",
    website: "liftechelevator.com",
    positioning: "Reliability in Motion — minimal downtime, maximum efficiency",
    valueProps: [
      "24/7 emergency response",
      "California code + ADA compliance specialists",
      "services all elevator brands and models",
      "CA contractor license #808879",
    ],
    consentPosture: "all-party", // CA two-party (CIPA)
    timezone: "America/Los_Angeles",
    complianceNote: "Strictest: CA all-party consent (CIPA §632/§632.7) + AB 2905 AI disclosure; TCPA + CA hours 8am–9pm PT.",
  },
  {
    slug: "axxiom-fl",
    vapiPhoneNumberId: "bf6a8555-a3e4-422f-9e80-f3f119c31565",
    voiceProvider: "vapi",
    voiceId: "Kai", // Vapi native — friendly, relaxed, approachable (FL)
    displayName: "Axxiom Elevator Florida",
    legalName: "Axxiom Elevator Florida",
    agentName: "Alex",
    serviceArea: "Broward, Miami-Dade, Palm Beach, Collier, Lee, and Sarasota counties",
    states: ["FL"],
    localPhone: "954-970-0020",
    website: "axxiomelevatorfl.com",
    since: "1995",
    positioning: "Speed. Safety. Reliability. — South Florida's trusted elevator partner",
    valueProps: [
      "24/7 emergency response",
      "certified for Florida's 2028 brake upgrade mandate (ASME A17.1-2019)",
      "services all elevator brands",
      "seamless, reliable, cost-effective solutions",
    ],
    consentPosture: "all-party", // FL two-party consent
    timezone: "America/New_York",
    complianceNote: "FL all-party consent (§934.03) + FTSA; calling hours 8am–9pm ET; the 2028 brake mandate (A17.1-2019) is a strong, accurate hook.",
  },
  {
    slug: "arizona",
    vapiPhoneNumberId: "3581c39d-69bc-4f5e-bddb-85888bd43a34",
    voiceProvider: "vapi",
    voiceId: "Elliot", // Vapi native — professional, soothing, steady (AZ)
    displayName: "Arizona Elevator Solutions",
    legalName: "Arizona Elevator Solutions, an Axxiom Elevator Company",
    agentName: "Alex",
    serviceArea: "the greater Phoenix area and statewide Arizona",
    states: ["AZ"],
    localPhone: "480-557-7600",
    website: "azelevatorsolutions.com",
    since: "2007",
    positioning: "Reliability in Motion — Arizona's largest independent elevator service company",
    valueProps: [
      "up to 6× more maintenance visits than competitors",
      "Arizona's largest independent elevator service company since 2007",
      "24/7 emergency response, all brands serviced",
      "union-backed (IUEC), competitive pricing",
    ],
    consentPosture: "all-party", // AZ is one-party by law, but we use all-party everywhere (safest)
    timezone: "America/Phoenix",
    complianceNote: "AZ one-party by law, but we disclose + get consent anyway (all-party policy); AZ has no DST; calling hours 8am–9pm MST.",
  },
  {
    slug: "ameritex",
    vapiPhoneNumberId: "66c38638-c1d3-412e-a093-69d7219590b0",
    voiceProvider: "vapi",
    voiceId: "Savannah", // Vapi native — straightforward, Southern accent (Texas)
    displayName: "AmeriTex Elevator Services",
    legalName: "AmeriTex Elevator Services, Inc.",
    agentName: "Alex",
    serviceArea: "Central and South Texas, and the San Francisco Bay Area",
    states: ["TX", "CA"],
    localPhone: "844-646-9660",
    tollFree: "866-679-4313",
    website: "ameritexelevator.com",
    positioning: "Dependable, responsive, cost-effective — service programs built around your building",
    valueProps: [
      "service programs built around your building, not ours",
      "24/7 emergency response, all brands",
      "clear, competitive, no-surprises pricing",
      "best-in-class customer service across 9 industry verticals",
    ],
    // Serves CA (Bay Area, two-party) + TX — all-party posture covers both.
    consentPosture: "all-party",
    timezone: "America/Chicago",
    complianceNote: "TX one-party (Bus. & Com. Ch. 302 telemarketing) + CA Bay Area two-party (CIPA) — use all-party consent; calling hours 8am–9pm in the lead's local tz.",
  },
];

/** Generic env-derived brand — the fallback used by the original outbound assistant. */
export function defaultBrand(): Brand {
  return {
    slug: "default",
    displayName: env.companyName,
    legalName: env.companyName,
    agentName: env.agentName,
    serviceArea: env.serviceArea,
    states: [],
    localPhone: env.transferPhoneNumber || "",
    website: "",
    positioning: "Reliability in Motion",
    valueProps: ["24/7 emergency response", "services all elevator brands", "code compliance & safety"],
    consentPosture: "all-party",
    timezone: env.outboundTimezone,
    complianceNote: "",
    voiceProvider: "11labs",
    voiceId: env.elevenLabsVoiceId || undefined,
    vapiPhoneNumberId: env.vapiPhoneNumberId || undefined,
  };
}

const BY_SLUG = new Map(BRANDS.map((b) => [b.slug, b]));

export function getBrand(slug: string): Brand | undefined {
  return BY_SLUG.get(slug);
}

/** Best-effort brand for a US state code — a routing hint only (campaign.brand wins). */
export function brandForState(state: string): Brand | undefined {
  const s = state.trim().toUpperCase();
  // CA is ambiguous (Liftech SoCal vs AmeriTex Bay Area), so don't auto-pick it here.
  if (s === "CA") return undefined;
  return BRANDS.find((b) => b.states.includes(s));
}
