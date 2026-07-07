# Per-Brand Outbound Agents

Axxiom operates several regional elevator brands. Each gets its **own customized Vapi outbound assistant** — same proven qualification flow, but branded by company name, service area, value props, **its own Twilio caller-ID number**, voice, and **state-specific compliance**. The dialer resolves the right brand for every lead automatically; assigning a brand by hand is an optional override.

## The brands

Source of truth: **`src/assistant/brands.ts`** (the `BRANDS` registry). Caller IDs are **your own Twilio DIDs imported into Vapi** (`bun run import-twilio-numbers`) — Vapi-provided numbers have a daily outbound cap and aren't used for real campaigns.

| Brand (slug) | States | Twilio caller ID | Human transfer line | Voice (Vapi) | Calling tz |
|---|---|---|---|---|---|
| Quality Elevator (`quality`) | MD, DC, VA | +1 240 (MD) | 301-779-9116 | Clara | America/New_York |
| Motion Elevator (`motion`) | FL | +1 954 (Ft. Lauderdale) | 954-970-0020 | Layla | America/New_York |
| Liftech Elevator Services (`liftech`) | CA (SoCal) | +1 562 (Long Beach) | 562-997-3639 | Sid | America/Los_Angeles |
| Axxiom Elevator Florida (`axxiom-fl`) | FL | +1 561 (Palm Beach) | 954-970-0020 | Kai | America/New_York |
| Arizona Elevator Solutions (`arizona`) | AZ | +1 928 (Flagstaff) | 480-557-7600 | Elliot | America/Phoenix |
| AmeriTex Elevator Services (`ameritex`) | TX + CA (Bay Area) | **per state**: TX → +1 325, CA → +1 510 | 844-646-9660 | Savannah | America/Chicago |

- **AmeriTex dials per region**: its `phoneNumberByState` map picks the caller ID by the **lead's** state (TX leads see a Texas number, Bay-Area leads a 510 number); other brands use their single `vapiPhoneNumberId`.
- The exact `vapiPhoneNumberId` UUIDs live in `brands.ts`; `import-twilio-numbers` prints paste-ready lines when you register new DIDs. Caller IDs are read from the registry **at dial time**, so swapping a number doesn't require re-creating assistants.
- Each `Brand` also carries: `legalName`, `agentName` ("Alex"), `serviceArea`, `localPhone` (the human warm-transfer line), `positioning`, `valueProps[]`, `consentPosture`, `timezone`, `complianceNote`, `voiceProvider`/`voiceId`, and optional `tollFree`/`website`/`since`.

> ⚠️ The registry copy + compliance notes are marked **DRAFT** in `brands.ts` — Axxiom must verify wording and posture with counsel before live calls.

## How a brand becomes a live agent

`scripts/create-brand-assistants.ts` loops the registry and **creates or updates one Vapi assistant per brand**, storing each assistant id in `outbound.app_setting` under `brand_assistant:<slug>` (so the dialer can find it). It requires the `outbound` schema migration applied first (it preflights).

```bash
bun run create-brand-assistants            # all brands
bun run create-brand-assistants quality    # one brand by slug
# or: npm run create-brand-assistants:node
```

Each generated assistant reuses the shared outbound pipeline but is **brand-customized**:
- **Prompt** — `buildOutboundSystemPrompt(brand)` injects the brand's name, agent name, service area, value props, and consent rule (`src/assistant/outbound/prompt.ts`). If an AI-proposed prompt improvement has been **approved** for the brand (see [outbound-campaigns.md](outbound-campaigns.md)), the `brand_prompt:<slug>` override in `app_setting` is used instead — approved prompts survive re-runs and redeploys.
- **Opener** — `buildOutboundFirstMessage(brand)` is a **deterministic first message** (assistant speaks first) disclosing the AI + recorded line before anything substantive, then leads with the building's verified overdue/expired status.
- **Voice** — a **Vapi native voice** (see [voices.md](voices.md)); no ElevenLabs credential needed.
- **Warm transfer** — `transferCall` routes to the brand's own `localPhone` (normalized to E.164).
- **Tools** — `confirmConsent`, `qualifyLead`, `recordDisposition`, `optOut`, `lookupViolationCode`, `endCall`, `transferCall` (see [api-reference.md](api-reference.md)). **Re-run this script after pulling tool changes** so new tools (e.g. `confirmConsent`) reach each assistant.

## Routing: how a lead gets its brand

Nobody has to pick a brand by hand — resolution is automatic, in priority order (`resolveBrand()` in `brands.ts`):

1. **Explicit campaign brand** — `campaign.brand`, if set (dashboard override or auto-assigned).
2. **The lead's `servicing_brand`** — matched by `brandByName()` (exact slug/display/legal name, then a loose distinguishing-word match). This is what disambiguates the multi-brand states.
3. **The lead's `state`** — `brandForState()`. **CA deliberately returns no match** (Liftech SoCal vs. AmeriTex Bay Area is ambiguous — those leads need a `servicing_brand` or an explicit campaign brand). FL also has two brands (Motion, Axxiom FL), so prefer `servicing_brand` there too.

If nothing resolves, the call falls back to the generic env-default assistant + `VAPI_PHONE_NUMBER_ID`.

**`autoAssignCampaignBrand()`** (in `dialer.ts`) runs after **every import** and on **every campaign start**: it tallies which brand the campaign's leads resolve to, writes the winner to `campaign.brand` + the brand's `timezone`, and never overwrites a brand you set manually. The dashboard's **"Brand agent + caller ID"** dropdown is therefore just an optional override — "Auto" means "resolve from the leads."

At dial time, `routingForBrand(brand, lead.state)` picks the assistant id (from `app_setting`) and the caller ID (`phoneNumberByState[state]` when defined, else the brand's `vapiPhoneNumberId`).

## Per-brand compliance

Each brand declares a `consentPosture` and `timezone` that drive behavior:
- **Consent** — policy is **all-party everywhere** (every brand requires explicit recorded-line consent, captured by the `confirmConsent` tool, before qualifying) — the safest posture across mixed states.
- **Calling hours** — enforced in the **lead's own timezone** (`timezoneForState(lead.state)`), falling back to the campaign timezone (set from the brand). See [compliance.md](compliance.md).
- `complianceNote` documents each brand's state specifics (CA CIPA + AB 2905, FL §934.03 + FTSA, TX Bus. & Com. Ch. 302, AZ one-party/no-DST, MD all-party) — **drafted; verify with counsel.**

## Changing a brand

Edit `src/assistant/brands.ts` (name, value props, voice, compliance) and re-run `create-brand-assistants` (it PATCHes existing assistants by their stored id). Caller-ID swaps only need the new `vapiPhoneNumberId` in the registry (register the DID first with `import-twilio-numbers`) — no assistant re-run required. To swap just a voice, see [voices.md](voices.md).

> The generic env-configured outbound assistant (`OUTBOUND_ASSISTANT_ID`) still exists as the **fallback/default** for any lead/campaign that resolves to no brand, and for `test-call`s without a `brand`. Its voice is the dashboard voice-picker choice when set, else `ELEVENLABS_VOICE_ID` (ElevenLabs path — see [voices.md](voices.md)).
