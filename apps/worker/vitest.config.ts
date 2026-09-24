import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
}));
