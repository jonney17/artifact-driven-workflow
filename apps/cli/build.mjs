// Bundles the CLI with the workspace libs and their pure-JS dependencies into one ESM file.
// Only the Copilot SDK stays external: it is installed on machines with a Copilot seat.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/sdlc.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@github/copilot-sdk'],
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: 'warning',
});
console.log('built dist/sdlc.mjs');
