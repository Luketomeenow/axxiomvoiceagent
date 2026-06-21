# Compliance (CA Outbound)

These controls are **built in**, but **must be reviewed with counsel before going live**. They are enforced in code (`src/outbound/dialer.ts`, `src/outbound/handlers.ts`, and the prompt in `src/assistant/outbound/prompt.ts`), not just in the prompt.

## Implemented

- [x] **AI disclosure (CA AB 2905)** — the assistant's first message states it's an AI assistant on a recorded line *before* any substantive conversation. The opener is in `buildOutboundFirstMessage()`.
  - *Strictest posture:* deliver this opener as a recorded human-voice clip rather than synthesized speech.
- [x] **All-party recording consent (CIPA §632 / §632.7)** — disclosure precedes the conversation; if the person declines, the agent calls `optOut` and ends. Every call writes an append-only `outbound.call_event` audit trail (disclosure ordering, consent moment, transcript).
- [x] **Calling hours (TCPA, 8am–9pm local)** — enforced by the dialer per the lead's timezone; the campaign worker won't dial outside the window. (Manual "call now" and test calls bypass the *window* by operator discretion but still honor DNC.)
- [x] **Do-not-call / opt-out** — `outbound.dnc_suppression` is checked before *every* dial (worker, call-now, and test calls). `optOut` adds the number and marks the lead `dnc`. The DNC check fails closed (suppresses) on error.

## Open items — confirm before launch

- [ ] **CA telephonic seller registration / $100k bond (B&P §17511)** — confirm whether a B2B exemption applies to these calls. **Not auto-handled.**
- [ ] **Consent standard** — TCPA consent rules are in flux (post-*McLaughlin* / *Bradford*). Confirm your legal basis for calling these numbers.
- [ ] **Dashboard PII exposure** — the dashboard currently reads with the Supabase anon key under permissive RLS. Before production, put it behind auth and tighten the read policies to `authenticated` (see [database.md](database.md)).

## Where each control lives

| Control | Code |
|---------|------|
| AI + recording disclosure (opener) | `src/assistant/outbound/prompt.ts` → `buildOutboundFirstMessage()` |
| Calling-window enforcement | `src/outbound/dialer.ts` → `isWithinCallingWindow()` |
| DNC check before dial | `src/outbound/dialer.ts` (`placeCall`/`testCall`) + `src/outbound/db.ts` → `isSuppressed()` |
| Opt-out handling | `src/outbound/handlers.ts` → `runOptOut()` + `suppressNumber()` |
| Audit trail | `outbound.call_event` via `recordEvent()` |
