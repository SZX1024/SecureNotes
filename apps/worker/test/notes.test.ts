import { MAX_HISTORICAL_REVISIONS } from "@securenotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiRequest,
  authedRequest,
  createAccount,
  errorCode,
  loginOnce,
  resetRateLimits,
  testEnv,
  type CookieJar,
  type NoteDto,
  type TestAccount,
} from "./support";

/**
 * Notes API (§9, §18, §19, §27).
 *
 * The interesting behaviour is not the CRUD: it is the concurrency control, the
 * bounded history, the recycle-bin semantics, and that a note id from somewhere
 * else is still not found.
 */

let account: TestAccount;
let jar: CookieJar;

const ENVELOPE = {
  crypto_version: 1,
  key_version: 1,
  alg: "AES-256-GCM" as const,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "Zm9vYmFyYmF6cXV4",
};

function envelope(ciphertext: string) {
  return { ...ENVELOPE, ciphertext };
}

async function createNote(id: string, folderId: string | null = null) {
  return authedRequest<{ ok: true; data: { note: NoteDto } }>("/notes", jar, {
    method: "POST",
    body: { id, folderId, payload: envelope("Zm9v") },
  });
}

beforeAll(async () => {
  account = await createAccount();
  jar = (await loginOnce(account)).jar;
});

beforeEach(resetRateLimits);

describe("notes: create and read (§9)", () => {
  it("creates a note with revision 1 and its first history entry", async () => {
    const response = await createNote("note-create-1");

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const note = response.body.data.note;
    expect(note.revision).toBe(1);
    expect(note.folderId).toBeNull();
    expect(note.deletedAt).toBeNull();
    expect(note.payload).toEqual(envelope("Zm9v"));

    // The current revision is also the newest history entry (§9).
    const revisions = await authedRequest<{
      ok: true;
      data: { revisions: Array<{ revision: number; current: boolean; saveReason: string }> };
    }>("/notes/note-create-1/revisions", jar);
    expect(revisions.body.data.revisions).toHaveLength(1);
    expect(revisions.body.data.revisions[0]).toMatchObject({
      revision: 1,
      current: true,
      saveReason: "initial",
    });
  });

  it("rejects a duplicate id", async () => {
    await createNote("note-duplicate");
    const again = await createNote("note-duplicate");

    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe("CONFLICT");
  });

  it("returns the note by id and 404s for an unknown one", async () => {
    await createNote("note-read-1");

    const found = await authedRequest<{ ok: true; data: { note: { id: string } } }>(
      "/notes/note-read-1",
      jar,
    );
    expect(found.status).toBe(200);
    expect(found.body.data.note.id).toBe("note-read-1");

    const missing = await authedRequest("/notes/does-not-exist", jar);
    expect(missing.status).toBe(404);
  });

  it("validates the payload envelope and the id charset", async () => {
    const badId = await authedRequest("/notes", jar, {
      method: "POST",
      body: { id: "not a valid id!", payload: envelope("Zm9v") },
    });
    expect(badId.status).toBe(400);

    const badEnvelope = await authedRequest("/notes", jar, {
      method: "POST",
      body: { id: "note-bad-envelope", payload: { ...ENVELOPE, alg: "AES-128-GCM" } },
    });
    expect(badEnvelope.status).toBe(400);
  });

  it("never stores or returns a plaintext title or body field", async () => {
    const response = await authedRequest("/notes", jar, {
      method: "POST",
      body: { id: "note-opaque", payload: envelope("Zm9v"), title: "Groceries" },
    });

    // Unexpected fields are rejected rather than ignored (§14).
    expect(response.status).toBe(400);

    await createNote("note-opaque-2");
    const fetched = await authedRequest<{ ok: true; data: { note: NoteDto } }>(
      "/notes/note-opaque-2",
      jar,
    );
    expect(Object.keys(fetched.body.data.note)).not.toContain("title");
    expect(Object.keys(fetched.body.data.note)).not.toContain("body");
  });
});

describe("notes: optimistic locking (§27)", () => {
  it("accepts an update whose base revision matches", async () => {
    await createNote("note-lock-1");

    const response = await authedRequest<{ ok: true; data: { note: { revision: number } } }>(
      "/notes/note-lock-1",
      jar,
      { method: "PATCH", body: { baseRevision: 1, payload: envelope("dXBkYXRlZA==") } },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.note.revision).toBe(2);
  });

  it("refuses a stale base revision instead of overwriting", async () => {
    await createNote("note-lock-2");
    await authedRequest("/notes/note-lock-2", jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("Zmlyc3Q=") },
    });

    // A second writer that still believes revision 1 exists must not win.
    const stale = await authedRequest("/notes/note-lock-2", jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("c2Vjb25k") },
    });

    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe("REVISION_CONFLICT");

    const current = await authedRequest<{
      ok: true;
      data: { note: { revision: number; payload: { ciphertext: string } } };
    }>("/notes/note-lock-2", jar);
    expect(current.body.data.note.revision).toBe(2);
    expect(current.body.data.note.payload.ciphertext).toBe("Zmlyc3Q=");
  });

  it("keeps notes.revision equal to the newest stored revision", async () => {
    await createNote("note-lock-3");
    for (let revision = 1; revision <= 3; revision += 1) {
      await authedRequest("/notes/note-lock-3", jar, {
        method: "PATCH",
        body: { baseRevision: revision, payload: envelope("c3RlcA==") },
      });
    }

    const note = await testEnv.DB.prepare("SELECT revision AS r FROM notes WHERE id = ?1")
      .bind("note-lock-3")
      .first<number>("r");
    const newest = await testEnv.DB.prepare(
      "SELECT max(revision) AS r FROM note_revisions WHERE note_id = ?1",
    )
      .bind("note-lock-3")
      .first<number>("r");

    expect(note).toBe(4);
    expect(newest).toBe(4);
  });

  it("refuses to update a note in the recycle bin", async () => {
    await createNote("note-lock-4");
    await authedRequest("/notes/note-lock-4", jar, { method: "DELETE" });

    const response = await authedRequest("/notes/note-lock-4", jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("Zm9v") },
    });
    expect(response.status).toBe(412);
  });
});

describe("notes: version history (§18)", () => {
  it("creates a new current revision when a historical one is restored", async () => {
    await createNote("note-history-1");
    await authedRequest("/notes/note-history-1", jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("c2Vjb25k") },
    });

    const before = await authedRequest<{
      ok: true;
      data: { revisions: Array<{ id: string; revision: number }> };
    }>("/notes/note-history-1/revisions", jar);
    const firstRevisionId = before.body.data.revisions.find((entry) => entry.revision === 1)!.id;

    const restored = await authedRequest<{
      ok: true;
      data: { note: { revision: number; payload: { ciphertext: string } } };
    }>(`/notes/note-history-1/revisions/${firstRevisionId}/restore`, jar, { method: "POST" });

    expect(restored.status).toBe(200);
    // Restoring rewinds nothing: it appends revision 3 that *contains* revision 1.
    expect(restored.body.data.note.revision).toBe(3);
    expect(restored.body.data.note.payload.ciphertext).toBe("Zm9v");

    const after = await authedRequest<{ ok: true; data: { revisions: unknown[] } }>(
      "/notes/note-history-1/revisions",
      jar,
    );
    expect(after.body.data.revisions).toHaveLength(3);
  });

  it("keeps the current revision plus at most ten historical ones", async () => {
    await createNote("note-history-2");

    for (let revision = 1; revision <= MAX_HISTORICAL_REVISIONS + 5; revision += 1) {
      const response = await authedRequest("/notes/note-history-2", jar, {
        method: "PATCH",
        body: { baseRevision: revision, payload: envelope("c3RlcA==") },
      });
      expect(response.status, `revision ${revision}`).toBe(200);
    }

    const revisions = await authedRequest<{
      ok: true;
      data: { revisions: Array<{ revision: number }> };
    }>("/notes/note-history-2/revisions", jar);

    // 1 current + 10 historical, with the oldest ones permanently dropped.
    expect(revisions.body.data.revisions).toHaveLength(MAX_HISTORICAL_REVISIONS + 1);
    expect(revisions.body.data.revisions[0]!.revision).toBe(MAX_HISTORICAL_REVISIONS + 6);
    expect(revisions.body.data.revisions.at(-1)!.revision).toBe(6);
  });

  it("404s for a revision of another note", async () => {
    await createNote("note-history-3");
    await createNote("note-history-4");

    const response = await authedRequest(
      "/notes/note-history-3/revisions/note-history-4-r1/restore",
      jar,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });
});

describe("notes: recycle bin (§19)", () => {
  it("soft deletes, lists and restores without losing identity", async () => {
    await createNote("note-bin-1");
    await authedRequest("/notes/note-bin-1", jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("c2Vjb25k") },
    });

    const deleted = await authedRequest<{ ok: true; data: { note: { deletedAt: number } } }>(
      "/notes/note-bin-1",
      jar,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.note.deletedAt).toBeGreaterThan(0);

    const bin = await authedRequest<{ ok: true; data: { notes: Array<{ id: string }> } }>(
      "/recycle-bin",
      jar,
    );
    expect(bin.body.data.notes.map((note) => note.id)).toContain("note-bin-1");

    const active = await authedRequest<{ ok: true; data: { notes: Array<{ id: string }> } }>(
      "/notes",
      jar,
    );
    expect(active.body.data.notes.map((note) => note.id)).not.toContain("note-bin-1");

    const restored = await authedRequest<{
      ok: true;
      data: { note: { deletedAt: null; revision: number } };
    }>("/notes/note-bin-1/restore", jar, { method: "POST" });
    expect(restored.body.data.note.deletedAt).toBeNull();
    // Restoration preserves the revision, so no history was lost.
    expect(restored.body.data.note.revision).toBe(2);
  });

  it("permanent deletion removes the current and historical data", async () => {
    await createNote("note-bin-2");
    await authedRequest("/notes/note-bin-2", jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("c2Vjb25k") },
    });
    await authedRequest("/notes/note-bin-2", jar, { method: "DELETE" });

    const purged = await authedRequest("/notes/note-bin-2/permanent", jar, { method: "DELETE" });
    expect(purged.status).toBe(200);

    const note = await testEnv.DB.prepare("SELECT count(*) AS c FROM notes WHERE id = ?1")
      .bind("note-bin-2")
      .first<number>("c");
    const revisions = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM note_revisions WHERE note_id = ?1",
    )
      .bind("note-bin-2")
      .first<number>("c");

    expect(note).toBe(0);
    expect(revisions).toBe(0);
  });
});

describe("notes: sync feed (§16)", () => {
  it("records every mutation as a change with a monotonic cursor", async () => {
    await createNote("note-sync-1");
    await authedRequest("/notes/note-sync-1", jar, {
      method: "PATCH",
      body: { baseRevision: 1, payload: envelope("c2Vjb25k") },
    });
    await authedRequest("/notes/note-sync-1", jar, { method: "DELETE" });

    const changes = await testEnv.DB.prepare(
      "SELECT change_type AS t, revision AS r, seq FROM sync_changes WHERE object_id = ?1 ORDER BY seq",
    )
      .bind("note-sync-1")
      .all<{ t: string; r: number | null; seq: number }>();

    expect(changes.results.map((row) => row.t)).toEqual(["create", "update", "delete"]);
    expect(changes.results.map((row) => row.r)).toEqual([1, 2, 2]);
    // Cursors strictly increase, so a client can never skip a change.
    const cursors = changes.results.map((row) => row.seq);
    expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
  });
});

describe("notes: authorization (§26)", () => {
  it("treats another account's note id as not found", async () => {
    // A second account row cannot be created through the API, so it is inserted
    // directly to model another tenant's note.
    const otherUser = "00000000-0000-7000-8000-000000000901";
    await testEnv.DB.prepare(
      `INSERT INTO users (id, username, kdf_salt, created_at, updated_at)
       VALUES (?1, 'note-tenant', 'salt', ?2, ?2)`,
    )
      .bind(otherUser, Date.now())
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO notes (id, user_id, folder_id, revision, payload_iv, payload_ciphertext, crypto_version, key_version, created_at, updated_at)
       VALUES ('note-other-tenant', ?1, NULL, 1, ?2, ?3, 1, 1, ?4, ?4)`,
    )
      .bind(otherUser, ENVELOPE.iv, ENVELOPE.ciphertext, Date.now())
      .run();

    for (const [method, path] of [
      ["GET", "/notes/note-other-tenant"],
      ["DELETE", "/notes/note-other-tenant"],
      ["GET", "/notes/note-other-tenant/revisions"],
    ] as const) {
      const response = await authedRequest(path, jar, {
        method,
        ...(method === "GET" ? {} : { body: {} }),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    // And it does not appear in this account's listing.
    const list = await authedRequest<{ ok: true; data: { notes: Array<{ id: string }> } }>(
      "/notes",
      jar,
    );
    expect(list.body.data.notes.map((note) => note.id)).not.toContain("note-other-tenant");
  });

  it("requires authentication for every note route", async () => {
    for (const [method, path] of [
      ["GET", "/notes"],
      ["POST", "/notes"],
      ["GET", "/recycle-bin"],
    ] as const) {
      const response = await apiRequest(path, {
        method,
        ...(method === "GET" ? {} : { body: {} }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
