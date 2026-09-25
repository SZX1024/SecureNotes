import { describe, expect, it } from "vitest";

import {
  RECOVERY_PACKAGE_FILE_VERSION,
  RECOVERY_PACKAGE_FORMAT,
  buildRecoveryPackageFile,
  recoveryFileName,
  type RecoveryPackagePayload,
} from "./recovery";
import { readZip } from "./zip";

/**
 * The recovery package file (§20).
 *
 * Two things are worth pinning down: the file says what it is and what it is not, and it carries the protected
 * material rather than a summary of it — a recovery package that described the wrappings instead of containing
 * them would look right and recover nothing.
 */

const PAYLOAD: RecoveryPackagePayload = {
  format: "securenotes-recovery",
  formatVersion: 1,
  createdAt: 1_000,
  account: { id: "user-1", username: "alice" },
  kdf: {
    algorithm: "HKDF-SHA-256",
    accountSalt: "c2FsdA==",
    accountContext: "SecureNotes/v1/KEK",
    recoveryContext: "SecureNotes/v1/RecoveryKEK",
  },
  cryptoVersion: 1,
  keyVersion: 1,
  accountWrapping: { iv: "aXY=", ciphertext: "Y3Q=" },
  recoveryWrappings: [{ salt: "c2FsdDI=", envelope: { iv: "aXYy", ciphertext: "Y3Qy" } }],
  excludes: ["totp_secret", "note_content", "attachment_content"],
};

describe("writing the package (§20)", () => {
  it("carries the key material itself, not a description of it", async () => {
    const files = await readZip(await buildRecoveryPackageFile(PAYLOAD, 2_000));
    const material = JSON.parse(new TextDecoder().decode(files.get("key-material.json")!));

    expect(material.accountWrapping).toEqual(PAYLOAD.accountWrapping);
    expect(material.recoveryWrappings).toEqual(PAYLOAD.recoveryWrappings);
    expect(material.kdf.accountSalt).toBe("c2FsdA==");
  });

  it("states what it is and what it is not", async () => {
    const files = await readZip(await buildRecoveryPackageFile(PAYLOAD, 2_000));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")!));
    const readme = new TextDecoder().decode(files.get("README.txt")!);

    expect(manifest.format).toBe(RECOVERY_PACKAGE_FORMAT);
    expect(manifest.fileVersion).toBe(RECOVERY_PACKAGE_FILE_VERSION);
    expect(manifest.writtenAt).toBe(2_000);
    expect(manifest.excludes).toContain("totp_secret");
    // The distinction a user must not have to guess: this file restores an account, the export restores notes.
    expect(readme).toMatch(/authenticator \(TOTP\) secret/i);
    expect(readme).toMatch(/not a\s+backup of your notes/i);
  });

  it("names the file after what it is", () => {
    expect(recoveryFileName(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe(
      "securenotes-recovery-2026-01-02T03-04-05.zip",
    );
  });
});
