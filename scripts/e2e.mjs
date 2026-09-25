/**
 * End-to-end run in a real browser.
 *
 * One command, no shared state with a developer's environment: it uses its own ports and its own
 * D1/R2 persistence directory, wipes that directory first so enrolment always starts from nothing,
 * applies the migrations, starts the worker and the dev server, runs the checks, and tears
 * everything down. That is what makes it usable as a gate.
 *
 * Why it exists: every other test runs in Node or jsdom, so nothing covered how a browser loads and
 * renders the app. Four defects reached a user that way — a service worker serving stale modules, a
 * new note that never opened, diagrams skipped before the DOM existed, and diagrams stripped of the
 * stylesheet Mermaid keeps inside the SVG.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = `${ROOT}/.sandbox-home`;
const PERSIST = `${HOME}/e2e-state`;
const WORKER_PORT = 8795;
const WEB_PORT = 5174;
const BASE_URL = `http://localhost:${WEB_PORT}`;

const children = [];

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, HOME, npm_config_store_dir: `${ROOT}/.pnpm-store`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  // Kept in a buffer rather than streamed: the interesting part is only printed when something fails.
  child.output = "";
  child.stdout.on("data", (chunk) => (child.output += String(chunk)));
  child.stderr.on("data", (chunk) => (child.output += String(chunk)));
  return child;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
}

async function waitFor(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function run() {
  console.log("e2e: preparing a clean database");
  rmSync(PERSIST, { recursive: true, force: true });

  await new Promise((resolve, reject) => {
    const apply = spawn(
      "pnpm",
      [
        "--filter",
        "@securenotes/worker",
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "securenotes-db",
        "--local",
        "--persist-to",
        PERSIST,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, HOME, npm_config_store_dir: `${ROOT}/.pnpm-store` },
        stdio: "inherit",
      },
    );
    apply.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`migrations exited ${code}`)),
    );
  });

  console.log("e2e: starting the worker and the dev server");
  start("pnpm", [
    "--filter",
    "@securenotes/worker",
    "exec",
    "wrangler",
    "dev",
    "--port",
    String(WORKER_PORT),
    "--persist-to",
    PERSIST,
    "--var",
    `ALLOWED_ORIGINS:${BASE_URL}`,
  ]);
  start(
    "pnpm",
    ["--filter", "@securenotes/web", "exec", "vite", "--port", String(WEB_PORT), "--strictPort"],
    {
      VITE_API_TARGET: `http://127.0.0.1:${WORKER_PORT}`,
    },
  );

  await waitFor(`http://127.0.0.1:${WORKER_PORT}/api/v1/health`, "worker");
  await waitFor(BASE_URL, "dev server");

  console.log("e2e: running the browser checks");
  const spec = spawn("node", ["scripts/e2e/browser.spec.mjs"], {
    cwd: ROOT,
    env: { ...process.env, HOME, E2E_BASE_URL: BASE_URL },
    stdio: "inherit",
  });

  const code = await new Promise((resolve) =>
    spec.on("exit", (exitCode) => resolve(exitCode ?? 1)),
  );

  if (code !== 0) {
    let printed = 0;
    for (const child of children) {
      for (const line of child.output.split("\n")) {
        if (/error|Error|exception|500/i.test(line) && printed < 20) {
          console.error(`  server log: ${line.slice(0, 400)}`);
          printed += 1;
        }
      }
    }
    if (printed === 0) {
      console.error("  server log: no lines mentioning an error");
    }
  }
  return code;
}

try {
  const code = await run();
  stopAll();
  console.log(code === 0 ? "e2e: passed" : `e2e: FAILED (exit ${code})`);
  process.exit(code);
} catch (error) {
  console.error("e2e: could not run:", error.message);
  for (const child of children) {
    console.error(`--- output of a server that was started ---\n${child.output.slice(-2000)}`);
  }
  stopAll();
  process.exit(1);
}
