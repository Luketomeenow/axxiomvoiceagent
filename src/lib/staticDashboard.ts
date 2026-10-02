/**
 * Serves the dashboard — the Next.js static export (web/ → `next build` →
 * out/) that the deploy package ships as DASHBOARD_DIR — from this same
 * service. Same origin as the API means the session cookie and the SSE stream
 * just work: no CORS, no second host (Netlify is retired).
 *
 * Clean URLs map onto the export's files: "/" → index.html, "/login" →
 * login.html. Hashed build assets under /_next/static are cached forever;
 * HTML is never cached, so a deploy is picked up on the next page load.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function dashboardAvailable(dir: string): Promise<boolean> {
  return isFile(join(resolve(dir), "index.html"));
}

/** Resolve a URL path to a file inside `dir`, or null. Never escapes `dir`. */
async function resolveFile(root: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const candidates = decoded.endsWith("/")
    ? [`${decoded}index.html`]
    : extname(decoded)
      ? [decoded]
      : [`${decoded}.html`, `${decoded}/index.html`];
  for (const candidate of candidates) {
    const file = normalize(join(root, candidate));
    if (file !== root && !file.startsWith(root + sep)) return null; // path traversal
    if (await isFile(file)) return file;
  }
  return null;
}

/** The dashboard response for a GET, or null when nothing matches (→ 404). */
export async function serveDashboard(dir: string, pathname: string): Promise<Response | null> {
  const root = resolve(dir);
  const file = await resolveFile(root, pathname);
  if (!file) {
    const notFound = join(root, "404.html");
    if (!(await isFile(notFound))) return null;
    return new Response(await readFile(notFound), {
      status: 404,
      headers: { "Content-Type": MIME[".html"], "Cache-Control": "no-cache", ...SECURITY_HEADERS },
    });
  }
  const immutable = pathname.startsWith("/_next/static/");
  return new Response(await readFile(file), {
    headers: {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...SECURITY_HEADERS,
    },
  });
}
