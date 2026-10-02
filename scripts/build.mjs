/**
 * Production build of the backend for Azure App Service (Node 22):
 * one self-contained ESM bundle, dist/server.mjs, with every dependency
 * inlined — the deploy zip needs no node_modules and no server-side
 * `npm install` (SCM_DO_BUILD_DURING_DEPLOYMENT=false), so what runs is
 * exactly what was built and tested. Startup: node --enable-source-maps dist/server.mjs
 *
 *   node scripts/build.mjs     (or: bun scripts/build.mjs / npm run build)
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Optional native binding pg tries to load; never installed.
  external: ["pg-native"],
  // CJS dependencies call require() for Node built-ins; ESM has no require.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
