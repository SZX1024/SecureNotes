import {
  buildRecoveryWrappings,
  deriveKek,
  deriveRecoveryKek,
  generateDekRaw,
  importDek,
  unwrapDek,
  wipe,
  wrapDek,
  type Bytes,
  type CryptoEnvelope,
} from "@securenotes/shared";

import { apiRequest } from "../api/client";
import {
  forgetDeviceKey,
  getOrCreateDeviceKey,
  unwrapDekForDevice,
  wrapDekForDevice,
} from "../local/device-key";
import type { SecureNotesDatabase } from "../local/schema";

/**
 * The account flows: enrolment, sign-in and offline unlock.
 *
 * The worker never sees a key, so every step below happens here: the client
 * derives the KEK from the credentials the server delivered, generates the DEK,
 * wraps it for the KEK and for each recovery code, and uploads only the wrapped
 * forms.
 *
 * These functions are deliberately free of React so the sequence — and the order
 * in which keys come into existence — can be tested directly.
 */

export interface EnrolmentMaterial {
  userId: string;
  username: string;
  kdfSalt: string;
  keyVersion: number;
  totpSecret: string;
}

/** What the enrolment screen must show exactly once. */
export interface EnrolmentSecrets {
  totpUri: string;
  recoveryCodes: Array<{ code: string; salt: string }>;
}

export interface UnlockedAccount {
  userId: string;
  username: string;
  kdfSalt: string;
  keyVersion: number;
  /** Empty for an offline unlock, where the TOTP secret is unavailable by design. */
  totpSecret: string;
  /** The DEK, non-extractable. */
  dek: CryptoKey;
}

async function nonceFor(operation: string): Promise<string> {
  const response = await apiRequest<{ nonce: string }>("/security/operation-nonce", {
    method: "POST",
    body: { operation },
  });
  return response.nonce;
}

/**
 * Enrolment (§3): create the account, then generate and upload the key material.
 *
 * The DEK is generated here, never by the server. Its raw bytes exist only inside
 * this function: the caller receives a non-extractable `CryptoKey` and the wrapped
 * forms that were uploaded.
 */
export async function enrolAccount(input: {
  username: string;
}): Promise<{ account: UnlockedAccount; secrets: EnrolmentSecrets }> {
  const setup = await apiRequest<{
    userId: string;
    username: string;
    kdfSalt: string;
    keyVersion: number;
    totpSecret: string;
    totpUri: string;
    recoveryCodes: Array<{ code: string; salt: string }>;
  }>("/auth/setup", { method: "POST", body: { username: input.username } });

  const kek = await deriveKek({
    username: setup.username,
    totpSecretBase32: setup.totpSecret,
    kdfSaltBase64: setup.kdfSalt,
  });

  const rawDek: Bytes = generateDekRaw();
  const identity = { userId: setup.userId, keyVersion: setup.keyVersion };

  try {
    const wrappedDek = await wrapDek(kek, rawDek, identity);
    const recoveryWrappings = await buildRecoveryWrappings(rawDek, setup.recoveryCodes, identity);

    await apiRequest<{ keyMaterialPresent: boolean }>("/key-material", {
      method: "POST",
      body: {
        nonce: await nonceFor("key-material-upload"),
        keyVersion: setup.keyVersion,
        wrappedDek,
        recoveryWrappings: recoveryWrappings.map((envelope, index) => ({
          salt: setup.recoveryCodes[index]!.salt,
          envelope,
        })),
      },
    });

    return {
      account: {
        userId: setup.userId,
        username: setup.username,
        kdfSalt: setup.kdfSalt,
        keyVersion: setup.keyVersion,
        totpSecret: setup.totpSecret,
        dek: await importDek(rawDek),
      },
      secrets: { totpUri: setup.totpUri, recoveryCodes: setup.recoveryCodes },
    };
  } finally {
    // Best-effort hygiene: the raw DEK is not needed once it is wrapped.
    wipe(rawDek);
  }
}

export interface SignInResult {
  account: UnlockedAccount;
  rememberDevice: boolean;
}

/**
 * Signs in and unlocks, or returns null when the credentials were rejected.
 *
 * The TOTP secret from the login response is what makes the KEK derivable; it is
 * kept in memory only and never written to storage.
 */
export async function signIn(input: {
  username: string;
  code: string;
  rememberDevice?: boolean;
  /** When provided, a device wrapping is stored so offline unlock works (§7). */
  db?: SecureNotesDatabase;
}): Promise<SignInResult | null> {
  let login: {
    userId: string;
    username: string;
    kdfSalt: string;
    keyVersion: number;
    totpSecret: string | null;
    rememberDevice?: boolean;
  };
  try {
    login = await apiRequest("/auth/login", {
      method: "POST",
      body: {
        username: input.username,
        code: input.code,
        ...(input.rememberDevice === undefined ? {} : { rememberDevice: input.rememberDevice }),
      },
    });
  } catch {
    // A rejected credential is an expected outcome, not an error to surface.
    return null;
  }

  if (!login.totpSecret) {
    return null;
  }

  const material = await apiRequest<{ wrappedDek: CryptoEnvelope | null }>("/key-material");
  if (!material.wrappedDek) {
    throw new Error("the account has no key material yet; finish enrolment first");
  }

  const kek = await deriveKek({
    username: login.username,
    totpSecretBase32: login.totpSecret,
    kdfSaltBase64: login.kdfSalt,
  });
  const rawDek = await unwrapDek(kek, material.wrappedDek, {
    userId: login.userId,
    keyVersion: login.keyVersion,
  });

  try {
    const dek = await importDek(rawDek);

    // A remembered device gets the DEK wrapped by its own non-extractable key, so
    // it can unlock offline. Never on an unremembered session: the local wrapping
    // must not outlive the user's intent to stay signed in here.
    if (input.db && input.rememberDevice === true) {
      const deviceKey = await getOrCreateDeviceKey(input.db);
      await input.db.keyMaterial.put({
        id: "account",
        userId: login.userId,
        kdfSalt: login.kdfSalt,
        keyVersion: login.keyVersion,
        wrappedDek: material.wrappedDek,
        deviceWrappedDek: await wrapDekForDevice(deviceKey, rawDek, {
          userId: login.userId,
          keyVersion: login.keyVersion,
        }),
        updatedAt: Date.now(),
      });
    } else if (input.db) {
      // Signing in without remember-device must not leave an offline unlock path
      // behind from an earlier session.
      await forgetDeviceKey(input.db);
    }

    return {
      account: {
        userId: login.userId,
        username: login.username,
        kdfSalt: login.kdfSalt,
        keyVersion: login.keyVersion,
        totpSecret: login.totpSecret,
        dek,
      },
      rememberDevice: login.rememberDevice ?? false,
    };
  } finally {
    wipe(rawDek);
  }
}

export interface RecoverySignInResult {
  account: UnlockedAccount;
  /** §3: after a recovery login the authenticator must be reconfigured. */
  mustRebindTotp: boolean;
  rememberDevice: boolean;
}

/**
 * Signs in with a recovery code (§3).
 *
 * This is the path that has to work when the authenticator is gone, so it cannot depend on the TOTP
 * secret: the KEK is derived from the code itself and the per-code salt the server returns, and the
 * DEK is unwrapped from **that code's** wrapping. A recovery code is therefore a complete key, which
 * is what makes losing a phone survivable — and why the codes are worth storing somewhere else.
 *
 * Returns null when the code is rejected (wrong, or already spent: they are single use).
 */
export async function signInWithRecoveryCode(input: {
  username: string;
  code: string;
  rememberDevice?: boolean;
  db?: SecureNotesDatabase;
}): Promise<RecoverySignInResult | null> {
  let response: {
    userId: string;
    username: string;
    kdfSalt: string;
    keyVersion: number;
    mustRebindTotp?: boolean;
    rememberDevice?: boolean;
    recovery: { salt: string; wrappedDek: CryptoEnvelope } | null;
  };

  try {
    response = await apiRequest("/auth/recovery", {
      method: "POST",
      body: {
        username: input.username,
        code: input.code,
        ...(input.rememberDevice === undefined ? {} : { rememberDevice: input.rememberDevice }),
      },
    });
  } catch {
    // A rejected or already-spent code is an expected outcome.
    return null;
  }

  if (!response.recovery?.wrappedDek) {
    throw new Error(
      "This account has no recovery wrapping stored, so a recovery code cannot unlock its notes.",
    );
  }

  const kek = await deriveRecoveryKek(input.code, response.recovery.salt);
  const rawDek = await unwrapDek(kek, response.recovery.wrappedDek, {
    userId: response.userId,
    keyVersion: response.keyVersion,
  });

  try {
    const dek = await importDek(rawDek);
    await rememberOrForgetDevice(input.db, input.rememberDevice === true, {
      userId: response.userId,
      kdfSalt: response.kdfSalt,
      keyVersion: response.keyVersion,
      wrappedDek: response.recovery.wrappedDek,
      rawDek,
    });

    return {
      account: {
        userId: response.userId,
        username: response.username,
        kdfSalt: response.kdfSalt,
        keyVersion: response.keyVersion,
        // Not available on this path by design: that is why a rebind is required.
        totpSecret: "",
        dek,
      },
      mustRebindTotp: response.mustRebindTotp === true,
      rememberDevice: response.rememberDevice ?? false,
    };
  } finally {
    wipe(rawDek);
  }
}

/**
 * Stores or removes the device wrapping, so offline unlock follows the user's choice.
 *
 * Shared by the code and recovery paths: signing in without asking to be remembered must not leave
 * an offline unlock path behind from an earlier session.
 */
async function rememberOrForgetDevice(
  db: SecureNotesDatabase | undefined,
  remember: boolean,
  material: {
    userId: string;
    kdfSalt: string;
    keyVersion: number;
    wrappedDek: CryptoEnvelope;
    rawDek: Bytes;
  },
): Promise<void> {
  if (!db) {
    return;
  }
  if (!remember) {
    await forgetDeviceKey(db);
    return;
  }
  const deviceKey = await getOrCreateDeviceKey(db);
  await db.keyMaterial.put({
    id: "account",
    userId: material.userId,
    kdfSalt: material.kdfSalt,
    keyVersion: material.keyVersion,
    wrappedDek: material.wrappedDek,
    deviceWrappedDek: await wrapDekForDevice(deviceKey, material.rawDek, {
      userId: material.userId,
      keyVersion: material.keyVersion,
    }),
    updatedAt: Date.now(),
  });
}

/**
 * Offline unlock with the device key (§7).
 *
 * No network and no TOTP: the device key opens the DEK stored for this device.
 * The TOTP secret is not recoverable this way, which is why an offline session can
 * read and edit but cannot re-wrap key material.
 */
export async function unlockWithDeviceKey(
  db: SecureNotesDatabase,
): Promise<UnlockedAccount | null> {
  const material = await db.keyMaterial.get("account");
  if (!material?.deviceWrappedDek) {
    return null;
  }

  const deviceKey = await getOrCreateDeviceKey(db);
  const rawDek = await unwrapDekForDevice(deviceKey, material.deviceWrappedDek, {
    userId: material.userId,
    keyVersion: material.keyVersion,
  });

  try {
    return {
      userId: material.userId,
      username: "",
      kdfSalt: material.kdfSalt,
      keyVersion: material.keyVersion,
      totpSecret: "",
      dek: await importDek(rawDek),
    };
  } finally {
    wipe(rawDek);
  }
}

export interface StartedRebind {
  totpSecretBase32: string;
  totpUri: string;
  keyVersion: number;
}

/** Starts a TOTP rebind: the server generates a pending secret (§3). */
export async function beginTotpRebind(): Promise<StartedRebind> {
  const response = await apiRequest<StartedRebind & { state: string }>(
    "/security/totp/change/start",
    {
      method: "POST",
      body: { nonce: await nonceFor("totp-change-start") },
    },
  );
  return {
    totpSecretBase32: response.totpSecretBase32,
    totpUri: response.totpUri,
    keyVersion: response.keyVersion,
  };
}

export interface VerifiedRebind {
  /** The new secret: it derives the new KEK. */
  totpSecret: string;
  /** The old secret: it is what can still unwrap the DEK as stored. */
  previousTotpSecret: string;
  keyVersion: number;
}

/**
 * Verifies a code from the pending secret.
 *
 * Both secrets come back for the duration of the rebind, and both are needed: the DEK on the server
 * is still wrapped under the old KEK, and it has to be re-wrapped under the new one. The client holds
 * the DEK only as a non-extractable key, so it cannot be exported — it is unwrapped from the server's
 * stored material with the old secret instead.
 */
export async function verifyTotpRebind(code: string): Promise<VerifiedRebind | null> {
  try {
    const response = await apiRequest<VerifiedRebind & { state: string }>(
      "/security/totp/change/verify",
      {
        method: "POST",
        body: { nonce: await nonceFor("totp-change-verify"), code },
      },
    );
    return {
      totpSecret: response.totpSecret,
      previousTotpSecret: response.previousTotpSecret,
      keyVersion: response.keyVersion,
    };
  } catch {
    // A wrong code is an expected outcome.
    return null;
  }
}

/**
 * Re-wraps the DEK under the new KEK and commits the rebind.
 *
 * The recovery wrappings are deliberately not re-uploaded: a rebind does not change the DEK, so the
 * stored ones stay valid, and on this path the client has no plaintext codes to wrap with — it signed
 * in with one. The server treats their absence as "keep what is stored".
 *
 * The server revokes every session on completion, including this one, so the caller must expect to
 * authenticate again.
 */
export async function completeTotpRebind(input: {
  account: UnlockedAccount;
  verified: VerifiedRebind;
}): Promise<void> {
  const { account, verified } = input;

  const material = await apiRequest<{ wrappedDek: CryptoEnvelope | null }>("/key-material");
  if (!material.wrappedDek) {
    throw new Error("the account has no key material to re-wrap");
  }

  const previousKek = await deriveKek({
    username: account.username,
    totpSecretBase32: verified.previousTotpSecret,
    kdfSaltBase64: account.kdfSalt,
  });
  const rawDek = await unwrapDek(previousKek, material.wrappedDek, {
    userId: account.userId,
    keyVersion: material.wrappedDek.key_version,
  });

  try {
    const nextKek = await deriveKek({
      username: account.username,
      totpSecretBase32: verified.totpSecret,
      kdfSaltBase64: account.kdfSalt,
    });
    const wrappedDek = await wrapDek(nextKek, rawDek, {
      userId: account.userId,
      keyVersion: verified.keyVersion,
    });

    await apiRequest("/security/totp/change/complete", {
      method: "POST",
      body: {
        nonce: await nonceFor("totp-change-complete"),
        keyVersion: verified.keyVersion,
        wrappedDek,
      },
    });
  } finally {
    wipe(rawDek);
  }
}

/** Destroys local key material after a revocation or an explicit sign-out (§4). */
export async function forgetLocalKeys(db: SecureNotesDatabase): Promise<void> {
  await forgetDeviceKey(db);
}
