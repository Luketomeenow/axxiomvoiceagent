import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/**
 * Production (`next build`): a static export (out/) that the backend serves
 * from the same origin — scripts/azure/package-app.sh ships it as public/.
 * Development (`next dev`, :3001): proxy the API paths to the backend so the
 * browser still sees ONE origin (the session cookie + SSE need that).
 */
const API_DEV_ORIGIN = process.env.API_DEV_ORIGIN ?? "http://localhost:3000";

/** @type {(phase: string) => import('next').NextConfig} */
export default function nextConfig(phase) {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      reactStrictMode: true,
      compress: false, // don't buffer the proxied SSE stream
      async rewrites() {
        return [
          { source: "/outbound/:path*", destination: `${API_DEV_ORIGIN}/outbound/:path*` },
          { source: "/auth/:path*", destination: `${API_DEV_ORIGIN}/auth/:path*` },
        ];
      },
    };
  }
  return {
    reactStrictMode: true,
    output: "export",
    images: { unoptimized: true },
  };
}
