"use client";

import { useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { api } from "@/lib/api";

/**
 * Switch which voice AI agent to evaluate, from the dashboard:
 *  - Vapi (Claude): your production agent — placed over the phone via the Test card.
 *  - ElevenLabs: the POC Conversational AI agent — talk to it right here in the browser
 *    (mic), so you can A/B the voice/latency without setting up telephony.
 * The API key stays server-side (the backend issues a signed URL).
 *
 * @elevenlabs/react requires useConversation() to live inside a ConversationProvider,
 * so the hook usage is in an inner component.
 */
export function AgentSwitcher() {
  return (
    <ConversationProvider>
      <AgentSwitcherInner />
    </ConversationProvider>
  );
}

function AgentSwitcherInner() {
  const [provider, setProvider] = useState<"vapi" | "elevenlabs">("vapi");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversation = useConversation({ onError: (e: unknown) => setError(String(e)) });
  const status = conversation.status; // "disconnected" | "connecting" | "connected" | "error"
  const live = status === "connecting" || status === "connected";

  async function startEl() {
    setError(null);
    setBusy(true);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }); // prompt mic permission
      const r = await api.elAgentSignedUrl();
      if (!r.ok || !r.signedUrl) {
        setError(r.error ?? "Could not start session (is ELEVENLABS_AGENT_ID set + backend deployed?)");
        return;
      }
      conversation.startSession({ signedUrl: r.signedUrl, connectionType: "websocket" });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function stopEl() {
    conversation.endSession();
  }

  return (
    <div className="card card-pad">
      <h2 className="section-title">Voice AI agent</h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Pick which agent to try. Switching here is for evaluation only — your live campaign still runs on Vapi.
      </p>

      <div className="mt-3 inline-flex rounded-lg border border-white/10 bg-ink p-1">
        {(["vapi", "elevenlabs"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setProvider(p)}
            disabled={live}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
              provider === p ? "bg-sky-500 text-ink" : "text-slate-300 hover:bg-white/5"
            } disabled:opacity-50`}
          >
            {p === "vapi" ? "Vapi (Claude · phone)" : "ElevenLabs (browser)"}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {provider === "vapi" ? (
          <p className="text-sm text-slate-300">
            Vapi is your production agent. Place a real phone call from the{" "}
            <span className="font-semibold">Test the agent</span> card.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {!live ? (
              <button onClick={startEl} disabled={busy} className="btn btn-primary">
                {busy ? "Connecting…" : "🎙 Talk to ElevenLabs agent"}
              </button>
            ) : (
              <button onClick={stopEl} className="btn btn-danger">
                End call
              </button>
            )}
            <span className="text-sm text-slate-300">
              {status === "connected"
                ? conversation.isSpeaking
                  ? "Agent speaking…"
                  : "Listening — go ahead and talk."
                : status === "connecting"
                  ? "Connecting…"
                  : "Browser mic — no phone needed."}
            </span>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}
      </div>
    </div>
  );
}
