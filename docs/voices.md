# Voices & Agent Evaluation

## Voice providers

The agents can speak with two voice providers, chosen in `src/assistant/voicePipeline.ts`:

- **Vapi native voices** (`buildVapiVoice(voiceId)`) — `{ provider: "vapi", voiceId, version: 2 }`. No external credential, lowest latency, V2 model for a human sound. **The per-brand outbound agents and the inbound agent use these.**
- **ElevenLabs** (`buildVoice(voiceId)`) — `{ provider: "11labs", model: "eleven_flash_v2_5", … }`. **No Vapi agent uses it today**; it's only for the ElevenLabs evaluation agent below. (The generic/fallback outbound assistant moved to Vapi's "Elliot" in October 2026; see the note.)

> **Important:** Vapi renders voices from **its own connected ElevenLabs/voice account**, *not* the personal `ELEVENLABS_API_KEY` in `.env`. So a custom voice that exists only in your personal ElevenLabs account (e.g. a Voice-Design voice) **will not load on Vapi assistants** — you'll get "Couldn't find 11labs voice." Vapi native voices avoid this entirely, which is why every Vapi agent uses them. Worse than a missing voice: Vapi **rejects the whole assistant update**, so the assistant sync can't push anything else to that assistant either (this kept the generic agent on its August config, and on the old Railway webhook, until it was switched to "Elliot").

### Vapi native voice IDs

`Clara, Elliot, Savannah, Nico, Kai, Emma, Sagar, Neil, Layla, Sid, Gustavo, Kylie, Rohan, Lily, Hana, Neha, Cole, Harry, Paige, Spencer, Naina, Leah, Tara, Jess, Leo, Dan, Mia, Zac, Zoe, Godfrey` (use the bare id — e.g. `Clara`, not "Clara New"). Per-brand assignments are in [brands.md](brands.md).

### Latency / "sounds AI" tuning (ElevenLabs path)

For the ElevenLabs-voiced assistants, `buildVoice()` uses **Flash v2.5**, `stability 0.45`, `style 0.3`, low `optimizeStreamingLatency`. The Deepgram transcriber (`buildTranscriber`) is **nova-3** with `keyterm` boosting of elevator vocabulary; `startSpeakingPlan`/`stopSpeakingPlan` use smart endpointing for fast, natural turn-taking; `buildIdleHooks` checks in on silence and ends after a few tries.

## Dashboard voice picker

The **ElevenLabs agent voice** card (`web/components/VoicePicker.tsx`) lists the account's ElevenLabs voices (needs `ELEVENLABS_API_KEY` on the backend) and sets the voice of the **ElevenLabs evaluation agent** (below), stored as `elevenlabs_voice_id` in `app_setting` and applied live. Endpoints: `GET /outbound/voices`, `POST /outbound/voice` (`{ voiceId, target: "elevenlabs" }`).

The **Vapi phone agents' voices are set in code**, not in the picker: each brand's `voiceId` in `src/assistant/brands.ts` (the generic agent is the `default` brand → "Elliot"), optionally overridden per slug by `brand_voice:<slug>` in `app_setting` (no UI; slug `default` = the generic agent). Change one, deploy, then **Re-sync Vapi assistants**. `POST /outbound/voice` with `target: "vapi"` is refused with that explanation. (The old picker option applied ElevenLabs voices to the generic agent; its `vapi_voice_id` setting is no longer read.)

## ElevenLabs Conversational AI — evaluation POC

Alongside Vapi, there's a **side-by-side POC** on ElevenLabs' own agent platform, to compare quality/latency/cost without touching the Vapi production setup.

- Create/update it: `bun run create-convai-agent` (`scripts/elevenlabs/create-convai-agent.ts`) — reuses the outbound prompt + opener, needs `ELEVENLABS_API_KEY`; prints an `ELEVENLABS_AGENT_ID` for `.env`. English Convai agents require `eleven_turbo_v2`/`eleven_flash_v2` (not v2.5).
- Talk to it from the dashboard: the **"Voice AI agent"** card (`web/components/AgentSwitcher.tsx`) toggles **Vapi (phone)** vs **ElevenLabs (browser)**; the ElevenLabs side opens a live browser mic session via `@elevenlabs/react`, using a signed URL from `GET /outbound/el-agent/signed-url` (the API key stays server-side).
- It's **evaluation only** — the production campaign still runs on Vapi. Real ElevenLabs phone calls would need telephony (Twilio/SIP) wired in.
