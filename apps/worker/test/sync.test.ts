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
 * The incremental sync feed (§16).
 *
 * What the client depends on: a cursor it can hold, every change delivered exactly once, deletions
 * delivered as tombstones so a device that was offline for a month still learns about them, and the
 * payload inline so a pull is one round trip.
 */

let account: TestAccount;
let jar: CookieJar;

const envelope = (ciphertext: string) => ({
  crypto_version: 1,
  key_version: 1,
  alg: "AES-256-GCM" as const,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext,
});

interface FeedChange {
  seq: number;
  objectType: string;
  objectId: string;
  changeType: string;
  revision: number | null;
  payload: Record<string, unknown> | null;
}

async function feed(since: number, limit?: number) {
  const query = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`;
  const response = await authedRequest<{
    ok: true;
    data: { cursor: number; changes: FeedChange[]; hasMore: boolean };
  }>(`/sync/changes?${query}`, jar);
  return response;
}

beforeAll(async () => {
  account = await createAccount();
  jar = (await loginOnce(account)).jar;
});

beforeEach(resetRateLimits);

describe("sync feed (§16)", () => {
  it("delivers creates, updates and deletes in order, once each", async () => {
    await authedRequest("/notes", jar, {
      method: "POST",
      body: { id: "feed-note", folderId: null, payload: envelope("Zm9v") },
    });
    await authedRequest("/notes/feed-note", jar, {
      method: "PATCH",
      body: { baseRevision: 1, folderId: null, payload: envelope("YmFy") },
    });
    await authedRequest("/notes/feed-note", jar, { method: "DELETE" });

    const first = await feed(0);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const forNote = first.body.data.changes.filter((change) => change.objectId === "feed-note");
    expect(forNote.map((change) => change.changeType)).toEqual(["create", "update", "delete"]);
    // Sequence numbers strictly increase, which is what makes the cursor safe.
    expect([...first.body.data.changes].map((c) => c.seq)).toEqual(
      [...first.body.data.changes].map((c) => c.seq).sort((a, b) => a - b),
    );
    expect(new Set(first.body.data.changes.map((c) => c.seq)).size).toBe(
      first.body.data.changes.length,
    );
  });

  it("carries the encrypted payload inline, and none for a delete", async () => {
    await authedRequest("/notes", jar, {
      method: "POST",
      body: { id: "feed-payload", folderId: null, payload: envelope("c2VjcmV0") },
    });

    const batch = await feed(0);
    const created = batch.body.data.changes.find((change) => change.objectId === "feed-payload")!;

    expect(created.payload).not.toBeNull();
    const payload = created.payload as { payload: { ciphertext: string } };
    expect(payload.payload.ciphertext).toBe("c2VjcmV0");
    // The feed is a transport for ciphertext: nothing in it is readable as plaintext.
    expect(JSON.stringify(created.payload)).not.toContain("secret");

    await authedRequest("/notes/feed-payload", jar, { method: "DELETE" });
    const afterDelete = await feed(batch.body.data.cursor);
    const deleted = afterDelete.body.data.changes.find(
      (change) => change.objectId === "feed-payload",
    )!;

    // A deletion is a tombstone: it must appear, and it has nothing to carry.
    expect(deleted.changeType).toBe("delete");
    expect(deleted.payload).toBeNull();
  });

  it("delivers folders and tags too, so a device can rebuild all of it", async () => {
    await authedRequest("/folders", jar, {
      method: "POST",
      body: { id: "feed-folder", parentId: null, name: envelope("Zm9sZGVy") },
    });
    await authedRequest("/tags", jar, {
      method: "POST",
      body: { id: "feed-tag", name: envelope("dGFn") },
    });

    const batch = await feed(0);
    const byId = new Map(batch.body.data.changes.map((change) => [change.objectId, change]));

    expect(byId.get("feed-folder")?.objectType).toBe("folder");
    expect(byId.get("feed-tag")?.objectType).toBe("tag");
    expect(
      (byId.get("feed-tag")?.payload as { name: { ciphertext: string } }).name.ciphertext,
    ).toBe("dGFn");
  });

  it("resumes exactly where a cursor left off", async () => {
    const before = await feed(0);
    const cursor = before.body.data.cursor;

    await authedRequest("/notes", jar, {
      method: "POST",
      body: { id: "feed-resume", folderId: null, payload: envelope("bmV3") },
    });

    const after = await feed(cursor);
    expect(after.body.data.changes.map((change) => change.objectId)).toEqual(["feed-resume"]);

    // Nothing new: the cursor stays put rather than moving to some later value.
    const again = await feed(after.body.data.cursor);
    expect(again.body.data.changes).toEqual([]);
    expect(again.body.data.cursor).toBe(after.body.data.cursor);
  });

  it("pages without skipping a change", async () => {
    for (let index = 0; index < 5; index += 1) {
      await authedRequest("/notes", jar, {
        method: "POST",
        body: { id: `feed-page-${index}`, folderId: null, payload: envelope("cGFnZQ==") },
      });
    }

    const seen: number[] = [];
    let cursor = 0;
    let rounds = 0;
    for (;;) {
      const batch = await feed(cursor, 2);
      expect(batch.body.data.changes.length).toBeLessThanOrEqual(2);
      seen.push(...batch.body.data.changes.map((change) => change.seq));
      cursor = batch.body.data.cursor;
      rounds += 1;
      if (!batch.body.data.hasMore || rounds > 20) {
        break;
      }
    }

    // Every sequence number seen exactly once, and `hasMore` stopped the loop.
    expect(new Set(seen).size).toBe(seen.length);
    expect(rounds).toBeGreaterThan(1);
    const all = await feed(0);
    for (const change of all.body.data.changes) {
      expect(seen).toContain(change.seq);
    }
  });

  it("rejects a cursor or limit that is not a sane number", async () => {
    expect((await authedRequest("/sync/changes?since=-1", jar)).status).toBe(400);
    expect((await authedRequest("/sync/changes?since=abc", jar)).status).toBe(400);
    expect((await authedRequest("/sync/changes?since=0&limit=0", jar)).status).toBe(400);
  });

  it("requires a session", async () => {
    const response = await authedRequest("/sync/changes?since=0", { header: "" } as CookieJar);
    expect(response.status).toBe(401);
  });
});
