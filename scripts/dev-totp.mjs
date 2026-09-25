/**
 * Generates the current TOTP code for the local dev account.
 *
 * The secret is sealed in D1 with the worker's SECRET_WRAP_KEY (from the gitignored .dev.vars), so
 * this unseals it the same way the worker does. Used only to drive the browser during debugging;
 * nothing secret is printed.
 */
import { execSync } from "node:child_process";
import { createDecipheriv, createHmac, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";

const ROOT = "/home/SZX10246/Projects/software/SecureNotes";

function d1(sql) {
  const out = execSync(
    `pnpm exec wrangler d1 execute securenotes-db --local --json --command ${JSON.stringify(sql)}`,
    {
      cwd: `${ROOT}/apps/worker`,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: `${ROOT}/.sandbox-home` },
    },
  );
  return JSON.parse(out)[0].results;
}

const devVars = Object.fromEntries(
  readFileSync(`${ROOT}/apps/worker/.dev.vars`, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => l.split("=").map((p) => p.trim().replace(/^"|"$/g, ""))),
);

const [totp] = d1("SELECT secret_iv, secret_ciphertext, last_used_step FROM totp_config");
const [user] = d1("SELECT username FROM users");

const rootKey = Buffer.from(devVars.SECRET_WRAP_KEY, "base64");
const wrapKey = Buffer.from(
  hkdfSync(
    "sha256",
    rootKey,
    Buffer.alloc(0),
    Buffer.from("SecureNotes/v1/worker/totp-secret"),
    32,
  ),
);
const decipher = createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(totp.secret_iv, "base64"), {
  authTagLength: 16,
});
const blob = Buffer.from(totp.secret_ciphertext, "base64");
decipher.setAuthTag(blob.subarray(blob.length - 16));
const secret = Buffer.concat([
  decipher.update(blob.subarray(0, blob.length - 16)),
  decipher.final(),
]);

const step = Math.floor(Date.now() / 1000 / 30);
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(step));
const digest = createHmac("sha1", secret).update(counter).digest();
const offset = digest[digest.length - 1] & 0x0f;
const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");

console.log(
  JSON.stringify({
    username: user.username,
    code,
    step,
    lastUsedStep: totp.last_used_step ?? null,
    secondsLeft: 30 - (Math.floor(Date.now() / 1000) % 30),
  }),
);
