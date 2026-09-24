import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd via the Workers pool, using the real wrangler.toml
 * bindings (local D1 + R2). In `@cloudflare/vitest-pool-workers` 0.22 the pool
 * is a Vite plugin rather than a `defineWorkersConfig` helper.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
