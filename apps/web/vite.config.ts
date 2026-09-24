/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The version shown in Settings/About comes from the single source of truth at
 * the repository root (verified by `scripts/check-version.mjs`).
 */
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPackage.version),
  },
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in development too: the browser only ever talks to the Vite
    // origin, which forwards /api to the worker. No CORS is ever enabled (§14).
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
