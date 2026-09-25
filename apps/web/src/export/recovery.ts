import { utf8, type Bytes } from "@securenotes/shared";

import { createZip } from "./zip";

/**
 * The account recovery package (§20).
 *
 * Separate from the ordinary export and deliberately smaller: it carries the protected key material a user needs
 * to recover their account on a new device, and nothing else. It is versioned, and it states in its own manifest
 * what it does **not** contain — a file about account recovery should say plainly that the authenticator secret is
 * not in it, rather than leaving someone to check the fields.
 *
 * The name says "recovery" rather than "backup" on purpose: the ordinary export is the backup of the notes, and
 * confusing the two would be easy and costly — one restores a device, the other restores an account.
 */

export const RECOVERY_PACKAGE_FORMAT = "securenotes-recovery";
export const RECOVERY_PACKAGE_FILE_VERSION = 1;

/** The payload the server assembles: opaque wrappings and the identifiers that make them usable. */
export interface RecoveryPackagePayload {
  format: string;
  formatVersion: number;
  createdAt: number;
  account: { id: string; username: string };
  kdf: {
    algorithm: string;
    accountSalt: string;
    accountContext: string;
    recoveryContext: string;
  };
  cryptoVersion: number;
  keyVersion: number;
  accountWrapping: unknown;
  recoveryWrappings: Array<{ salt: string; envelope: unknown }>;
  excludes: readonly string[];
}

export interface RecoveryPackageFile {
  manifest: {
    format: typeof RECOVERY_PACKAGE_FORMAT;
    fileVersion: number;
    writtenAt: number;
    account: string;
    includes: string[];
    excludes: readonly string[];
  };
  payload: RecoveryPackagePayload;
}

const README = `SecureNotes recovery package
============================

This file lets you get back into your account on a new device. It is not a
backup of your notes: use Export everything for that.

What it contains
----------------

  key-material.json   your wrapped data key, one wrapped copy per unused
                      recovery code, and the salts and identifiers a client
                      needs to unwrap them

What it does NOT contain
------------------------

  - Your authenticator (TOTP) secret. It is never exported.
  - Any note or attachment content.
  - Your password, your recovery codes, or your data key in unwrapped form.

Every wrapping in here is protected by something you keep separately: your
username plus authenticator secret for the account copy, and one recovery code
for each of the others. This file on its own opens nothing.

Keep it somewhere you trust, and keep your recovery codes separately from it: a
package stored next to the codes it needs is the same as storing neither.
`;

/**
 * Writes the package as a versioned ZIP.
 *
 * A ZIP rather than a bare JSON file because the README travels with it: whoever finds this file in five years
 * should be able to read what it is without this application.
 */
export async function buildRecoveryPackageFile(
  payload: RecoveryPackagePayload,
  writtenAt: number,
): Promise<Bytes> {
  const file: RecoveryPackageFile = {
    manifest: {
      format: RECOVERY_PACKAGE_FORMAT,
      fileVersion: RECOVERY_PACKAGE_FILE_VERSION,
      writtenAt,
      account: payload.account.username,
      includes: ["account_wrapping", "recovery_wrappings", "kdf_parameters"],
      excludes: payload.excludes,
    },
    payload,
  };

  return createZip([
    { path: "README.txt", bytes: utf8(README) },
    { path: "manifest.json", bytes: utf8(JSON.stringify(file.manifest, null, 2)) },
    { path: "key-material.json", bytes: utf8(JSON.stringify(file.payload, null, 2)) },
  ]);
}

/** A filename that says what it is and when it was written. */
export function recoveryFileName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `securenotes-recovery-${stamp}.zip`;
}
