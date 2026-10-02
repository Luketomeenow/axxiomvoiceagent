/**
 * The one Claude client for server-side AI (campaign insights, system analysis,
 * transcript analysis). On Azure it talks to Azure AI Foundry's Anthropic
 * endpoint (ANTHROPIC_BASE_URL + the Foundry key) — no third-party API.
 */

import Anthropic from "@anthropic-ai/sdk";

import { env } from "../config/env.ts";

let client: Anthropic | undefined;

export function anthropicClient(): Anthropic {
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, baseURL: env.anthropicBaseUrl || undefined });
  return client;
}
