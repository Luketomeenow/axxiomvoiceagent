# Voices & Agent Evaluation

## Voice providers

The agents can speak with two voice providers, chosen in `src/assistant/voicePipeline.ts`:

- **Vapi native voices** (`buildVapiVoice(voiceId)`) — `{ provider: "vapi", voiceId, version: 2 }`. No external credential, lowest latency, V2 model for a human sound. **The per-brand outbound agents and the inbound agent use these.**
- **ElevenLabs** (`buildVoice(voiceId)`) — `{ provider: "11labs", model: "eleven_flash_v2_5", … }`. Used by the generic/fallback outbound assistant.

> **Important:** Vapi renders voices from **its own connected ElevenLabs/voice account**, *not* the personal `ELEVENLABS_API_KEY` in `.env`. So a custom voice that exists only in your personal ElevenLabs account (e.g. a Voice-Design voice) **will not load on Vapi assistants** — you'll get "Couldn't find 11labs voice." Vapi native voices avoid this entirely, which is why the brand + inbound agents use them.

### Vapi native voice IDs

`Clara, Elliot, Savannah, Nico, Kai, Emma, Sagar, Neil, Layla, Sid, Gustavo, Kylie, Rohan, Lily, Hana, Neha, Cole, Harry, Paige, Spencer, Naina, Leah, Tara, Jess, Leo, Dan, Mia, Zac, Zoe, Godfrey` (use the bare id — e.g. `Clara`, not "Clara New"). Per-brand assignments are in [brands.md](brands.md).

### Latency / "sounds AI" tuning (ElevenLabs path)

For the ElevenLabs-voiced assistants, `buildVoice()` uses **Flash v2.5**, `stability 0.45`, `style 0.3`, low `optimizeStreamingLatency`. The Deepgram transcriber (`buildTranscriber`) is **nova-3** with `keyterm` boosting of elevator vocabulary; `startSpeakingPlan`/`stopSpeakingPlan` use smart endpointing for fast, natural turn-taking; `buildIdleHooks` checks in on silence and ends after a few tries.

## Dashboard voice picker

The **Voice** card (`web/components/VoicePicker.tsx`) lists the account's ElevenLabs voices (needs `ELEVENLABS_API_KEY` on the backend) and lets you set a voice **independently per target** via a toggle:

- **ElevenLabs agent** → the Convai POC agent (below).
- **Vapi agent** → the env-default Vapi assistant.

Each target's choice is stored separately in `app_setting` (`elevenlabs_voice_id` / `vapi_voice_id`) and applied live by PATCHing that agent. Endpoints: `GET /outbound/voices`, `POST /outbound/voice` (`{ voiceId, target }`).

> Per-brand voices are currently set in the registry (`brands.ts`) + `create-brand-assistants`, not yet in this picker.

## ElevenLabs Conversational AI — evaluation POC

Alongside Vapi, there's a **side-by-side POC** on ElevenLabs' own agent platform, to compare quality/latency/cost without touching the Vapi production setup.

- Create/update it: `bun run create-convai-agent` (`scripts/elevenlabs/create-convai-agent.ts`) — reuses the outbound prompt + opener, needs `ELEVENLABS_API_KEY`; prints an `ELEVENLABS_AGENT_ID` for `.env`. English Convai agents require `eleven_turbo_v2`/`eleven_flash_v2` (not v2.5).
- Talk to it from the dashboard: the **"Voice AI agent"** card (`web/components/AgentSwitcher.tsx`) toggles **Vapi (phone)** vs **ElevenLabs (browser)**; the ElevenLabs side opens a live browser mic session via `@elevenlabs/react`, using a signed URL from `GET /outbound/el-agent/signed-url` (the API key stays server-side).
- It's **evaluation only** — the production campaign still runs on Vapi. Real ElevenLabs phone calls would need telephony (Twilio/SIP) wired in.
