import {
  buildRecoveryWrappings,
  deriveKek,
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

/** Destroys local key material after a revocation or an explicit sign-out (§4). */
export async function forgetLocalKeys(db: SecureNotesDatabase): Promise<void> {
  await forgetDeviceKey(db);
}
