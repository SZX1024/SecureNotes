# Local layer

The browser is the only place plaintext exists. `apps/web/src/local` owns the
IndexedDB schema, the key material that makes offline use possible, and the cache
policy; `apps/web/src/pwa` owns the service worker and the update gate.

Nothing here is trusted by the server, and nothing here stores a plaintext key or
plaintext note content: what is persisted is ciphertext and _wrapped_ keys.

## Schema and migrations (§8, §21)

Every version is declared in `SCHEMA_DEFINITIONS` (`src/local/schema.ts`) and is
never edited once shipped, so an old installation always has a definition it can
be read with. Tables:

| Table         | Holds                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| `notes`       | Encrypted Markdown (the title lives inside the payload) plus sync fields |
| `folders`     | Encrypted names, parent relationship, depth, sort order                  |
| `tags`        | Encrypted names                                                          |
| `noteTags`    | Note↔tag relationships                                                   |
| `attachments` | Encrypted filename, R2 key, size, and an evictable ciphertext cache      |
| `syncQueue`   | Changes not yet acknowledged by the server                               |
| `keyMaterial` | The wrapped DEK (KEK-wrapped and device-wrapped) and the KDF salt        |
| `deviceKeys`  | This device's non-extractable key                                        |
| `meta`        | Small local flags                                                        |

### Why migration does not use Dexie's `upgrade()`

§21 requires that the last known-good database is never destroyed before a
migration succeeds. Dexie's `upgrade()` converts in place, which cannot honour
that: an interruption leaves the only copy half-converted. So `openAppDatabase`
instead:

1. reads the **stored** version of the database itself (not our own metadata,
   which can be stale after a crash — and it also catches that Dexie scales
   versions ×10 in IndexedDB);
2. opens the old database _up to its own version_, which Dexie does without
   modifying it;
3. creates the target database under a new name, discarding anything a previous
   attempt left behind, and copies the tables the old version actually had;
4. verifies that the target holds at least as many rows per table as the source;
5. only then moves the pointer and deletes the previous copy.

A failure at any step — including the final pointer write — leaves the old
database active, complete and untouched. Existence is checked with
`Dexie.exists` before any version probe, because `indexedDB.open()` creates a
database as a side effect.

## Keys (§7)

```text
KEK  = HKDF(username ‖ 0x00 ‖ TOTP secret ‖ context, per-account salt)
DEK  = random, wrapped by the KEK          -> keyMaterial.wrappedDek
DEK  = the same DEK, wrapped by the device key -> keyMaterial.deviceWrappedDek
```

- The device key is generated with `extractable: false`: it can wrap and unwrap
  the DEK, but `exportKey` refuses to read it, so script cannot exfiltrate it.
  Read back from IndexedDB it is a _new_ object wrapping the same key material —
  equality is behavioural, not referential.
- `forgetDeviceKey` deletes both the device key and the stored key material. That
  is what §4 requires when a device learns its session was revoked.
- The DEK is imported non-extractable; decrypted content exists only in memory.

## App Lock (§7)

`KeyStore` is the only place in the client that holds the DEK and the TOTP
secret. It has no serialisation, `lock()` drops the references, and the window is
the same 40 minutes the server applies to session inactivity, so the two never
disagree about when the app is stale. The check is lazy — evaluated whenever the
material is read — so a tab left open in the background locks itself without a
timer needing to fire. `attachLockOnPageHide` locks on `pagehide`,
`beforeunload` and `freeze`.

## Cache policy (§8)

Only cached **attachment ciphertext** is ever evicted; the row itself stays, so
the image can be re-downloaded from R2. Notes, folders and tags are small and are
what makes offline use work, so they are not candidates at all.

A row is a candidate only when it is synced **and** has no queued change. The
second condition is the one that matters: `syncedAt` can be stale while an edit
is still waiting to upload, and evicting then would silently lose the edit.
Accounting uses the row's own `sizeBytes` rather than `blob.size`, because that
value is the size the server reported and it survives every storage round trip.

## Service worker and updates (§21)

`public/sw.js` caches the application shell, serves navigations offline, and
**never caches `/api/*`** — those responses carry session state and ciphertext,
where a stale reply would be both wrong and a privacy problem.

The worker also never activates itself: it waits for
`securenotes:skip-waiting`, and the page only sends that when
`decideUpdate()` agrees. The gate fails closed — an unreadable queue counts as
"there is work", and an update is deferred during a sync — because applying an
update is never urgent while losing a queued edit is not recoverable.
`applyDeferredUpdate` is the moment §21 calls "safe": after a successful sync.

## Single origin (§14)

The built client is served by the worker itself through the `[assets]` binding,
so the API and the app share an origin and CORS stays disabled.
`run_worker_first = ["/api/*"]` guarantees an asset can never shadow an endpoint,
and the worker serves the shell only to requests that ask for HTML and are not
under `/api/`, so the JSON error contract is unaffected.
