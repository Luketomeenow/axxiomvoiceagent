/**
 * fetch with a hard timeout for outbound HTTP to third parties (Vapi,
 * ElevenLabs, …). Same idiom as ghlFetch (src/ghl/client.ts): AbortSignal.timeout
 * plus a normalized error message, so a slow upstream can't hang a request
 * handler indefinitely.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      const path = typeof url === "string" ? url : url.toString();
      throw new Error(`timeout after ${timeoutMs}ms: ${path.replace(/\?.*$/, "")}`);
    }
    throw err;
  }
}
