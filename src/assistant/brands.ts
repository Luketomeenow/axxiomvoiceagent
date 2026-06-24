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
  consentPosture: ConsentPosture;
  complianceNote: string; // state-specific, drafted — verify with counsel
  voiceId?: string; // ElevenLabs voice (optional; tunable in dashboard)
  vapiPhoneNumberId?: string; // Vapi caller-ID number to dial FROM (fill in)
  assistantId?: string; // set after create-brand-assistants (or stored in DB)
}

export const BRANDS: Brand[] = [
  {
    slug: "quality",
    vapiPhoneNumberId: "a873e36d-7cdd-4715-bdf8-8ac2d75a447d",
    voiceId: "cjVigY5qzO86Huf0OWal", // Eric — smooth, trustworthy (premade; tune in dashboard)
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
    consentPosture: "all-party", // MD is a two-party-consent state
    complianceNote: "MD requires all-party recording consent; disclose recording + AI before substantive talk.",
  },
  {
    slug: "motion",
    vapiPhoneNumberId: "3bd5c212-3ce9-45db-9bab-f2c070756062",
    voiceId: "iP95p4xoKVk53GoZ742B", // Chris — charming, down-to-earth
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
    consentPosture: "all-party", // FL is a two-party-consent state (§934.03)
    complianceNote: "FL all-party recording consent + FTSA telemarketing rules; disclose recording + AI up front.",
  },
  {
    slug: "liftech",
    vapiPhoneNumberId: "42a14aec-ef5b-4e08-a516-686af3a40679",
    voiceId: "bIHbv24MWmeRgasZH58o", // Will — relaxed optimist
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
    consentPosture: "all-party", // CA: CIPA all-party consent + AB 2905 AI disclosure
    complianceNote: "Strictest: CA all-party consent (CIPA §632/§632.7) + AB 2905 AI disclosure; TCPA 8am–9pm.",
  },
  {
    slug: "axxiom-fl",
    vapiPhoneNumberId: "bf6a8555-a3e4-422f-9e80-f3f119c31565",
    voiceId: "nPczCjzI2devNBz1zQrb", // Brian — deep, resonant, comforting
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
    complianceNote: "FL all-party recording consent + FTSA; the 2028 brake mandate is a strong, accurate hook.",
  },
  {
    slug: "arizona",
    vapiPhoneNumberId: "3581c39d-69bc-4f5e-bddb-85888bd43a34",
    voiceId: "pqHfZKP75CvOlQylNhV4", // Bill — wise, mature, balanced
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
    consentPosture: "one-party", // AZ one-party recording; still disclose for trust
    complianceNote: "AZ one-party consent; still disclose recording + AI. TCPA 8am–9pm local.",
  },
  {
    slug: "ameritex",
    vapiPhoneNumberId: "66c38638-c1d3-412e-a093-69d7219590b0",
    voiceId: "onwK4e9ZLuTAKqWW03F9", // Daniel — steady broadcaster
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
    // Serves CA (Bay Area) too, so use the stricter all-party posture by default.
    consentPosture: "all-party",
    complianceNote: "TX one-party, but AmeriTex also serves CA (Bay Area) — use all-party consent to be safe; TX Ch. 302.",
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
    complianceNote: "",
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
