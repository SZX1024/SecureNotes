import { MAX_FOLDER_DEPTH } from "@securenotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  authedRequest,
  createAccount,
  errorCode,
  loginOnce,
  resetRateLimits,
  testEnv,
  type CookieJar,
  type TestAccount,
} from "./support";

/**
 * Folders (§9, §10).
 *
 * The behaviour worth testing is not CRUD: it is the depth ceiling across a
 * move, that a subtree cannot be moved into itself, and that deleting a folder
 * takes its notes to the recycle bin while keeping every id and relationship.
 */

let account: TestAccount;
let jar: CookieJar;

const NAME = {
  crypto_version: 1,
  key_version: 1,
  alg: "AES-256-GCM" as const,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "Zm9v",
};

interface FolderDto {
  id: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  deletedAt: number | null;
}

async function createFolder(id: string, parentId: string | null = null) {
  return authedRequest<{ ok: true; data: { folder: FolderDto } }>("/folders", jar, {
    method: "POST",
    body: { id, parentId, name: NAME },
  });
}

beforeAll(async () => {
  account = await createAccount();
  jar = (await loginOnce(account)).jar;
});

beforeEach(resetRateLimits);

describe("folders: structure (§9, §10)", () => {
  it("creates a root folder at depth 1 and a child at depth 2", async () => {
    const root = await createFolder("folder-root");
    expect(root.status, JSON.stringify(root.body)).toBe(201);
    expect(root.body.data.folder.depth).toBe(1);

    const child = await createFolder("folder-child", "folder-root");
    expect(child.body.data.folder.depth).toBe(2);
    expect(child.body.data.folder.parentId).toBe("folder-root");
  });

  it("enforces the maximum depth of 10", async () => {
    let parent: string | null = null;
    for (let depth = 1; depth <= MAX_FOLDER_DEPTH; depth += 1) {
      const id = `folder-depth-${depth}`;
      const response = await createFolder(id, parent);
      expect(response.status, `depth ${depth}`).toBe(201);
      parent = id;
    }

    // One level deeper must be refused, not silently stored.
    const tooDeep = await createFolder("folder-depth-11", parent);
    expect(tooDeep.status).toBe(412);
    expect(errorCode(tooDeep.body)).toBe("PRECONDITION_FAILED");
  });

  it("lists folders with their depth", async () => {
    await createFolder("folder-list-a");
    await createFolder("folder-list-b", "folder-list-a");

    const response = await authedRequest<{
      ok: true;
      data: { folders: FolderDto[]; maxDepth: number };
    }>("/folders", jar);

    expect(response.body.data.maxDepth).toBe(MAX_FOLDER_DEPTH);
    const ids = response.body.data.folders.map((folder) => folder.id);
    expect(ids).toContain("folder-list-a");
    expect(ids).toContain("folder-list-b");
  });

  it("moves a subtree and keeps every descendant's depth consistent", async () => {
    await createFolder("move-a");
    await createFolder("move-a-child", "move-a");
    await createFolder("move-a-grandchild", "move-a-child");
    await createFolder("move-b");

    const moved = await authedRequest<{ ok: true; data: { folder: FolderDto } }>(
      "/folders/move-a",
      jar,
      { method: "PATCH", body: { parentId: "move-b" } },
    );

    expect(moved.status).toBe(200);
    expect(moved.body.data.folder.depth).toBe(2);

    const rows = await testEnv.DB.prepare(
      "SELECT id, depth FROM folders WHERE id LIKE 'move-a%' ORDER BY depth",
    ).all<{ id: string; depth: number }>();
    const depths = Object.fromEntries(rows.results.map((row) => [row.id, row.depth]));

    // The whole branch moved down by one level, relative depths preserved.
    expect(depths["move-a"]).toBe(2);
    expect(depths["move-a-child"]).toBe(3);
    expect(depths["move-a-grandchild"]).toBe(4);
  });

  it("refuses a move that would push a leaf past the maximum", async () => {
    // A chain of 9 near the root, then a subtree of height 2 to hang under it.
    let parent: string | null = null;
    for (let depth = 1; depth <= MAX_FOLDER_DEPTH - 1; depth += 1) {
      await createFolder(`deep-${depth}`, parent);
      parent = `deep-${depth}`;
    }
    await createFolder("tall-root");
    await createFolder("tall-child", "tall-root");
    await createFolder("tall-grandchild", "tall-child");

    // Attaching the 3-level subtree under a depth-9 folder would reach depth 11.
    const response = await authedRequest("/folders/tall-root", jar, {
      method: "PATCH",
      body: { parentId: parent },
    });

    expect(response.status).toBe(412);
    // Nothing moved: the check runs before any write.
    const stillRoot = await testEnv.DB.prepare(
      "SELECT depth AS d FROM folders WHERE id = 'tall-root'",
    ).first<number>("d");
    expect(stillRoot).toBe(1);
  });

  it("refuses to move a folder into its own subtree", async () => {
    await createFolder("cycle-a");
    await createFolder("cycle-b", "cycle-a");

    const response = await authedRequest("/folders/cycle-a", jar, {
      method: "PATCH",
      body: { parentId: "cycle-b" },
    });

    expect(response.status).toBe(412);
  });

  it("renames a folder without touching its structure", async () => {
    await createFolder("rename-a");
    const renamed = await authedRequest<{ ok: true; data: { folder: FolderDto } }>(
      "/folders/rename-a",
      jar,
      { method: "PATCH", body: { name: { ...NAME, ciphertext: "bmV3" } } },
    );

    expect(renamed.status).toBe(200);
    expect(renamed.body.data.folder.depth).toBe(1);
    const stored = await testEnv.DB.prepare(
      "SELECT name_ciphertext AS ct FROM folders WHERE id = 'rename-a'",
    ).first<string>("ct");
    expect(stored).toBe("bmV3");
  });
});

describe("folders: recycle bin (§9, §19)", () => {
  it("soft deletes a subtree with its notes and restores it completely", async () => {
    await createFolder("bin-parent");
    await createFolder("bin-child", "bin-parent");

    for (const [id, folderId] of [
      ["bin-note-1", "bin-parent"],
      ["bin-note-2", "bin-child"],
    ] as const) {
      await authedRequest("/notes", jar, {
        method: "POST",
        body: { id, folderId, payload: NAME },
      });
    }

    const deleted = await authedRequest<{ ok: true; data: { folders: number; notes: number } }>(
      "/folders/bin-parent",
      jar,
      { method: "DELETE" },
    );

    expect(deleted.status).toBe(200);
    expect(deleted.body.data.folders).toBe(2);
    expect(deleted.body.data.notes).toBe(2);

    // Both notes are in the recycle bin, and the parent relationship survives.
    const bin = await authedRequest<{ ok: true; data: { notes: Array<{ id: string }> } }>(
      "/recycle-bin",
      jar,
    );
    const binned = bin.body.data.notes.map((note) => note.id);
    expect(binned).toContain("bin-note-1");
    expect(binned).toContain("bin-note-2");

    const child = await testEnv.DB.prepare(
      "SELECT parent_id AS p, deleted_at AS d FROM folders WHERE id = 'bin-child'",
    ).first<{ p: string; d: number | null }>();
    expect(child?.p).toBe("bin-parent");
    expect(child?.d).toBeGreaterThan(0);

    const restored = await authedRequest<{ ok: true; data: { folders: number; notes: number } }>(
      "/folders/bin-parent/restore",
      jar,
      { method: "POST" },
    );
    expect(restored.body.data.folders).toBe(2);
    expect(restored.body.data.notes).toBe(2);

    const active = await authedRequest<{ ok: true; data: { notes: Array<{ id: string }> } }>(
      "/notes",
      jar,
    );
    const visible = active.body.data.notes.map((note) => note.id);
    expect(visible).toContain("bin-note-1");
    expect(visible).toContain("bin-note-2");
  });

  it("purges a subtree deepest-first with its notes", async () => {
    await createFolder("purge-parent");
    await createFolder("purge-child", "purge-parent");
    await authedRequest("/notes", jar, {
      method: "POST",
      body: { id: "purge-note", folderId: "purge-child", payload: NAME },
    });

    const purged = await authedRequest<{ ok: true; data: { folders: number; notes: number } }>(
      "/folders/purge-parent/permanent",
      jar,
      { method: "DELETE" },
    );

    expect(purged.status).toBe(200);
    expect(purged.body.data.folders).toBe(2);
    expect(purged.body.data.notes).toBe(1);

    for (const table of ["folders", "notes"]) {
      const remaining = await testEnv.DB.prepare(
        `SELECT count(*) AS c FROM ${table} WHERE id LIKE 'purge-%'`,
      ).first<number>("c");
      expect(remaining, table).toBe(0);
    }
  });

  it("treats another account's folder id as not found", async () => {
    const otherUser = "00000000-0000-7000-8000-000000000902";
    await testEnv.DB.prepare(
      `INSERT INTO users (id, username, kdf_salt, created_at, updated_at)
       VALUES (?1, 'folder-tenant', 'salt', ?2, ?2)`,
    )
      .bind(otherUser, Date.now())
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO folders (id, user_id, parent_id, depth, name_iv, name_ciphertext, crypto_version, key_version, created_at, updated_at)
       VALUES ('folder-other', ?1, NULL, 1, ?2, ?3, 1, 1, ?4, ?4)`,
    )
      .bind(otherUser, NAME.iv, NAME.ciphertext, Date.now())
      .run();

    for (const [method, path] of [
      ["GET", "/folders/folder-other"],
      ["DELETE", "/folders/folder-other"],
      ["PATCH", "/folders/folder-other"],
    ] as const) {
      const response = await authedRequest(path, jar, {
        method,
        ...(method === "PATCH" ? { body: { sortOrder: 1 } } : method === "DELETE" ? {} : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    const list = await authedRequest<{ ok: true; data: { folders: FolderDto[] } }>("/folders", jar);
    expect(list.body.data.folders.map((folder) => folder.id)).not.toContain("folder-other");
  });
});

describe("a replayed create is idempotent", () => {
  it("returns the folder that already exists", async () => {
    const id = "018f0000-0000-7000-8000-0000000folder";
    const first = await authedRequest(`/folders`, jar, {
      method: "POST",
      body: { id, parentId: null, name: NAME },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // The upload queue is durable: a lost acknowledgement replays the create. Answering with a conflict
    // would pause the folder and, worse, leave every note inside it unable to upload — the note's folder id
    // is a foreign key on the server.
    const replay = await authedRequest<{ ok: true; data: { folder: { id: string } } }>(
      `/folders`,
      jar,
      {
        method: "POST",
        body: { id, parentId: null, name: NAME },
      },
    );

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.folder.id).toBe(id);
  });

  it("returns the tag that already exists", async () => {
    const id = "018f0000-0000-7000-8000-000000000tag".replace("tag", "aaa");
    const first = await authedRequest(`/tags`, jar, {
      method: "POST",
      body: { id, name: NAME },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const replay = await authedRequest<{ ok: true; data: { tag: { id: string } } }>(`/tags`, jar, {
      method: "POST",
      body: { id, name: NAME },
    });

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.tag.id).toBe(id);
  });
});
