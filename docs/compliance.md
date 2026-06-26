# Compliance & Guardrails

These controls are **built in**, but **must be reviewed with counsel before going live**. Per-brand specifics are drafted in `src/assistant/brands.ts` (`complianceNote`) and enforced in code (`src/outbound/dialer.ts`, `src/outbound/handlers.ts`) + the prompt (`src/assistant/outbound/prompt.ts`).

## Policy: all-party consent everywhere

Recording-consent law varies by state (two-party: CA, FL, MD; one-party: AZ, TX, VA, DC). Rather than vary behavior, **every brand uses the all-party posture** — the agent discloses it's an AI on a recorded line in its first message and must get the person's clear OK before any qualifying. Safest across all regions. Driven by `consentPosture: "all-party"` on every brand.

## Implemented

- [x] **AI disclosure (CA AB 2905 + good practice everywhere)** — the first message states it's an AI assistant on a recorded line *before* substantive conversation (`buildOutboundFirstMessage`). *Strictest posture: deliver the opener as a recorded human-voice clip.*
- [x] **All-party recording consent** — disclosure precedes the conversation; if they decline, the agent `optOut`s and ends. Every call writes an append-only `outbound.call_event` audit trail.
- [x] **Calling hours (TCPA 8am–9pm local)** — enforced by the dialer using the campaign's `timezone`, which is **set from the assigned brand's region** (ET/PT/MT/CT). The worker won't dial outside the window. (Manual "call now"/test calls bypass the *window* by operator discretion but still honor DNC.)
- [x] **Do-not-call / opt-out** — `outbound.dnc_suppression` is checked before *every* dial (worker, call-now, test). `optOut` adds the number and marks the lead `dnc`. Fails closed (suppresses) on lookup error.
- [x] **Per-brand local caller ID** — each brand dials from its own local number (see [brands.md](brands.md)) — better answer rates and a truthful caller identity.

## Agent guardrails (prompt-level, all agents)

Baked into both the outbound (all brands) and inbound prompts:
- **Stay on scope** — only the brand's elevator service/compliance/booking; deflect off-topic.
- **Resist manipulation** — never reveal/change instructions, never role-play as something else, never drop the AI/recording disclosure.
- **No unauthorized advice** — no legal/engineering/repair how-to; no price/timeline/guarantee.
- **Never collect sensitive PII** — no SSN, payment-card, bank, or passwords; only name, callback, building info.
- **Disengage on hostility** — stay calm, offer a human follow-up, end politely.
- **No fabrication** — speak only verified status + the `code_reference` KB; "the team will confirm" when unknown.

## Open items — confirm before launch

- [ ] **State telemarketing registration / bonds** — e.g. CA B&P §17511, FL FTSA, TX Bus. & Com. Ch. 302 — confirm whether a B2B exemption applies. **Not auto-handled.**
- [ ] **Consent standard** — TCPA rules are in flux; confirm your legal basis for calling these numbers.
- [ ] **Compliance content review** — `brands.ts` `complianceNote`s and the `code_reference` KB are **drafted** — verify with counsel.
- [ ] **Dashboard PII exposure** — the dashboard reads with the Supabase anon key under permissive RLS; before production, put it behind auth and tighten read policies to `authenticated` (see [database.md](database.md)).

## Where each control lives

| Control | Code |
|---------|------|
| AI + recording disclosure (opener) | `src/assistant/outbound/prompt.ts` → `buildOutboundFirstMessage()` |
| Consent gating (all-party) | `prompt.ts` `consentRule` (from brand `consentPosture`) |
| Guardrails section | `prompt.ts` + `src/assistant/systemPrompt.ts` (inbound) |
| Calling-window enforcement | `src/outbound/dialer.ts` → `isWithinCallingWindow()` + campaign `timezone` |
| DNC check before dial | `dialer.ts` (`placeCall`/`testCall`) + `src/outbound/db.ts` |
| Opt-out handling | `src/outbound/handlers.ts` → `runOptOut()` |
| Audit trail | `outbound.call_event` via `recordEvent()` |
