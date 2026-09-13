import { defineConfig } from 'vite';

// App version is sourced directly from package.json via JSON imports
// (src/even-client.ts splash, src/main.ts web badge) — single source of truth.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  build: { assetsDir: '' },
});
