/**
 * A self-contained development stack for the browser scripts.
 *
 * Starts a Worker and a dev server on ports of its own, against a persistence directory of its own that it wipes
 * first, applies the migrations to it, and waits until both answer. Nothing about a developer's environment is shared,
 * which is the point: a script that silently depends on whatever happens to be running on 5173 fails in ways that look
 * like product bugs — a stale bundle, an account that is already enrolled, a rate limit tripped by an earlier attempt.
 *
 * Written for the screenshot script. The end-to-end suite keeps its own copy of this because it is the gate and this
 * is the end of a long session: making the gate depend on a refactor for tidiness is a bad trade. The duplication is
 * real and small, and it is on the list.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = `${ROOT}/.sandbox-home`;

function spawnServer(command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, HOME, npm_config_store_dir: `${ROOT}/.pnpm-store`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (chunk) => (child.output += String(chunk)));
  child.stderr.on("data", (chunk) => (child.output += String(chunk)));
  return child;
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

function applyMigrations(persistDir) {
  return new Promise((resolve, reject) => {
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
        persistDir,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, HOME, npm_config_store_dir: `${ROOT}/.pnpm-store` },
        stdio: "ignore",
      },
    );
    apply.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`migrations exited ${code}`)),
    );
  });
}

/**
 * Starts the stack and returns it, with a `stop` that kills everything it started.
 *
 * The ports differ from the end-to-end suite's so the two can run at the same time, and from the development server's
 * so this never touches what a person is looking at.
 */
export async function startStack({
  workerPort = 8796,
  webPort = 5175,
  persistDir = `${HOME}/shots-state`,
} = {}) {
  const baseUrl = `http://localhost:${webPort}`;
  const children = [];

  rmSync(persistDir, { recursive: true, force: true });
  await applyMigrations(persistDir);

  children.push(
    spawnServer("pnpm", [
      "--filter",
      "@securenotes/worker",
      "exec",
      "wrangler",
      "dev",
      "--port",
      String(workerPort),
      "--persist-to",
      persistDir,
      "--var",
      `ALLOWED_ORIGINS:${baseUrl}`,
    ]),
  );
  children.push(
    spawnServer(
      "pnpm",
      ["--filter", "@securenotes/web", "exec", "vite", "--port", String(webPort), "--strictPort"],
      { VITE_API_TARGET: `http://127.0.0.1:${workerPort}` },
    ),
  );

  await waitFor(`http://127.0.0.1:${workerPort}/api/v1/health`, "worker");
  await waitFor(baseUrl, "dev server");

  return {
    baseUrl,
    stop() {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }
    },
    /** Server output, for when something did not work. */
    output: () => children.map((child) => child.output.slice(-1500)).join("\n"),
  };
}

/** RFC 6238, so a script can sign in without reaching into anyone's database. */
export function totpFromBase32(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32ToBytes(secret)).update(message).digest();
  const offset = (digest[19] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

function base32ToBytes(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = secret.toUpperCase().replace(/=+$/, "");
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const character of cleaned) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      continue;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Enrols a fresh account through the interface, the way a person would.
 *
 * Returns the secret the app displays, so the caller can sign in later without reading anyone's database — and so the
 * script exercises the same value a user would scan.
 */
export async function enrol(page, { username = "shots-account", baseUrl } = {}) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('input[aria-label="Username"]', { timeout: 30_000 });
  await page.fill('input[aria-label="Username"]', username);
  await page.getByRole("button", { name: /create account/i }).click();
  const uri = await page.getByTestId("totp-uri").textContent({ timeout: 20_000 });
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForSelector('button:has-text("New note")', { timeout: 30_000 });
  return /secret=([A-Z2-7]+)/.exec(uri ?? "")?.[1] ?? "";
}

/** Signs in with a code derived from the enrolment secret, or unlocks with the device key if one exists. */
export async function signIn(page, { secret, username = "shots-account", baseUrl } = {}) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500);
  if (await page.$('input[aria-label="Authenticator code"]')) {
    await page.fill('input[aria-label="Username"]', username);
    await page.fill('input[aria-label="Authenticator code"]', totpFromBase32(secret));
    await page.click('button[type="submit"]');
  } else {
    const unlock = page.getByRole("button", { name: /unlock/i }).first();
    if (await unlock.count()) {
      await unlock.click();
    }
  }
  await page.waitForSelector('button:has-text("New note")', { timeout: 30_000 });
  await page.waitForTimeout(1500);
}
