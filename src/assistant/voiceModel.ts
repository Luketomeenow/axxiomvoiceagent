/**
 * The `model` block of a Vapi assistant — where the agent's brain runs.
 *
 *   VOICE_PROVIDER=anthropic (default) → Vapi calls Anthropic itself (outside Azure).
 *   VOICE_PROVIDER=foundry             → Vapi's custom-llm, pointed at this
 *     service's relay (${SERVER_URL}/vapi/llm → Azure AI Foundry deployment
 *     VOICE_MODEL). See src/vapi/llmRelay.ts for why it goes through the relay.
 *
 * Changing it only takes effect after the assistant sync re-pushes the configs.
 */

import { env } from "../config/env.ts";

export function voiceModelBlock(spec: {
  temperature: number;
  maxTokens: number;
  messages: unknown[];
  tools: unknown[];
}) {
  if (env.voiceProvider === "foundry") {
    return {
      provider: "custom-llm",
      url: `${env.serverUrl.replace(/\/$/, "")}/vapi/llm`,
      model: env.voiceModel,
      // The relay authenticates Vapi with the same shared secret as the webhook.
      headers: { "x-vapi-secret": env.vapiServerSecret },
      // Sent by Vapi, normalized by the relay (Foundry rejects a custom
      // temperature on these models and wants max_completion_tokens).
      temperature: spec.temperature,
      maxTokens: spec.maxTokens,
      messages: spec.messages,
      tools: spec.tools,
    };
  }
  return { provider: "anthropic", model: env.voiceModel, ...spec };
}
