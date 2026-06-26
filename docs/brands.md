# Per-Brand Outbound Agents

Axxiom operates several regional elevator brands. Each gets its **own customized Vapi outbound assistant** — same proven qualification flow, but branded by company name, service area, value props, **local caller-ID number**, voice, and **state-specific compliance**. A campaign is tagged with a brand, and the dialer routes that campaign's calls to the matching brand's assistant + caller ID.

## The brands

Source of truth: **`src/assistant/brands.ts`** (the `BRANDS` registry).

| Brand (slug) | Region | Local caller ID | Voice (Vapi) | Calling tz |
|---|---|---|---|---|
| Quality Elevator (`quality`) | MD / DC / N. Virginia | 301-779-9116 | Clara | America/New_York |
| Motion Elevator (`motion`) | South FL (Broward/Dade/Palm Beach) | 954-970-0020 | Layla | America/New_York |
| Liftech Elevator (`liftech`) | CA — Signal Hill / LA / Palm Desert | 562-997-3639 | Sid | America/Los_Angeles |
| Axxiom Elevator FL (`axxiom-fl`) | South + SW FL | 954-970-0020 | Kai | America/New_York |
| Arizona Elevator Solutions (`arizona`) | Arizona | 480-557-7600 | Elliot | America/Phoenix |
| AmeriTex Elevator (`ameritex`) | Central/S Texas + SF Bay Area | 844-646-9660 | Savannah | America/Chicago |

Each `Brand` carries: `slug`, `displayName`, `legalName`, `agentName`, `serviceArea`, `states[]`, `localPhone` (warm-transfer line), `positioning`, `valueProps[]`, `consentPosture`, `timezone`, `complianceNote`, `voiceProvider`/`voiceId`, `vapiPhoneNumberId` (caller ID), and `assistantId` (stored in the DB after creation).

## How a brand becomes a live agent

`scripts/create-brand-assistants.ts` loops the registry and **creates or updates one Vapi assistant per brand**, storing each assistant id in `outbound.app_setting` under `brand_assistant:<slug>` (so the dialer can find it). It requires the `outbound` schema migration applied first (it preflights).

```bash
bun run create-brand-assistants            # all brands
bun run create-brand-assistants quality    # one brand by slug
# or: npm run create-brand-assistants:node
```

Each generated assistant reuses the shared outbound pipeline but is **brand-customized**:
- **Prompt** — `buildOutboundSystemPrompt(brand)` injects the brand's name, agent name, service area, value props, and consent rule (`src/assistant/outbound/prompt.ts`).
- **Opener** — `buildOutboundFirstMessage(brand)` discloses AI + recorded line and leads with the building's verified overdue/expired status.
- **Voice** — a **Vapi native voice** (see [voices.md](voices.md)); no ElevenLabs credential needed.
- **Warm transfer** — `transferCall` routes to the brand's own `localPhone` (normalized to E.164).
- **Tools** — `qualifyLead`, `recordDisposition`, `optOut`, `lookupViolationCode`, `endCall`, `transferCall` (see [api-reference.md](api-reference.md)).

## Routing: campaign → brand

Which brand calls a lead is **geographic**, decided per campaign (not by the lead's `servicing_brand`, which is the *incumbent* servicer). Each `outbound.campaign` has a `brand` column.

- Assign a brand in the dashboard: the **Campaign controls** card has a *"Brand agent + caller ID"* dropdown (fed by `GET /outbound/brand-list`). Selecting one calls `POST /outbound/campaign/:id/update` with `{ brand }` — which also sets the campaign's `timezone` from the brand so calling hours match the region.
- At dial time, `src/outbound/dialer.ts` → `brandRoutingFor(campaignId)` looks up the campaign's brand → the brand's `assistantId` (from `app_setting`) + `vapiPhoneNumberId`, and dials with those. **Fallback:** if a campaign has no brand (or the brand assistant isn't created yet), it uses the env default assistant + number (`OUTBOUND_ASSISTANT_ID` / `VAPI_PHONE_NUMBER_ID`).

## Per-brand compliance

Each brand declares a `consentPosture` and `timezone` that drive behavior:
- **Consent** — policy is **all-party everywhere** (every brand requires explicit recorded-line consent before qualifying), the safest posture across mixed states. The prompt's `consentRule` enforces it.
- **Calling hours** — the campaign worker honors the campaign `timezone` (set from the brand), so each region dials only within its local TCPA window.
- `complianceNote` documents each brand's state specifics (CA CIPA + AB 2905, FL §934.03 + FTSA, TX Bus. & Com. Ch. 302, AZ no-DST, MD all-party) — **drafted; verify with counsel.** See [compliance.md](compliance.md).

## Changing a brand

Edit `src/assistant/brands.ts` (name, value props, voice, phone, compliance) and re-run `create-brand-assistants` (it PATCHes existing assistants by their stored id). To swap just a voice, see [voices.md](voices.md).

> The generic env-configured outbound assistant (`OUTBOUND_ASSISTANT_ID`) still exists as the **fallback/default** for any campaign without a brand.
