import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Fixed base64 256-bit keys, valid only inside the test pool. */
const TEST_SECRET_WRAP_KEY = "dGVzdC1zZWNyZXQtd3JhcC1rZXktMzItYnl0ZXMhISE=";
const TEST_CSRF_SIGNING_KEY = "dGVzdC1jc3JmLXNpZ25pbmcta2V5LTMyLWJ5dGVzISE=";

/**
 * Tests run inside workerd via the Workers pool, using the real wrangler.toml
 * bindings (local D1 + R2). In `@cloudflare/vitest-pool-workers` 0.22 the pool
 * is a Vite plugin rather than a `defineWorkersConfig` helper.
 *
 * The SQL files in `migrations/` are read here, in Node, and handed to the
 * worker as the `TEST_MIGRATIONS` binding. Tests apply them themselves
 * (see `test/apply-migrations.ts`), so the schema under test is exactly the
 * schema that ships — never a hand-written duplicate.
 */
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // Deterministic test-only secrets. Production values come from
          // `wrangler secret put`; these never reach a deployed worker and are
          // deliberately not the values in `.dev.vars.example`.
          SECRET_WRAP_KEY: TEST_SECRET_WRAP_KEY,
          CSRF_SIGNING_KEY: TEST_CSRF_SIGNING_KEY,
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
}));
