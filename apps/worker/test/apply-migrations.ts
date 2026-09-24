import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

/**
 * Applies the real migration files to the isolated D1 instance for each test
 * file. `TEST_MIGRATIONS` is injected by `vitest.config.ts` at test time only,
 * so it is not part of `Cloudflare.Env` and is narrowed here instead of being
 * declared on the shared Env type (which is used by production code).
 */
const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
