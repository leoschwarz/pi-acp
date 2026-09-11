import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    dts: false,
    splitting: false,
    minify: false,
    banner: {
      js: '#!/usr/bin/env node'
    }
  },
  {
    // Bundled pi extension for client-side fs delegation. Everything except
    // node built-ins is inlined so the file loads inside pi with no extra
    // dependency-resolution requirements.
    entry: ['src/extension/pi-fs-delegate.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    dts: false,
    splitting: false,
    minify: false,
    external: [/^node:/]
  }
])
