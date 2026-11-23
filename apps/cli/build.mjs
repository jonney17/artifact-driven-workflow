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
  // the Copilot SDK is installed only where there is a seat; the rest are optional NestJS peers we don't use
  external: ['@github/copilot-sdk', '@nestjs/microservices', '@nestjs/microservices/*', '@nestjs/websockets', '@nestjs/websockets/*', 'class-transformer', 'class-validator', '@fastify/static', '@nestjs/platform-socket.io'],
  tsconfig: '../../tsconfig.base.json',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: 'warning',
});
console.log('built dist/sdlc.mjs');
