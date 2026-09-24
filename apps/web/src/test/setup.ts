import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

import "@testing-library/jest-dom/vitest";

/**
 * jsdom provides neither IndexedDB nor `crypto.subtle`, and the local layer needs
 * both: the database under test is real Dexie over IndexedDB, and the device key
 * is a real non-extractable WebCrypto key. `fake-indexeddb` and Node's WebCrypto
 * give the tests the same semantics the browser has, rather than mocks that would
 * not catch a wrong key usage.
 */
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
