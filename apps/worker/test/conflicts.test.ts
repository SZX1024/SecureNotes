import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  authedRequest,
  createAccount,
  loginOnce,
  resetRateLimits,
  type CookieJar,
  type TestAccount,
} from "./support";

/**
 * Conflicts (§16).
 *
 * "Server accepts only when current revision equals base revision. Otherwise it creates a conflict
 * instead of silently overwriting." These tests check the three sides are retained, that resolving
 * writes the chosen side without losing the other, and that a resolution cannot itself lose a newer
 * edit.
 */

let account: TestAccount;
let jar: CookieJar;

let sequence = 0;
const nextId = () => `conflict-note-${(sequence += 1)}`;

const envelope = (ciphertext: string) => ({
  crypto_version: 1,
  key_version: 1,
  alg: "AES-256-GCM" as const,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext,
});

async function createNote(id: string, ciphertext: string) {
  const response = await authedRequest("/notes", jar, {
    method: "POST",
    body: { id, folderId: null, payload: envelope(ciphertext) },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

async function conflicts() {
  const response = await authedRequest<{
    ok: true;
    data: {
      conflicts: Array<{
        id: string;
        objectId: string;
        baseRevision: number | null;
        /** The revision the remote side is stored under, which is also its AAD revision. */
        remoteRevision: number;
        local: { ciphertext: string };
        remote: { ciphertext: string };
      }>;
    };
  }>("/conflicts", jar);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.conflicts;
}

beforeAll(async () => {
  account = await createAccount();
  jar = (await loginOnce(account)).jar;
});

beforeEach(resetRateLimits);

describe("conflicts (§16)", () => {
  it("records both sides when an edit is based on a stale revision", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    // Somebody else advanced it.
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });

    const stale = await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });

    expect(stale.status).toBe(409);
    const open = (await conflicts()).filter((entry) => entry.objectId === id);
    expect(open).toHaveLength(1);
    // Base, local and remote are all retained; the local work is the part that must never be lost.
    expect(open[0]!.baseRevision).toBe(1);
    // The revision the remote side is stored under, which the client needs as the AAD revision to
    // decrypt it and as the basis for the resolution's own revision.
    expect(open[0]!.remoteRevision).toBe(2);
    expect(open[0]!.local.ciphertext).toBe("bG9jYWw=");
    expect(open[0]!.remote.ciphertext).toBe("cmVtb3Rl");
  });

  it("keeps a single open conflict for an object, however often it is retried", async () => {
    const id = nextId();
    await createNote(id, "b25l");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("dHdv") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("dGhyZWU=") },
    });

    // §16 pauses the object, so a retry must not pile up conflicts.
    expect((await conflicts()).filter((entry) => entry.objectId === id)).toHaveLength(1);
  });

  it("keeps the local side and closes the conflict", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });

    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;
    const resolved = await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "local", payload: envelope("bG9jYWw=") },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);

    const note = await authedRequest<{
      ok: true;
      data: { note: { revision: number; payload: { ciphertext: string } } };
    }>(`/notes/${id}`, jar);
    expect(note.body.data.note.payload.ciphertext).toBe("bG9jYWw=");
    // Written as a new revision on top of the remote one, not in place of it.
    expect(note.body.data.note.revision).toBe(3);
    expect((await conflicts()).some((entry) => entry.objectId === id)).toBe(false);
  });

  it("publishes the resolution in the sync feed", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });
    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;

    const before = await authedRequest<{ ok: true; data: { cursor: number } }>(
      "/sync/changes?since=0",
      jar,
    );
    await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "local", payload: envelope("bG9jYWw=") },
    });

    const after = await authedRequest<{
      ok: true;
      data: { changes: Array<{ objectId: string; changeType: string; revision: number | null }> };
    }>(`/sync/changes?since=${before.body.data.cursor}`, jar);

    // Devices that were not part of the conflict still learn the note moved on.
    const change = after.body.data.changes.find((entry) => entry.objectId === id);
    expect(change?.changeType).toBe("update");
    expect(change?.revision).toBe(3);
  });

  it("accepts the remote side without writing anything", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });
    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;

    const resolved = await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "remote" },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);

    const note = await authedRequest<{
      ok: true;
      data: { note: { revision: number; payload: { ciphertext: string } } };
    }>(`/notes/${id}`, jar);
    expect(note.body.data.note.revision).toBe(2);
    expect(note.body.data.note.payload.ciphertext).toBe("cmVtb3Rl");
  });

  it("writes a merged payload", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });
    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;

    await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "merged", payload: envelope("bWVyZ2Vk") },
    });

    const note = await authedRequest<{
      ok: true;
      data: { note: { payload: { ciphertext: string } } };
    }>(`/notes/${id}`, jar);
    expect(note.body.data.note.payload.ciphertext).toBe("bWVyZ2Vk");
  });

  it("refuses to resolve against a note that moved again", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });
    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;

    // The note advances again, so resolving now would discard that newer work.
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 2, payload: envelope("dGhpcmQ=") },
    });

    const resolved = await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "local", payload: envelope("bG9jYWw=") },
    });

    expect(resolved.status).toBe(409);
    expect((await conflicts()).some((entry) => entry.objectId === id)).toBe(true);
  });

  it("requires a payload when keeping local or merging", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });
    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;

    expect(
      (
        await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
          method: "POST",
          body: { resolution: "local" },
        })
      ).status,
    ).toBe(400);
  });

  it("reports an already resolved conflict rather than resolving it twice", async () => {
    const id = nextId();
    await createNote(id, "b3JpZ2luYWw=");
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/notes/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("bG9jYWw=") },
    });
    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;

    await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "remote" },
    });
    const again = await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "remote" },
    });

    expect(again.status).toBe(412);
  });
});

describe("folder conflicts (§16)", () => {
  /** Creates a folder and returns the revision the server assigned it. */
  async function createFolder(id: string) {
    const response = await authedRequest<{ ok: true; data: { folder: { revision: number } } }>(
      "/folders",
      jar,
      {
        method: "POST",
        body: { id, parentId: null, name: envelope("Zm9sZGVy") },
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.folder.revision;
  }

  it("records a conflict when a move is based on a stale revision", async () => {
    const id = nextId();
    const revision = await createFolder(id);
    // Somewhere else the folder is renamed.
    await authedRequest(`/folders/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: revision, name: envelope("cmVuYW1lZA==") },
    });

    const stale = await authedRequest(`/folders/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: revision, parentId: null },
    });

    // A folder move is no longer last-write-wins: it becomes a conflict with both sides kept.
    expect(stale.status).toBe(409);
    const open = (await conflicts()).filter((entry) => entry.objectId === id);
    expect(open).toHaveLength(1);
    expect(open[0]!.baseRevision).toBe(revision);
  });

  it("advances the revision on every accepted update", async () => {
    const id = nextId();
    const first = await createFolder(id);

    const renamed = await authedRequest<{ ok: true; data: { folder: { revision: number } } }>(
      `/folders/${id}`,
      jar,
      { method: "PATCH", body: { baseRevision: first, name: envelope("bmV3") } },
    );

    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data.folder.revision).toBe(first + 1);
  });

  it("still accepts an update that carries no base revision", async () => {
    // Not every caller is a syncing client, and the field is optional.
    const id = nextId();
    await createFolder(id);

    const response = await authedRequest(`/folders/${id}`, jar, {
      method: "PATCH",
      body: { sortOrder: 3 },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("resolves a folder conflict by writing the chosen name as a new revision", async () => {
    const id = nextId();
    const revision = await createFolder(id);
    await authedRequest(`/folders/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: revision, name: envelope("cmVtb3Rl") },
    });
    await authedRequest(`/folders/${id}`, jar, {
      method: "PATCH",
      body: { baseRevision: revision, name: envelope("bG9jYWw=") },
    });
    const conflict = (await conflicts()).find((entry) => entry.objectId === id)!;

    const before = await authedRequest<{ ok: true; data: { cursor: number } }>(
      "/sync/changes?since=0",
      jar,
    );
    const resolved = await authedRequest(`/conflicts/${conflict.id}/resolve`, jar, {
      method: "POST",
      body: { resolution: "local", payload: envelope("bG9jYWw=") },
    });

    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);

    const folder = await authedRequest<{
      ok: true;
      data: { folder: { revision: number; name: { ciphertext: string } } };
    }>(`/folders/${id}`, jar);
    expect(folder.body.data.folder.name.ciphertext).toBe("bG9jYWw=");
    expect(folder.body.data.folder.revision).toBe(conflict.remoteRevision + 1);

    // And other devices learn about it through the feed.
    const after = await authedRequest<{
      ok: true;
      data: { changes: Array<{ objectType: string; objectId: string; revision: number | null }> };
    }>(`/sync/changes?since=${before.body.data.cursor}`, jar);
    const change = after.body.data.changes.find((entry) => entry.objectId === id);
    expect(change?.objectType).toBe("folder");
    expect(change?.revision).toBe(conflict.remoteRevision + 1);
  });
});
