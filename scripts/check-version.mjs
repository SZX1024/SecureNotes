#!/usr/bin/env node
/**
 * The version shown in Settings/About (requirements §21) must be a single
 * source of truth. `package.json` at the repository root is that source; the
 * web app derives it at build time and the worker keeps a literal that this
 * script verifies, so a stale literal can never ship silently.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

const expected = readJson("package.json").version;
const workerLiteral = /APP_VERSION\s*=\s*"([^"]+)"/.exec(
  readText("apps/worker/src/version.ts"),
)?.[1];

const targets = [
  ["apps/worker/package.json", readJson("apps/worker/package.json").version],
  ["apps/web/package.json", readJson("apps/web/package.json").version],
  ["apps/worker/src/version.ts", workerLiteral],
];

const mismatched = targets.filter(([, found]) => found !== expected);
if (mismatched.length > 0) {
  console.error(`Version mismatch. Root package.json is "${expected}" but:`);
  for (const [path, found] of mismatched) {
    console.error(`  ${path} -> ${found ?? "<not found>"}`);
  }
  process.exit(1);
}

console.log(`version consistent: ${expected}`);
