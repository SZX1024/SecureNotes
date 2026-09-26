import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";

import { ApiError, apiRequest } from "./api/client";
import { applyRemote } from "./sync/apply";
import { hasSessionCookie, isOnline, pullChanges, pushChange } from "./sync/client";
import { loadNoteConflict, resolveNoteConflict } from "./sync/conflicts-client";
import { threeWayMerge } from "./sync/merge";
import type { ConflictSides } from "./sync/conflicts-client";
import { enqueueChange } from "./local/sync-queue";
import { listLocalConflicts, syncNow, type SyncState } from "./sync/engine";
import { SyncScheduler, attachSyncTriggers } from "./sync/scheduler";
import {
  beginTotpRebind,
  completeTotpRebind,
  enrolAccount,
  forgetLocalKeys,
  signIn,
  verifyTotpRebind,
  type StartedRebind,
  signInWithRecoveryCode,
  unlockWithDeviceKey,
  type UnlockedAccount,
} from "./app/flows";
import {
  createLocalNote,
  deleteLocalNote,
  readAllLocalNotes,
  updateLocalNote,
  type LocalContext,
  type StoredNote,
} from "./data/repository";
import { openAppDatabase } from "./local/migrations";
import { KeyStore } from "./local/key-store";
import type { SecureNotesDatabase } from "./local/schema";
import { NoteSearchIndex, highlightSegments } from "./search";
import { MAX_ATTACHMENT_BYTES, MAX_TAGS_PER_NOTE, type Bytes } from "@securenotes/shared";

import {
  createLocalFolder,
  createLocalTag,
  deleteLocalFolder,
  deleteLocalTag,
  readLocalFolderName,
  readLocalNote,
  readLocalNoteTags,
  readLocalTagName,
  renameLocalTag,
  setLocalNoteTags,
  updateLocalFolder,
  updateLocalNoteMetadata,
  enqueueAttachmentLinkChange,
} from "./data/repository";
import {
  buildFolderTree,
  notesInFolder,
  planTagChange,
  type FolderNode,
  type FolderRow,
} from "./data/organisation";
import { ActivityBar } from "./ui/ActivityBar";
import { VIEW_LABELS, type PanelView } from "./ui/panels";
import { Icon } from "./ui/Icon";
import { MenuBar, type MenuDefinition } from "./ui/MenuBar";
import { SettingsDialog } from "./ui/SettingsDialog";
import { StatusBar } from "./ui/StatusBar";
import { Tabs, type TabView } from "./ui/Tabs";
import { addTab, isDirty, loadTabs, neighbourAfterClose, removeTab, saveTabs } from "./ui/tabs";
import { applyTypography, loadTypography, saveTypography, type Typography } from "./ui/typography";
import { FolderTree, NoteOrganisation, TagList } from "./ui/Organisation";
import { defaultEditorMode, loadEditorMode, saveEditorMode, type EditorMode } from "./editor/mode";
import {
  decideDrop,
  decidePaste,
  loadRichTextPreference,
  saveRichTextPreference,
} from "./editor/paste";
import {
  encryptAttachmentBytes,
  encryptAttachmentName,
  uploadAttachment,
} from "./data/attachments-client";
import {
  attachmentIdsInHtml,
  createAttachmentUrls,
  fetchAttachment,
  rewriteAttachmentUrls,
} from "./data/attachment-content";
import {
  buildExportArchive,
  findCollisions,
  parseExportArchive,
  type ExportArchive,
} from "./export/archive";
import { applyImport, planImport, type ImportChoice } from "./export/import";
import {
  buildRecoveryPackageFile,
  recoveryFileName,
  type RecoveryPackagePayload,
} from "./export/recovery";
import {
  LAST_EXPORT_KEY,
  collectExportSources,
  daysSinceExport,
  exportFileName,
  readLocalAttachmentNames,
  shouldRemindExport,
} from "./export/collect";
import {
  ATTACHMENT_URL_PREFIX,
  attachmentMarkdown,
  attachmentReferencesIn,
  attachmentRefsIn,
  diffAttachmentRefs,
} from "./editor/attachments";
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  type ThemePreference,
} from "./theme";
import {
  SHORTCUTS,
  buildCommands,
  filterCommands,
  formatShortcut,
  matchShortcut,
  type Command,
} from "./ui/shortcuts";
import { SORT_KEYS, SORT_LABELS, rememberOpened, sortNotes, type SortKey } from "./ui/sort";
import "./styles/app.css";

/**
 * The application shell (§10, §22).
 *
 * Structure follows the desktop layout §22 describes — folders/tags, note list,
 * editor — and every note the UI shows came out of the encrypted local store. The
 * search index is built after unlock and torn down on lock, because §11 forbids a
 * persisted plaintext index.
 */

type Screen = "loading" | "setup" | "login" | "unlock" | "app" | "recycle-bin";

/**
 * Editors and the render pipeline are loaded on demand.
 *
 * KaTeX, Milkdown/ProseMirror and CodeMirror are all large, and none of them is
 * needed to show a locked note list or an empty editor — so a static import would put
 * them in the first paint for every visitor. They arrive when a note is opened, and
 * Mermaid (the largest of all) only when a note actually contains a diagram.
 */
const loadSourceEditor = () =>
  import("./editor/MarkdownSourceEditor").then((module) => module.MarkdownSourceEditor);
const loadWysiwygEditor = () =>
  import("./editor/WysiwygEditor").then((module) => module.WysiwygEditor);
const loadRender = () => import("./render/markdown");

interface DraftNote {
  id: string;
  title: string;
  body: string;
}

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [db, setDb] = useState<SecureNotesDatabase | null>(null);
  const [account, setAccount] = useState<UnlockedAccount | null>(null);
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftNote | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("modified");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  /** Which view the side panel shows; null when it is collapsed. */
  // Notes by default: opening a notebook and being shown a folder tree is the wrong first impression.
  const [panelView, setPanelView] = useState<PanelView | null>("notes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The note whose permanent deletion is waiting for a second, explicit press. */
  const [confirmingPermanent, setConfirmingPermanent] = useState<string | null>(null);
  /** The notes that are open, oldest first. Persisted, so reopening the app reopens what was being worked on. */
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [recycleBusy, setRecycleBusy] = useState(false);
  const [typography, setTypography] = useState<Typography>(() => loadTypography(localStorage));
  const [preview, setPreview] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() =>
    typeof localStorage === "undefined" ? "system" : loadThemePreference(localStorage),
  );
  const [richTextPreference, setRichTextPreference] = useState<"html" | "plain" | null>(() =>
    typeof localStorage === "undefined" ? null : loadRichTextPreference(localStorage),
  );
  const [pastePrompt, setPastePrompt] = useState<{ html: string; text: string } | null>(null);
  /** §3: a recovery login has no authenticator to return to, so it asks for a new one. */
  const [mustRebind, setMustRebind] = useState(false);
  /** §17: the state the interface shows. */
  const [syncState, setSyncState] = useState<SyncState>("synced");
  const [conflictCount, setConflictCount] = useState(0);
  /** Which conflict is open in the resolution panel, if any. */
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);
  /** The folder tree and tags, decrypted for display, and the filters built from them (§9, §10). */
  const [folderRows, setFolderRows] = useState<FolderRow[]>([]);
  const [folderTree, setFolderTree] = useState<FolderNode[]>([]);
  const [tagList, setTagList] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [noteTagIds, setNoteTagIds] = useState<string[]>([]);
  const [tagLinks, setTagLinks] = useState<Map<string, string[]>>(new Map());
  /** Blob URLs for the attachments a preview shows, and a version that changes when one becomes ready. */
  const [attachmentVersion, setAttachmentVersion] = useState(0);
  /** When the notes were last exported, and whether an export is running (§20). */
  /** The reminder's text, decided when the clock is read rather than while rendering. */
  const [exportReminder, setExportReminder] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** An archive that has been read and validated, waiting for the user to decide about duplicates (§20). */
  const [importPrompt, setImportPrompt] = useState<{
    archive: ExportArchive;
    collisions: number;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const scheduler = useRef<SyncScheduler | null>(null);
  /** The pending retry, so it can be cancelled with the scheduler it belongs to. */
  const retryTimer = useRef<number | null>(null);
  /** The references the note had when it was opened, for the save-time diff. */
  const [openedRefs, setOpenedRefs] = useState<string[]>([]);
  const [editorMode, setEditorMode] = useState<EditorMode>(() =>
    defaultEditorMode(
      typeof window === "undefined" ? 1024 : window.innerWidth,
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false,
      typeof localStorage === "undefined" ? null : loadEditorMode(localStorage),
    ),
  );
  const [message, setMessage] = useState<string | null>(null);

  // Held as state rather than refs: the render path reads both, and reading a ref
  // during render is exactly what React forbids. `useState` with a lazy initialiser
  // gives one stable instance for the component's lifetime.
  const [keyStore] = useState(() => new KeyStore());
  const [searchIndex] = useState(() => new NoteSearchIndex());
  /**
   * Bumped whenever the index is rebuilt. The search memo depends on this rather
   * than on `notes`, so the coupling is explicit instead of hoping the two change
   * together.
   */
  const [indexVersion, setIndexVersion] = useState(0);

  /** Loads and decrypts everything, then builds the in-memory index (§11). */
  /** Loads the folder tree, the tags and the note-to-tag links, all decrypted for display. */
  const loadOrganisation = useCallback(async (context: LocalContext) => {
    const folders = await context.db.folders.toArray();
    const rows: FolderRow[] = [];
    for (const folder of folders) {
      // A name that cannot be decrypted is shown as unknown rather than omitted: the folder exists, and
      // hiding it would hide its notes with it.
      const name = await readLocalFolderName(context, folder).catch(() => "(unreadable name)");
      rows.push({
        id: folder.id,
        parentId: folder.parentId,
        name,
        depth: folder.depth,
        sortOrder: folder.sortOrder,
      });
    }
    setFolderRows(rows);
    setFolderTree(buildFolderTree(rows));

    const tags = await context.db.tags.toArray();
    const decrypted: Array<{ id: string; name: string }> = [];
    for (const tag of tags) {
      try {
        decrypted.push({ id: tag.id, name: await readLocalTagName(context, tag) });
      } catch {
        decrypted.push({ id: tag.id, name: "(unreadable name)" });
      }
    }
    setTagList(decrypted);

    const links = await context.db.noteTags.toArray();
    const byNote = new Map<string, string[]>();
    for (const link of links) {
      byNote.set(link.noteId, [...(byNote.get(link.noteId) ?? []), link.tagId]);
    }
    setTagLinks(byNote);
  }, []);

  /** Reads attachments for display. Ciphertext from the server, plaintext in a blob URL, never on disk. */
  const attachmentUrls = useMemo(
    () =>
      account
        ? createAttachmentUrls({
            dek: account.dek,
            keyVersion: account.keyVersion,
            readAttachment: async (attachmentId) => {
              // Bytes encrypted on this device come first: it is what makes an image inserted with no network
              // visible straight away, and what keeps a note readable offline.
              const row = await db?.attachments.get(attachmentId);
              if (row?.cachedBlob && row.contentIv !== null) {
                return fetchAttachment(account.dek, account.keyVersion, attachmentId, {
                  bytes: new Uint8Array(await row.cachedBlob.arrayBuffer()) as Bytes,
                  contentIv: row.contentIv,
                  contentType: row.contentType,
                });
              }
              return fetchAttachment(account.dek, account.keyVersion, attachmentId);
            },
          })
        : null,
    [account, db],
  );

  useEffect(() => {
    // Object URLs pin their bytes until they are released, so they go with the key they were decrypted with.
    return () => attachmentUrls?.dispose();
  }, [attachmentUrls]);

  /**
   * Reads the attachments the open note refers to.
   *
   * The list comes from the note's own text, so this runs whenever the draft changes and reads only what is
   * missing; the version bump is what re-renders the images once their bytes are decrypted.
   */
  useEffect(() => {
    if (!attachmentUrls || !draft) {
      return;
    }
    const ids = attachmentIdsInHtml(draft.body).filter((id) => attachmentUrls.get(id) === null);
    if (ids.length === 0) {
      return;
    }
    void attachmentUrls.load(ids).then(() => setAttachmentVersion((version) => version + 1));
  }, [attachmentUrls, draft]);

  const refresh = useCallback(
    async (database: SecureNotesDatabase, unlocked: UnlockedAccount) => {
      const context: LocalContext = {
        db: database,
        dek: unlocked.dek,
        userId: unlocked.userId,
        keyVersion: unlocked.keyVersion,
      };
      await loadOrganisation(context);
      const recorded = await database.meta.get(LAST_EXPORT_KEY);
      const exportedAt = typeof recorded?.value === "number" ? recorded.value : null;
      const sinceDays = daysSinceExport(exportedAt, Date.now());
      setExportReminder(
        shouldRemindExport(exportedAt, Date.now())
          ? sinceDays === null
            ? "You have not exported your notes yet. The only copy is the one in this browser."
            : `Last export was ${sinceDays} days ago.`
          : null,
      );
      const stored = await readAllLocalNotes(context);
      setNotes(stored);

      // Tag and folder names are not linked into the local rows yet (see
      // HANDOFF §16.2), so they are indexed as empty rather than faked.
      searchIndex.build(
        stored.map((entry) => ({
          id: entry.note.id,
          title: entry.document.title,
          body: entry.document.body,
          tags: [],
          folderName: null,
          attachmentNames: [],
          updatedAt: entry.note.updatedAt,
          createdAt: entry.note.createdAt,
          pinned: entry.note.pinned,
        })),
      );

      setIndexVersion((version) => version + 1);
      // Returned so a caller that must act on the result does not have to wait for a re-render:
      // reading `notes` from a closure in the same tick sees the previous array.
      return stored;
    },
    [searchIndex, loadOrganisation],
  );

  /** Signs the user out locally and destroys the keys (§4). */
  const lockAndForget = useCallback(
    async (reason: "signed-out" | "locked") => {
      keyStore.lock();
      searchIndex.clear();
      setAccount(null);
      setNotes([]);
      setDraft(null);
      setSelectedId(null);
      if (reason === "signed-out" && db) {
        await forgetLocalKeys(db);
      }
      setScreen(db && reason === "locked" ? "unlock" : "login");
    },
    [db, keyStore, searchIndex],
  );

  /** Any 401 means the session is gone: discard local keys and re-authenticate. */
  const handleRevocation = useCallback(async () => {
    await lockAndForget("signed-out");
    setMessage("Your session was revoked on another device. Sign in again.");
  }, [lockAndForget]);

  /** Runs one sync pass and updates what the interface shows (§17). */
  const runSyncPass = useCallback(async () => {
    if (!db || !account) {
      return;
    }
    // §17: report being offline rather than failing a pass, and do not spend a request on a session
    // that has already gone.
    if (!isOnline()) {
      setSyncState("offline");
      return;
    }
    if (!hasSessionCookie()) {
      setSyncState("auth-required");
      return;
    }

    const outcome = await syncNow({
      db,
      push: (change) =>
        pushChange(db, change, {
          // Decrypted here rather than in the engine, which has no key by design: the references are part of
          // the note's own text.
          attachmentRefs: async (noteId) => {
            const context: LocalContext = {
              db,
              dek: account.dek,
              userId: account.userId,
              keyVersion: account.keyVersion,
            };
            const stored = await readLocalNote(context, noteId);
            return stored ? attachmentRefsIn(stored.document.body) : [];
          },
        }),
      pull: (since) => pullChanges(since),
      apply: applyRemote(db),
    });

    setConflictCount((await listLocalConflicts(db)).length);

    if (outcome.stoppedBy === "auth") {
      // §16: an authentication failure waits for the user rather than retrying forever.
      setSyncState("auth-required");
      return;
    }

    if (outcome.nextRetryAt !== null) {
      // The engine scheduled the next attempt; without a timer that schedule means nothing and the entry waits
      // for the next unrelated trigger. Only the earliest one is armed, and each pass replaces the last.
      //
      // Held in a ref rather than left loose: a timer that outlives the scheduler runs after the app has locked
      // or the page has gone, and in a test environment it fires after the DOM itself has been torn down, where
      // touching `window` is an uncaught error.
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
      }
      const waitMs = Math.max(500, outcome.nextRetryAt - Date.now());
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        void scheduler.current?.syncNow();
      }, waitMs);
    }

    if (outcome.pulled > 0) {
      // A pull writes straight into the local database, so the interface has to read it again — otherwise
      // a second device downloads its notes and shows an empty list until the next login.
      await refresh(db, account);
    }
    setSyncState(outcome.state);
  }, [db, account, refresh]);

  const runRequest = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | null> => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await handleRevocation();
          return null;
        }
        setMessage(error instanceof Error ? error.message : "Something went wrong");
        return null;
      }
    },
    [handleRevocation],
  );

  // Boot: open the local database, ask whether the account exists, and decide
  // which screen to show.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const opened = await openAppDatabase(localStorage);
      if (cancelled) {
        return;
      }
      setDb(opened.db);

      const status = await apiRequest<{ initialized: boolean }>("/auth/status").catch(() => ({
        initialized: true,
      }));
      if (cancelled) {
        return;
      }
      if (!status.initialized) {
        setScreen("setup");
        return;
      }

      const material = await opened.db.keyMaterial.get("account");
      setScreen(material?.deviceWrappedDek ? "unlock" : "login");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Theme: an explicit choice wins over the system, so the attribute is set from the
  // resolved value rather than leaving the decision to CSS.
  useEffect(() => {
    const prefersDark =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
    const resolved = resolveTheme(theme, prefersDark);
    document.documentElement.dataset["theme"] = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [theme]);

  // Sync triggers (§17): a pass on startup, five seconds after editing stops, on page resume and after
  // network recovery. Everything is torn down when the app leaves the unlocked state, so a locked app
  // neither syncs nor keeps listeners.
  useEffect(() => {
    if (screen !== "app" || !db || !account) {
      return;
    }

    const instance = new SyncScheduler({ run: runSyncPass });
    scheduler.current = instance;
    const detach = attachSyncTriggers(instance);
    // Startup pass; the browser reports network recovery through the same scheduler.
    void instance.syncNow();
    const onOnline = () => void instance.syncNow();
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("online", onOnline);
      detach();
      instance.stop();
      if (retryTimer.current !== null) {
        // Cancelled with the scheduler: a retry belongs to the scheduler that armed it.
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      scheduler.current = null;
    };
  }, [screen, db, account, runSyncPass]);

  // App Lock: check on an interval so a tab left open locks itself (§7).
  useEffect(() => {
    if (screen !== "app") {
      return;
    }
    const timer = setInterval(() => {
      if (!keyStore.isUnlocked()) {
        void lockAndForget("locked");
        setMessage("Locked after 40 minutes of inactivity.");
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [screen, lockAndForget, keyStore]);

  /**
   * Opens a note from a given list.
   *
   * The list is a parameter because a closure's `notes` can be stale: creating a note loads the new
   * array and then opens it in the same tick, when the state variable still holds the previous
   * render's value — so the note appeared in the list but never opened, and the editor pane kept
   * saying "Select a note".
   */
  /**
   * Writes a complete plaintext archive and hands it to the browser (§20).
   *
   * The archive is assembled in memory and never touches browser storage: the only thing that is recorded is
   * when the export happened, which is what the reminder is measured from. §20 asks for temporary export data to
   * be cleaned up after an export, and the simplest way to be sure of that is to have none — the object URL the
   * download uses is revoked as soon as the click has been dispatched.
   */
  const exportEverything = useCallback(async () => {
    if (!db || !account) {
      return;
    }
    setExporting(true);
    try {
      const context: LocalContext = {
        db,
        dek: account.dek,
        userId: account.userId,
        keyVersion: account.keyVersion,
      };
      const sources = await collectExportSources(db);
      const names = await readLocalAttachmentNames(context);
      const now = Date.now();

      const { bytes } = await buildExportArchive(sources, {
        dek: account.dek,
        keyVersion: account.keyVersion,
        now,
        readAttachment: async (attachmentId) => {
          // Whatever is on this device is read from here, so an export works with no network and includes an
          // image inserted offline.
          const row = await db.attachments.get(attachmentId);
          const read =
            row?.cachedBlob && row.contentIv !== null
              ? await fetchAttachment(account.dek, account.keyVersion, attachmentId, {
                  bytes: new Uint8Array(await row.cachedBlob.arrayBuffer()) as Bytes,
                  contentIv: row.contentIv,
                  contentType: row.contentType,
                })
              : await fetchAttachment(account.dek, account.keyVersion, attachmentId);
          return {
            bytes: read.bytes,
            contentType: read.contentType,
            // The name the file was uploaded with; the reference's own label is the fallback, because an
            // attachment can be referenced by a note whose text was written before the name was known.
            filename: names.get(attachmentId) ?? attachmentId,
          };
        },
      });

      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(now);
      document.body.append(link);
      link.click();
      link.remove();
      // Revoked immediately: the file is the user's copy now, and a live object URL would keep the whole archive
      // in memory for as long as the page is open.
      URL.revokeObjectURL(url);

      await db.meta.put({ key: LAST_EXPORT_KEY, value: now });
      setExportReminder(null);
      setMessage(`Exported ${sources.notes.length} note(s) as a plaintext ZIP.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The export failed.");
    } finally {
      setExporting(false);
    }
  }, [db, account]);

  /**
   * Writes the account recovery package (§20).
   *
   * A separate thing from the export, and the interface says so: one restores the notes, the other restores the
   * account. The server assembles it because the client never holds the other recovery codes' wrappings, and the
   * payload contains no authenticator secret — the server has one and must not put it here.
   */
  const downloadRecoveryPackage = useCallback(async () => {
    setExporting(true);
    try {
      const { recoveryPackage } = await apiRequest<{ recoveryPackage: RecoveryPackagePayload }>(
        "/export/recovery-package",
      );
      const now = Date.now();
      const bytes = await buildRecoveryPackageFile(recoveryPackage, now);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = recoveryFileName(now);
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(
        `Recovery package saved with ${recoveryPackage.recoveryWrappings.length} recovery wrapping(s). Keep it away from your recovery codes; it contains no authenticator secret.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The recovery package could not be written.",
      );
    } finally {
      setExporting(false);
    }
  }, []);

  /**
   * Reads an archive and, if ids collide, asks what to do with them (§20).
   *
   * Nothing is written here: §20 wants the choice, and an archive that cannot be parsed is rejected with its
   * reason rather than half-applied.
   */
  const chooseImport = useCallback(
    async (file: File) => {
      if (!db) {
        return;
      }
      try {
        const archive = await parseExportArchive(new Uint8Array(await file.arrayBuffer()) as Bytes);
        const collisions = findCollisions(archive, {
          noteIds: (await db.notes.toArray()).map((note) => note.id),
          folderIds: (await db.folders.toArray()).map((folder) => folder.id),
          tagIds: (await db.tags.toArray()).map((tag) => tag.id),
          attachmentIds: (await db.attachments.toArray()).map((attachment) => attachment.id),
        });
        const total =
          collisions.notes.length +
          collisions.folders.length +
          collisions.tags.length +
          collisions.attachments.length;
        setImportPrompt({ archive, collisions: total });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The archive could not be read.");
      }
    },
    [db],
  );

  /** Applies the archive with the choice the user made. */
  const runImport = useCallback(
    async (choice: ImportChoice) => {
      if (!db || !account || !importPrompt) {
        return;
      }
      setImporting(true);
      try {
        const localNotes = await db.notes.toArray();
        const plan = planImport({
          archive: importPrompt.archive,
          existing: {
            noteIds: localNotes.map((note) => note.id),
            folderIds: (await db.folders.toArray()).map((folder) => folder.id),
            tagIds: (await db.tags.toArray()).map((tag) => tag.id),
          },
          existingNotes: await Promise.all(
            localNotes.map(async (note) => ({
              id: note.id,
              updatedAt: note.updatedAt,
              tagIds: (await db.noteTags.where("noteId").equals(note.id).toArray()).map(
                (link) => link.tagId,
              ),
            })),
          ),
          choice,
          newId: () => crypto.randomUUID(),
        });

        const report = await applyImport({
          db,
          dek: account.dek,
          keyVersion: account.keyVersion,
          plan,
          now: Date.now(),
          uploadAttachment: async (attachment) => {
            const uploaded = await uploadAttachment({
              file: new File([attachment.bytes as BlobPart], attachment.filename, {
                type: attachment.contentType,
              }),
              dek: account.dek,
              keyVersion: account.keyVersion,
              attachmentId: crypto.randomUUID(),
            });
            return uploaded.id;
          },
        });

        setImportPrompt(null);
        setMessage(
          `Imported ${report.created} new item(s), merged ${report.merged}, copied ${report.remapped}, ${report.attachments} attachment(s).`,
        );
        await refresh(db, account);
        scheduler.current?.scheduleAfterIdle();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The import failed.");
      } finally {
        setImporting(false);
      }
    },
    [db, account, importPrompt, refresh],
  );

  /** The CRUD behind the folder tree and the tag list (§9, §10). */
  const organisationActions = useMemo(() => {
    const context = (): LocalContext | null =>
      db && account
        ? { db, dek: account.dek, userId: account.userId, keyVersion: account.keyVersion }
        : null;

    const after = async (local: LocalContext) => {
      await loadOrganisation(local);
      scheduler.current?.scheduleAfterIdle();
    };

    return {
      createFolder: async (parentId: string | null, name: string) => {
        const local = context();
        if (!local) {
          return;
        }
        await createLocalFolder(local, { id: crypto.randomUUID(), parentId, name });
        await after(local);
      },
      renameFolder: async (id: string, name: string) => {
        const local = context();
        if (!local) {
          return;
        }
        await updateLocalFolder(local, { id, name });
        await after(local);
      },
      moveFolder: async (id: string, parentId: string | null) => {
        const local = context();
        if (!local) {
          return;
        }
        await updateLocalFolder(local, { id, parentId });
        await after(local);
      },
      deleteFolder: async (id: string) => {
        const local = context();
        if (!local) {
          return;
        }
        // Refused here rather than undone later: the server will not delete a folder that still holds
        // anything (children or notes), so a local delete would be resurrected by the next pull and the
        // user would watch the folder come back.
        const holdsNotes = (await local.db.notes.where("folderId").equals(id).count()) > 0;
        const holdsChildren = (await local.db.folders.where("parentId").equals(id).count()) > 0;
        if (holdsNotes || holdsChildren) {
          setMessage("Move its notes and subfolders out before deleting this folder.");
          return;
        }
        await deleteLocalFolder(local, id);
        setSelectedFolderId((current) => (current === id ? null : current));
        await after(local);
      },
      createTag: async (name: string) => {
        const local = context();
        if (!local) {
          return;
        }
        await createLocalTag(local, { id: crypto.randomUUID(), name });
        await after(local);
      },
      renameTag: async (id: string, name: string) => {
        const local = context();
        if (!local) {
          return;
        }
        await renameLocalTag(local, { id, name });
        await after(local);
      },
      deleteTag: async (id: string) => {
        const local = context();
        if (!local) {
          return;
        }
        await deleteLocalTag(local, id);
        setSelectedTagId((current) => (current === id ? null : current));
        await after(local);
      },
    };
  }, [db, account, loadOrganisation]);

  const openNoteFrom = useCallback(
    (entries: StoredNote[], id: string) => {
      const found = entries.find((entry) => entry.note.id === id);
      if (!found) {
        return;
      }
      setSelectedId(id);
      setOpenTabs((current) => addTab(current, id));
      setDraft({ id, title: found.document.title, body: found.document.body });
      setOpenedRefs(attachmentRefsIn(found.document.body));
      setRecent((current) => rememberOpened(current, id));
      if (db && account) {
        // Read from the link table rather than the note: a tag is a relationship, and a note never stores the
        // set itself.
        void readLocalNoteTags(
          { db, dek: account.dek, userId: account.userId, keyVersion: account.keyVersion },
          id,
        ).then(setNoteTagIds);
      }
    },
    [db, account],
  );

  const openNote = useCallback((id: string) => openNoteFrom(notes, id), [notes, openNoteFrom]);

  const saveDraft = useCallback(async () => {
    if (!db || !account || !draft) {
      return;
    }
    const context: LocalContext = {
      db,
      dek: account.dek,
      userId: account.userId,
      keyVersion: account.keyVersion,
    };
    await runRequest(async () => {
      await updateLocalNote(context, { id: draft.id, title: draft.title, body: draft.body });
      // §17: about five seconds after the user stops editing.
      scheduler.current?.scheduleAfterIdle();
      // §12 reference counting: the text decides. An attachment whose reference was
      // deleted loses its link, and the server enqueues it for deletion at zero.
      const currentRefs = attachmentRefsIn(draft.body);
      const { added, removed } = diffAttachmentRefs(openedRefs, currentRefs);
      if (added.length > 0 || removed.length > 0) {
        // Queued rather than called: a note that has not reached the server yet would be answered with 404 and
        // the reference would be lost, leaving the attachment looking unreferenced.
        await enqueueAttachmentLinkChange(db, draft.id);
        setOpenedRefs(currentRefs);
      }
      await refresh(db, account);
      setMessage("Saved locally and queued for sync.");
    });
  }, [db, account, draft, refresh, runRequest, openedRefs]);

  const createNote = useCallback(async () => {
    if (!db || !account) {
      return;
    }
    const context: LocalContext = {
      db,
      dek: account.dek,
      userId: account.userId,
      keyVersion: account.keyVersion,
    };
    const id = crypto.randomUUID();
    await runRequest(async () => {
      await createLocalNote(context, { id, title: "Untitled", body: "" });
      // The freshly loaded list is used directly rather than through state.
      const stored = await refresh(db, account);
      openNoteFrom(stored, id);
    });
  }, [db, account, refresh, openNoteFrom, runRequest]);

  /** What the strip shows: the open ids joined to the notes they refer to, and whether each has unsaved work. */
  const tabs = useMemo<TabView[]>(
    () =>
      openTabs
        .map((id) => {
          const entry = notes.find((candidate) => candidate.note.id === id);
          if (!entry) {
            return null;
          }
          return {
            id,
            title: entry.document.title,
            dirty: isDirty(draft !== null && draft.id === id ? draft : null, entry.document),
          };
        })
        .filter((tab): tab is TabView => tab !== null),
    [openTabs, notes, draft],
  );

  // Loaded once the notes are readable, so a stored list can be filtered to ids that actually exist.
  const tabsRestored = useRef(false);
  useEffect(() => {
    if (tabsRestored.current || notes.length === 0) {
      return;
    }
    tabsRestored.current = true;
    const known = new Set(notes.map((entry) => entry.note.id));
    setOpenTabs((current) =>
      current.length > 0 ? current : loadTabs(localStorage, (id) => known.has(id)),
    );
  }, [notes]);

  useEffect(() => {
    saveTabs(localStorage, openTabs);
  }, [openTabs]);

  /** The draft is saved before the strip moves: switching tabs must not be a way to lose an edit. */
  const leaveCurrentTab = useCallback(async () => {
    if (draft === null) {
      return;
    }
    const stored = notes.find((entry) => entry.note.id === draft.id)?.document ?? null;
    if (isDirty(draft, stored)) {
      await saveDraft();
    }
  }, [draft, notes, saveDraft]);

  const selectTab = useCallback(
    (id: string) => {
      void (async () => {
        await leaveCurrentTab();
        openNote(id);
      })();
    },
    [leaveCurrentTab, openNote],
  );

  const closeTab = useCallback(
    (id: string) => {
      void (async () => {
        if (draft !== null && draft.id === id) {
          await leaveCurrentTab();
        }
        const next = neighbourAfterClose(openTabs, id);
        setOpenTabs((current) => removeTab(current, id));
        if (draft !== null && draft.id === id) {
          // The note that takes its place, or an empty editor when it was the last one open.
          if (next !== null) {
            openNote(next);
          } else {
            setDraft(null);
            setSelectedId(null);
          }
        }
      })();
    },
    [draft, leaveCurrentTab, openNote, openTabs],
  );

  /** Moves the open note to the recycle bin (§19). */
  const deleteCurrentNote = useCallback(async () => {
    if (draft === null || db === null || account === null) {
      return;
    }
    const context: LocalContext = {
      db,
      dek: account.dek,
      userId: account.userId,
      keyVersion: account.keyVersion,
    };
    await runRequest(async () => {
      await deleteLocalNote(context, draft.id);
      await refresh(db, account);
      setOpenTabs((current) => removeTab(current, draft.id));
      setDraft(null);
      scheduler.current?.scheduleAfterIdle();
    });
  }, [db, account, draft, refresh, runRequest]);

  /**
   * Brings a note back out of the recycle bin (§19).
   *
   * Straight to the API rather than through the change feed: restoring is an operation on the server's copy rather
   * than an edit of the note's contents, and the pull that follows is what puts the note back in the list.
   */
  const restoreDeletedNote = useCallback(
    async (id: string) => {
      if (db === null || account === null) {
        return;
      }
      setRecycleBusy(true);
      try {
        await runRequest(async () => {
          const pending = await db.syncQueue.where("objectId").equals(id).toArray();
          const neverReachedTheServer = pending.some((entry) => entry.operation === "create");
          if (neverReachedTheServer) {
            // There is nothing to restore: the note was created and deleted without the server ever hearing about it,
            // so asking would be a 404 and the queued deletion would take the note away again the moment the network
            // returned. Undoing both locally is the whole operation.
            await db.transaction("rw", db.notes, db.syncQueue, async () => {
              const row = await db.notes.get(id);
              if (row) {
                await db.notes.put({ ...row, deletedAt: null, updatedAt: Date.now() });
              }
              const stale = pending.filter((entry) => entry.operation === "delete");
              await db.syncQueue.bulkDelete(stale.map((entry) => entry.id));
            });
          } else {
            await apiRequest(`/notes/${id}/restore`, { method: "POST", body: {} });
            scheduler.current?.syncNow();
          }
          await refresh(db, account);
        });
      } finally {
        setRecycleBusy(false);
      }
    },
    [db, account, refresh, runRequest],
  );

  /**
   * Deletes a note for good (§19).
   *
   * The only place in the client that drops queued work, and on purpose: the server has confirmed the object no
   * longer exists, so a change still queued for it could only ever come back as a 404. Everything the note owned goes
   * with it: its row, its tag links, and the entries waiting to talk about it.
   */
  const deletePermanently = useCallback(
    async (id: string) => {
      if (db === null || account === null) {
        return;
      }
      setRecycleBusy(true);
      try {
        await runRequest(async () => {
          await apiRequest(`/notes/${id}/permanent`, { method: "DELETE" });
          await db.transaction("rw", db.notes, db.noteTags, db.syncQueue, async () => {
            await db.notes.delete(id);
            await db.noteTags.where("noteId").equals(id).delete();
            const pending = await db.syncQueue.toArray();
            const stale = pending.filter((entry) => entry.objectId === id);
            await db.syncQueue.bulkDelete(stale.map((entry) => entry.id));
          });
          setOpenTabs((current) => removeTab(current, id));
          setConfirmingPermanent(null);
          await refresh(db, account);
        });
      } finally {
        setRecycleBusy(false);
      }
    },
    [db, account, refresh, runRequest],
  );

  /** Appends pasted text to the draft. */
  const insertIntoDraft = useCallback((text: string) => {
    setDraft((current) => (current ? { ...current, body: `${current.body}${text}` } : current));
  }, []);

  /**
   * Applies the paste rules (§12).
   *
   * Text goes in; an image or a rich-text conversion needs a path that does not exist
   * yet, and saying so is better than pretending the paste was handled.
   */
  /**
   * Uploads images and appends a reference to each one.
   *
   * The bytes are encrypted by `uploadAttachment` before they leave the browser, and the
   * reference is only inserted after the server has confirmed it stored the object — so a
   * failed upload leaves no reference pointing at nothing.
   */
  /**
   * Removes an attachment's reference from the note text.
   *
   * Only the text changes here: the unlink happens on save, through the same diff as any
   * other edit, so there is one code path that decides reference counts.
   */
  const removeAttachmentReference = useCallback((id: string) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const pattern = new RegExp(
        `!\\[[^\\]]*\\]\\(${ATTACHMENT_URL_PREFIX}${id}/content\\)\\n?`,
        "g",
      );
      return { ...current, body: current.body.replace(pattern, "") };
    });
  }, []);

  /**
   * Inserts images, encrypting them here and queueing the upload (§7, §12, §32).
   *
   * The order matters and used to be the other way round: the bytes are encrypted and stored **first**, the
   * reference goes into the note, and the upload is queued. That is what makes inserting an image work with no
   * network — §32 asks for image operations offline — and it also means a failed upload no longer loses the
   * insertion. The queue uploads the bytes and then the link, in that order.
   */
  const uploadImages = useCallback(
    async (files: readonly File[]) => {
      if (!account || !draft || !db) {
        return;
      }
      const noteId = draft.id;
      const context: LocalContext = {
        db,
        dek: account.dek,
        userId: account.userId,
        keyVersion: account.keyVersion,
      };
      let body = draft.body;

      for (const file of files) {
        try {
          const attachmentId = crypto.randomUUID();
          const bytes = new Uint8Array(await file.arrayBuffer()) as Bytes;
          if (bytes.byteLength === 0) {
            throw new Error("The file is empty.");
          }
          if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
            throw new Error(
              `Each file must be under ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`,
            );
          }

          const { ciphertext, iv, plaintextSize } = await encryptAttachmentBytes(
            account.dek,
            attachmentId,
            account.keyVersion,
            bytes,
          );
          const filename = file.name.length > 0 ? file.name : "attachment";
          const now = Date.now();

          await db.attachments.put({
            id: attachmentId,
            r2Key: `attachments/${attachmentId}`,
            contentType: file.type.length > 0 ? file.type : "application/octet-stream",
            sizeBytes: ciphertext.byteLength,
            name: await encryptAttachmentName(
              account.dek,
              attachmentId,
              account.keyVersion,
              filename,
            ),
            // The ciphertext, held for the upload that may only happen once the network returns.
            cachedBlob: new Blob([ciphertext as BlobPart]),
            cachedAt: now,
            contentIv: iv,
            plaintextSizeBytes: plaintextSize,
            createdAt: now,
            syncedAt: null,
          });
          await enqueueChange(db, {
            objectType: "attachment",
            objectId: attachmentId,
            operation: "create",
            baseRevision: null,
          });

          body = `${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${attachmentMarkdown(attachmentId, filename)}\n`;
          setDraft((current) =>
            current && current.id === noteId ? { ...current, body } : current,
          );

          // Saved, not just shown: the link's own upload reads the references from the stored note.
          await updateLocalNote(context, { id: noteId, title: draft.title, body });
          await enqueueAttachmentLinkChange(db, noteId);
          scheduler.current?.scheduleAfterIdle();
          setMessage("Image encrypted and attached. It uploads with the next sync.");
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "The image could not be attached.");
        }
      }
    },
    [account, db, draft, handleRevocation],
  );

  /**
   * Applies the remembered rich-text choice.
   *
   * The conversion sanitizes before it converts (§12), and the result goes into the note like any
   * other text: stored as Markdown, and sanitized again when it is rendered.
   */
  const applyRichText = useCallback(
    async (html: string, remember: boolean) => {
      try {
        const { htmlToMarkdown } = await import("./editor/rich-text");
        const markdown = await htmlToMarkdown(html);
        if (markdown.length > 0) {
          insertIntoDraft(`${markdown}\n`);
        }
        if (remember) {
          setRichTextPreference("html");
          saveRichTextPreference(localStorage, "html");
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The paste could not be converted.");
      }
    },
    [insertIntoDraft],
  );

  /** Applies the paste rules (§12). */
  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const decision = decidePaste({
        items: [...event.clipboardData.items].map((item) => ({
          kind: item.kind,
          type: item.type,
          getAsFile: () => item.getAsFile(),
        })),
        html: event.clipboardData.getData("text/html") || null,
        text: event.clipboardData.getData("text/plain") || null,
        richTextPreference,
      });

      event.preventDefault();
      if (decision.kind === "insert-text") {
        insertIntoDraft(decision.text);
      } else if (decision.kind === "ask-rich-text") {
        setPastePrompt({ html: decision.html, text: decision.text });
      } else if (decision.kind === "attach-image") {
        void uploadImages([decision.file]);
      } else if (decision.kind === "insert-html") {
        void applyRichText(decision.html, false);
      } else {
        setMessage(decision.reason);
      }
    },
    [insertIntoDraft, richTextPreference, uploadImages, applyRichText],
  );

  /** Applies the drop rules (§12: images only, with a size limit). */
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      event.preventDefault();
      if (files.length === 0) {
        return;
      }
      const decision = decideDrop(files);
      if (decision.kind === "reject") {
        setMessage(decision.reason);
        return;
      }
      void uploadImages(decision.files);
    },
    [uploadImages],
  );

  /**
   * The attachments this note references.
   *
   * Derived from the note's own text rather than a separate list, so the panel cannot
   * disagree with what the note actually contains.
   */
  // Applied to the document rather than through a React tree of CSS classes: the stylesheet reads it, and it has to
  // survive a change of theme, panes and screens without any of them knowing about it.
  useEffect(() => {
    applyTypography(typography, document.documentElement);
  }, [typography]);

  const chooseTypography = useCallback((next: Typography) => {
    setTypography(next);
    saveTypography(localStorage, next);
  }, []);

  /** The hidden import input: the File menu item is an ordinary action, the input keeps its label. */
  const importInput = useRef<HTMLInputElement>(null);

  const chooseTheme = useCallback((next: ThemePreference) => {
    setTheme(next);
    saveThemePreference(localStorage, next);
  }, []);

  const setEditorModeAndRemember = useCallback((next: EditorMode) => {
    setEditorMode(next);
    saveEditorMode(localStorage, next);
  }, []);

  /** The shortcut a command has, for the menu that shows it. */
  const shortcutFor = (id: string): string | undefined => {
    const found = SHORTCUTS.find((entry) => entry.id === id);
    return found === undefined ? undefined : formatShortcut(found);
  };

  /**
   * The menus (§22).
   *
   * Every item is something the interface could already do: the top bar is where file operations belong, not a new
   * set of features. The theme and the sort order appear both here and in the settings dialog because they are the
   * two a writer changes mid-sentence, and reaching them from `View` does not move the mouse away from the text.
   *
   * There is no "Edit" menu. The only genuinely editing actions are the formatting commands, and those belong in
   * the editor's own toolbar; a menu that repeated `File` and `View` would be an empty gesture.
   */
  const menus: MenuDefinition[] = [
    {
      id: "file",
      label: "File",
      accessKey: "f",
      items: [
        {
          id: "new",
          label: "New note",
          shortcut: shortcutFor("new-note"),
          onSelect: () => void createNote(),
        },
        {
          id: "save",
          label: "Save",
          shortcut: shortcutFor("save-note"),
          disabled: draft === null,
          onSelect: () => void saveDraft(),
        },
        { id: "sep-1", label: "", separator: true, onSelect: () => undefined },
        {
          id: "export",
          label: exporting ? "Exporting…" : "Export everything…",
          disabled: exporting || notes.length === 0,
          onSelect: () => void exportEverything(),
        },
        {
          id: "import",
          label: "Import an archive…",
          disabled: exporting,
          onSelect: () => importInput.current?.click(),
        },
        {
          id: "recovery",
          label: "Recovery package…",
          disabled: exporting,
          onSelect: () => void downloadRecoveryPackage(),
        },
        { id: "sep-2", label: "", separator: true, onSelect: () => undefined },
        { id: "sep-3", label: "", separator: true, onSelect: () => undefined },
        {
          id: "recycle",
          label: "Recycle bin",
          shortcut: shortcutFor("show-recycle-bin"),
          onSelect: () => setScreen("recycle-bin"),
        },
        {
          id: "delete",
          label: "Move this note to the recycle bin",
          disabled: draft === null,
          onSelect: () => void deleteCurrentNote(),
        },
      ],
    },
    {
      id: "view",
      label: "View",
      accessKey: "v",
      items: [
        {
          id: "theme-system",
          label: "Theme: follow system",
          checked: theme === "system",
          onSelect: () => chooseTheme("system"),
        },
        {
          id: "theme-light",
          label: "Theme: light",
          checked: theme === "light",
          onSelect: () => chooseTheme("light"),
        },
        {
          id: "theme-dark",
          label: "Theme: dark",
          checked: theme === "dark",
          onSelect: () => chooseTheme("dark"),
        },
        { id: "sep-3", label: "", separator: true, onSelect: () => undefined },
        {
          id: "sidebar",
          label: sidebarVisible ? "Hide side panel" : "Show side panel",
          shortcut: shortcutFor("toggle-sidebar"),
          onSelect: () => setSidebarVisible((visible) => !visible),
        },
        {
          id: "wysiwyg",
          label: "Visual editor",
          checked: editorMode === "wysiwyg",
          onSelect: () => setEditorModeAndRemember("wysiwyg"),
        },
        {
          id: "source",
          label: "Markdown source",
          checked: editorMode === "source",
          onSelect: () => setEditorModeAndRemember("source"),
        },
        {
          id: "preview",
          label: preview ? "Back to editing" : "Preview",
          checked: preview,
          disabled: draft === null,
          onSelect: () => setPreview((current) => !current),
        },
        { id: "sep-4", label: "", separator: true, onSelect: () => undefined },
        ...SORT_KEYS.map((key) => ({
          id: `sort-${key}`,
          label: `Order: ${SORT_LABELS[key]}`,
          checked: sortKey === key,
          onSelect: () => setSortKey(key),
        })),
      ],
    },
    {
      id: "help",
      label: "Help",
      accessKey: "h",
      items: [
        { id: "settings", label: "Settings…", onSelect: () => setSettingsOpen(true) },
        {
          id: "commands",
          label: "Command palette",
          shortcut: shortcutFor("command-palette"),
          onSelect: () => setPaletteOpen(true),
        },
        { id: "shortcuts", label: "Keyboard shortcuts", onSelect: () => setPaletteOpen(true) },
        { id: "sep-5", label: "", separator: true, onSelect: () => undefined },
        {
          id: "about",
          label: `SecureNotes ${__APP_VERSION__}`,
          onSelect: () => setSettingsOpen(true),
        },
      ],
    },
  ];

  const draftAttachments = useMemo(
    () => (draft ? attachmentReferencesIn(draft.body) : []),
    [draft],
  );

  const commands = useMemo<Command[]>(
    () =>
      buildCommands({
        newNote: () => void createNote(),
        search: () => setPaletteOpen(false),
        toggleSidebar: () => setSidebarVisible((visible) => !visible),
        showRecycleBin: () => setScreen("recycle-bin"),
        lock: () => void lockAndForget("locked"),
        signOut: () =>
          void runRequest(() => apiRequest("/auth/logout", { method: "POST", body: {} })).then(
            () => void lockAndForget("signed-out"),
          ),
        sortBy: (key) => setSortKey(key as SortKey),
      }),
    [createNote, lockAndForget, runRequest],
  );

  // Global shortcuts (§23). The handler ignores unmodified keys typed into a
  // field unless the binding says otherwise, which `matchShortcut` decides.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const fromTextField =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      const id = matchShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        fromTextField,
      });
      if (!id) {
        return;
      }
      event.preventDefault();

      if (id === "escape") {
        setPaletteOpen(false);
        setQuery("");
        return;
      }
      if (screen !== "app") {
        return;
      }
      if (id === "new-note") void createNote();
      if (id === "save-note") void saveDraft();
      if (id === "toggle-sidebar") setSidebarVisible((visible) => !visible);
      if (id === "show-recycle-bin") setScreen("recycle-bin");
      if (id === "search" || id === "command-palette") {
        setPaletteQuery("");
        setPaletteOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screen, createNote, saveDraft]);

  const searchHits = useMemo(() => {
    if (query.trim().length === 0) {
      return null;
    }
    return new Map(searchIndex.search(query).map((hit) => [hit.id, hit]));
    // `indexVersion` is the rebuild signal. The index is a stable instance whose
    // *contents* change in place, so the rule cannot see the dependency: the memo
    // has to re-run when `refresh` rebuilds it, not when `notes` happens to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, indexVersion, searchIndex]);

  const visibleNotes = useMemo(() => {
    const decorated = notes
      .filter((entry) => entry.note.deletedAt === null)
      // §10: the folder filter includes subfolders, which is what a tree implies; the tag filter is a set
      // membership test because a tag is a relationship rather than a property of the note.
      .filter((entry) => notesInFolder([entry.note], selectedFolderId, folderRows).length > 0)
      .filter((entry) =>
        selectedTagId === null ? true : (tagLinks.get(entry.note.id) ?? []).includes(selectedTagId),
      )
      .filter((entry) => (searchHits ? searchHits.has(entry.note.id) : true))
      .map((entry) => ({
        id: entry.note.id,
        title: entry.document.title || "Untitled",
        updatedAt: entry.note.updatedAt,
        createdAt: entry.note.createdAt,
        pinned: entry.note.pinned,
        sortOrder: entry.note.sortOrder,
      }));

    return sortNotes(decorated, sortKey);
  }, [notes, searchHits, sortKey, selectedFolderId, selectedTagId, folderRows, tagLinks]);

  if (screen === "loading" || !db) {
    return <main className="boot">Loading SecureNotes…</main>;
  }

  if (screen === "setup") {
    return (
      <main className="auth">
        <h1>SecureNotes</h1>
        <AppVersion />
        <SetupScreen
          onEnrolled={async (unlocked) => {
            setAccount(unlocked.account);
            keyStore.unlock(
              {
                dek: unlocked.account.dek,
                totpSecret: unlocked.account.totpSecret,
                userId: unlocked.account.userId,
                kdfSalt: unlocked.account.kdfSalt,
                keyVersion: unlocked.account.keyVersion,
              },
              Date.now(),
            );
            await refresh(db, unlocked.account);
            setScreen("app");
          }}
        />
      </main>
    );
  }

  if (screen === "login") {
    return (
      <main className="auth">
        <h1>SecureNotes</h1>
        <AppVersion />
        <LoginScreen
          db={db}
          message={message}
          onSignedIn={async (unlocked, mustRebindTotp) => {
            setMustRebind(mustRebindTotp);
            setAccount(unlocked);
            keyStore.unlock(
              {
                dek: unlocked.dek,
                totpSecret: unlocked.totpSecret,
                userId: unlocked.userId,
                kdfSalt: unlocked.kdfSalt,
                keyVersion: unlocked.keyVersion,
              },
              Date.now(),
            );
            await refresh(db, unlocked);
            setScreen("app");
          }}
        />
      </main>
    );
  }

  if (screen === "unlock") {
    return (
      <main className="auth">
        <h1>SecureNotes</h1>
        <AppVersion />
        <UnlockScreen
          db={db}
          message={message}
          onUnlocked={async (unlocked) => {
            setAccount(unlocked);
            keyStore.unlock(
              {
                dek: unlocked.dek,
                totpSecret: unlocked.totpSecret,
                userId: unlocked.userId,
                kdfSalt: unlocked.kdfSalt,
                keyVersion: unlocked.keyVersion,
              },
              Date.now(),
            );
            await refresh(db, unlocked);
            setScreen("app");
          }}
          onUsePassword={async () => {
            await forgetLocalKeys(db);
            setScreen("login");
          }}
        />
      </main>
    );
  }

  if (screen === "recycle-bin") {
    const deleted = notes.filter((entry) => entry.note.deletedAt !== null);
    return (
      <main className="pane-single">
        <header>
          <button type="button" onClick={() => setScreen("app")}>
            Back
          </button>
          <h1>Recycle bin</h1>
        </header>
        <ul className="note-list">
          {deleted.map((entry) => (
            <li key={entry.note.id}>
              <span>{entry.document.title || "Untitled"}</span>
              <span className="muted">
                deleted {new Date(entry.note.deletedAt ?? 0).toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => void restoreDeletedNote(entry.note.id)}
                disabled={recycleBusy}
              >
                Restore
              </button>
              {confirmingPermanent === entry.note.id ? (
                // Two steps rather than a browser confirm(): a mis-click should not be able to destroy a note, and
                // the second step has to say what it does.
                <button
                  type="button"
                  className="danger"
                  onClick={() => void deletePermanently(entry.note.id)}
                  disabled={recycleBusy}
                >
                  Delete for good?
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingPermanent(entry.note.id)}
                  disabled={recycleBusy}
                >
                  Delete permanently
                </button>
              )}
            </li>
          ))}
          {deleted.length === 0 && <li className="muted">Nothing here.</li>}
        </ul>
        <p className="muted">
          Notes stay here for 30 days and are removed automatically after that. Restoring brings one
          back to where it was; deleting it for good cannot be undone.
        </p>
      </main>
    );
  }

  return (
    <div className="app">
      <MenuBar
        menus={menus}
        appName="SecureNotes"
        version={__APP_VERSION__}
        onOpenCommands={() => setPaletteOpen(true)}
      />

      <main
        className={`shell ${sidebarVisible ? "" : "sidebar-hidden"} ${draft ? "mobile-editing" : ""}`}
      >
        <ActivityBar
          active={sidebarVisible ? panelView : null}
          onSelect={(view) => {
            // Selecting the view that is already showing collapses the panel: the gesture editors train into people.
            setPanelView((current) => (current === view && sidebarVisible ? null : view));
            setSidebarVisible(true);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          syncState={conflictCount > 0 || syncState === "auth-required" ? "attention" : "ok"}
        />

        {sidebarVisible && panelView !== null && (
          <aside className="pane side-panel" aria-label={VIEW_LABELS[panelView]}>
            <header className="panel-header">
              <span>{VIEW_LABELS[panelView]}</span>
              <button
                type="button"
                aria-label="Hide the side panel"
                title="Hide the side panel"
                onClick={() => setSidebarVisible(false)}
              >
                <Icon name="sidebar" size={14} />
              </button>
            </header>

            {panelView === "notes" && (
              <>
                <button type="button" className="primary" onClick={() => void createNote()}>
                  <Icon name="newNote" />
                  New note
                </button>
                <nav>
                  <button type="button" className="panel-link" onClick={() => setQuery("")}>
                    <Icon name="allNotes" size={14} />
                    All notes ({notes.filter((entry) => entry.note.deletedAt === null).length})
                  </button>
                  <button
                    type="button"
                    className="panel-link"
                    onClick={() => setScreen("recycle-bin")}
                  >
                    <Icon name="recycleBin" size={14} />
                    Recycle bin
                  </button>
                </nav>
                {recent.length > 0 && (
                  <section>
                    <h2>Recently opened</h2>
                    <ul className="panel-list">
                      {recent.slice(0, 5).map((id) => (
                        <li key={id}>
                          <button type="button" className="panel-link" onClick={() => openNote(id)}>
                            {notes.find((entry) => entry.note.id === id)?.document.title || id}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}

            {panelView === "folders" && (
              <FolderTree
                nodes={folderTree}
                rows={folderRows}
                selectedId={selectedFolderId}
                onSelect={setSelectedFolderId}
                onCreate={(parentId, name) => void organisationActions.createFolder(parentId, name)}
                onRename={(id, name) => void organisationActions.renameFolder(id, name)}
                onMove={(id, parentId) => void organisationActions.moveFolder(id, parentId)}
                onDelete={(id) => void organisationActions.deleteFolder(id)}
              />
            )}

            {panelView === "tags" && (
              <TagList
                tags={tagList}
                selectedId={selectedTagId}
                onSelect={setSelectedTagId}
                onCreate={(name) => void organisationActions.createTag(name)}
                onRename={(id, name) => void organisationActions.renameTag(id, name)}
                onDelete={(id) => void organisationActions.deleteTag(id)}
              />
            )}

            {panelView === "sync" && (
              <section className="sync-status">
                <h2>Sync</h2>
                <button type="button" onClick={() => void scheduler.current?.syncNow()}>
                  <Icon name="sync" size={14} />
                  Sync now
                </button>
                {conflictCount > 0 && (
                  <button
                    type="button"
                    onClick={async () => {
                      const open = await listLocalConflicts(db);
                      const first = open.find((entry) => entry.objectType === "note");
                      if (first) {
                        setResolvingConflict(first.objectId);
                      }
                    }}
                  >
                    <Icon name="conflict" size={14} />
                    Resolve a conflict
                  </button>
                )}
                {exportReminder !== null && <p className="muted">{exportReminder}</p>}
                {/* Repeated from the menus on purpose: it is the one thing only the user can do. */}
                <p className="muted">
                  Backups live in the File menu. Export everything writes a plaintext archive of
                  your notes; Recovery package writes the key material needed to get back into this
                  account.
                </p>
              </section>
            )}
          </aside>
        )}

        <section className="pane list">
          <header>
            <input
              type="search"
              placeholder="Search notes…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search notes"
            />
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              title={formatShortcut({
                id: "command-palette",
                key: "p",
                ctrlOrMeta: true,
                description: "",
              })}
            >
              ⌘
            </button>
          </header>
          <ul className="note-list">
            {visibleNotes.map((note) => (
              <li key={note.id} className={note.id === selectedId ? "selected" : ""}>
                <button type="button" onClick={() => openNote(note.id)}>
                  <span className="title">{renderHighlighted(note.title, query)}</span>
                  {note.pinned && <span title="Pinned">📌</span>}
                  <span className="muted">{new Date(note.updatedAt).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
            {visibleNotes.length === 0 && <li className="muted">No notes match.</li>}
          </ul>
        </section>

        <section className="pane editor">
          <Tabs
            tabs={tabs}
            activeId={draft?.id ?? null}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={() => void createNote()}
          />
          {draft ? (
            <>
              <input
                className="note-title"
                value={draft.title}
                aria-label="Note title"
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
              {preview ? (
                <MarkdownPreview
                  title={draft.title}
                  body={draft.body}
                  urlForAttachment={(id) => {
                    void attachmentVersion;
                    return attachmentUrls?.get(id) ?? null;
                  }}
                />
              ) : (
                <div
                  className="editor-host"
                  data-note-id={draft.id}
                  onPaste={handlePaste}
                  onDrop={handleDrop}
                  onDragOver={(event) => event.preventDefault()}
                >
                  <LazyEditor
                    key={draft.id}
                    mode={editorMode}
                    urlForAttachment={(id) => {
                      void attachmentVersion;
                      return attachmentUrls?.get(id) ?? null;
                    }}
                    attachmentVersion={attachmentVersion}
                    value={draft.body}
                    onChange={(body) =>
                      setDraft((current) => (current ? { ...current, body } : current))
                    }
                  />
                </div>
              )}
              <NoteOrganisation
                folders={folderRows}
                tags={tagList}
                folderId={notes.find((entry) => entry.note.id === draft.id)?.note.folderId ?? null}
                tagIds={noteTagIds}
                maxTags={MAX_TAGS_PER_NOTE}
                onFolderChange={(folderId) => {
                  if (!db || !account) {
                    return;
                  }
                  const local: LocalContext = {
                    db,
                    dek: account.dek,
                    userId: account.userId,
                    keyVersion: account.keyVersion,
                  };
                  void updateLocalNoteMetadata(local, { id: draft.id, folderId }).then(async () => {
                    await refresh(db, account);
                    scheduler.current?.scheduleAfterIdle();
                  });
                }}
                onTagsChange={(tagIds) => {
                  if (!db || !account) {
                    return;
                  }
                  const local: LocalContext = {
                    db,
                    dek: account.dek,
                    userId: account.userId,
                    keyVersion: account.keyVersion,
                  };
                  const planned = planTagChange(noteTagIds, tagIds, MAX_TAGS_PER_NOTE);
                  setNoteTagIds(planned.next);
                  void setLocalNoteTags(local, { noteId: draft.id, tagIds: planned.next }).then(
                    async () => {
                      await loadOrganisation(local);
                      scheduler.current?.scheduleAfterIdle();
                    },
                  );
                }}
              />

              {draftAttachments.length > 0 && (
                <section className="attachments" aria-label="Attachments">
                  <h2>Attachments ({draftAttachments.length})</h2>
                  <ul>
                    {draftAttachments.map((attachment) => (
                      <li key={attachment.id}>
                        <a
                          // The endpoint serves ciphertext, so opening it hands the user an unreadable file: the
                          // link points at the decrypted bytes once they have been read.
                          href={
                            attachmentUrls?.get(attachment.id) ??
                            `${ATTACHMENT_URL_PREFIX}${attachment.id}/content`
                          }
                          target="_blank"
                          rel="noreferrer"
                          title={attachment.id}
                        >
                          {attachment.label.length > 0
                            ? attachment.label
                            : `${attachment.id.slice(0, 8)}…`}
                        </a>
                        <button
                          type="button"
                          onClick={() => removeAttachmentReference(attachment.id)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">
                    Removing a reference schedules the encrypted object for deletion once nothing
                    else uses it.
                  </p>
                </section>
              )}
              <footer>
                <button type="button" className="primary" onClick={() => void saveDraft()}>
                  Save (Ctrl+S)
                </button>
                <button type="button" onClick={() => setPreview((current) => !current)}>
                  {preview ? "Edit" : "Preview"}
                </button>
                <button
                  type="button"
                  disabled={preview}
                  onClick={() =>
                    setEditorMode((mode) => {
                      const next: EditorMode = mode === "wysiwyg" ? "source" : "wysiwyg";
                      saveEditorMode(localStorage, next);
                      return next;
                    })
                  }
                >
                  {editorMode === "wysiwyg" ? "Markdown source" : "WYSIWYG"}
                </button>
                <span className="muted">
                  {preview
                    ? "Rendered through the sanitizer."
                    : `Editing in ${editorMode === "wysiwyg" ? "WYSIWYG" : "Markdown source"} mode, stored encrypted and queued for sync.`}
                </span>
              </footer>
            </>
          ) : (
            <p className="muted">Select a note, or create one.</p>
          )}
        </section>

        {message && (
          <div className="toast" role="status">
            {message}
            <button type="button" onClick={() => setMessage(null)}>
              Dismiss
            </button>
          </div>
        )}

        {mustRebind && account && (
          <RebindTotpPrompt
            account={account}
            onFinished={async (notice) => {
              setMustRebind(false);
              // Every session was revoked by the server, so the app must authenticate again.
              await lockAndForget("signed-out");
              setMessage(notice);
            }}
            onLater={() => setMustRebind(false)}
          />
        )}

        {importPrompt && (
          <div className="palette conflict-panel" role="dialog" aria-label="Import an archive">
            <h2>Import an archive</h2>
            <p className="muted">
              {importPrompt.collisions === 0
                ? `${importPrompt.archive.notes.length} note(s) will be added. Nothing here has the same id.`
                : `${importPrompt.collisions} item(s) in this archive already exist here. Merge keeps the newer text and adds tags; importing as copies gives everything in the archive new ids and leaves what is here untouched.`}
            </p>
            <button
              type="button"
              className="primary"
              disabled={importing}
              onClick={() => void runImport("merge")}
            >
              Merge
            </button>
            <button type="button" disabled={importing} onClick={() => void runImport("remap")}>
              Import as copies
            </button>
            <button type="button" disabled={importing} onClick={() => setImportPrompt(null)}>
              Cancel
            </button>
          </div>
        )}

        {resolvingConflict && account && (
          <ConflictPanel
            db={db}
            account={account}
            objectId={resolvingConflict}
            onResolved={async () => {
              // The resolution already reached the server by the time this runs, so the interface can be
              // corrected from the local database immediately rather than waiting for the next pass: the
              // marker is cleared, the count follows from it, and the note is no longer paused.
              await refresh(db, account);
              setConflictCount((await listLocalConflicts(db)).length);
              setSyncState("synced");
              scheduler.current?.scheduleAfterIdle();
            }}
            onClose={() => setResolvingConflict(null)}
          />
        )}

        {pastePrompt && (
          <div className="palette" role="dialog" aria-label="Paste rich text">
            <p>This paste came from a web page. How should it be inserted?</p>
            <button
              type="button"
              onClick={() => {
                setRichTextPreference("plain");
                saveRichTextPreference(localStorage, "plain");
                insertIntoDraft(pastePrompt.text);
                setPastePrompt(null);
              }}
            >
              Plain text
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                void applyRichText(pastePrompt.html, true);
                setPastePrompt(null);
              }}
            >
              Keep formatting
            </button>
            <button type="button" onClick={() => setPastePrompt(null)}>
              Cancel
            </button>
          </div>
        )}

        {paletteOpen && (
          <div className="palette" role="dialog" aria-label="Command palette">
            <input
              autoFocus
              value={paletteQuery}
              placeholder="Type a command…"
              aria-label="Command"
              onChange={(event) => setPaletteQuery(event.target.value)}
            />
            <ul>
              {filterCommands(commands, paletteQuery).map((command) => (
                <li key={command.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPaletteOpen(false);
                      command.run?.();
                    }}
                  >
                    {command.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      <StatusBar
        exportReminder={exportReminder}
        syncLabel={SYNC_STATE_LABELS[syncState]}
        syncTone={
          conflictCount > 0
            ? "attention"
            : syncState === "syncing"
              ? "busy"
              : syncState === "synced"
                ? "ok"
                : "attention"
        }
        conflictCount={conflictCount}
        noteCount={notes.filter((entry) => entry.note.deletedAt === null).length}
        version={__APP_VERSION__}
        onOpenSync={() => {
          setPanelView("sync");
          setSidebarVisible(true);
        }}
        onOpenConflicts={async () => {
          const open = await listLocalConflicts(db);
          const first = open.find((entry) => entry.objectType === "note");
          if (first) {
            setResolvingConflict(first.objectId);
          }
        }}
      />

      {/* Hidden, and kept in the document so the File menu item is an ordinary action and the input keeps the label
          that a screen reader and the tests both use. */}
      <input
        ref={importInput}
        type="file"
        accept=".zip,application/zip"
        aria-label="Import an archive"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void chooseImport(file);
          }
        }}
      />

      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          onTheme={chooseTheme}
          sortKey={sortKey}
          onSortKey={setSortKey}
          typography={typography}
          onTypography={chooseTypography}
          version={__APP_VERSION__}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Resolving a conflict (§16).
 *
 * Three columns, because that is what the decision needs: what the note looked like before either edit,
 * what this device did, and what the server has. The actions are the three §16 names, and the manual
 * merge offers a suggested result with the unresolved regions left visible as markers rather than
 * quietly resolved.
 */
function ConflictPanel({
  db,
  account,
  objectId,
  onResolved,
  onClose,
}: {
  db: SecureNotesDatabase;
  account: UnlockedAccount;
  objectId: string;
  onResolved: () => Promise<void>;
  onClose: () => void;
}) {
  const [sides, setSides] = useState<ConflictSides | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [merged, setMerged] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadNoteConflict(
      { db, dek: account.dek, keyVersion: account.keyVersion, userId: account.userId },
      objectId,
    )
      .then((loaded) => {
        if (!cancelled) {
          setSides(loaded);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "The conflict could not be read.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [db, account, objectId]);

  const resolve = async (choice: "local" | "remote" | "merged", mergedText?: string) => {
    if (!sides) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveNoteConflict(
        { db, dek: account.dek, keyVersion: account.keyVersion, userId: account.userId },
        mergedText === undefined ? { sides, choice } : { sides, choice, mergedText },
      );
      await onResolved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The conflict could not be resolved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="palette conflict-panel" role="dialog" aria-label="Resolve conflict">
      <h2>Resolve conflict</h2>

      {error && <p className="error">{error}</p>}

      {sides === null ? (
        <p className="muted">Loading the three versions…</p>
      ) : suggestion !== null ? (
        <>
          <p className="muted">
            Merged automatically. Any region both sides changed is left marked — edit it and resolve
            when it reads the way you want.
          </p>
          <textarea
            className="note-body"
            aria-label="Merged note"
            value={merged}
            onChange={(event) => setMerged(event.target.value)}
          />
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void resolve("merged", merged)}
          >
            Resolve with this
          </button>
          <button type="button" onClick={() => setSuggestion(null)}>
            Back
          </button>
        </>
      ) : (
        <>
          <div className="conflict-columns">
            <section data-testid="conflict-base">
              <h3>Base</h3>
              <pre>{sides.base ?? "unavailable (history pruned)"}</pre>
            </section>
            <section data-testid="conflict-local">
              <h3>Local</h3>
              <pre>{sides.local}</pre>
            </section>
            <section data-testid="conflict-remote">
              <h3>Remote</h3>
              <pre>{sides.remote}</pre>
            </section>
          </div>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void resolve("local")}
          >
            Keep local
          </button>
          <button type="button" disabled={busy} onClick={() => void resolve("remote")}>
            Keep remote
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              // A missing ancestor still merges: everything is then treated as a conflicted region, which
              // is visible rather than guessed.
              const result = threeWayMerge(sides.base ?? "", sides.local, sides.remote);
              setMerged(result.text);
              setSuggestion(result.text);
            }}
          >
            Manual merge
          </button>
          <button type="button" onClick={onClose}>
            Later
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The application version (§32, Platform).
 *
 * Shown on the screens a user is on when something goes wrong — before signing in, and in the shell — because the
 * point of showing it is that they can tell someone which build they are using.
 */
function AppVersion() {
  return (
    <p className="muted" data-testid="app-version">
      SecureNotes {__APP_VERSION__}
    </p>
  );
}

/** §17: what each sync state says. */
const SYNC_STATE_LABELS: Record<SyncState, string> = {
  synced: "Synced",
  pending: "Pending changes",
  syncing: "Syncing…",
  conflict: "Conflict — needs a decision",
  offline: "Offline",
  "sync-error": "Sync error — press Sync now",
  "auth-required": "Sign in again to sync",
};

/** Hosts whichever editor the mode selects, loading it on first use. */
function LazyEditor({
  mode,
  value,
  onChange,
  urlForAttachment,
  attachmentVersion,
}: {
  mode: EditorMode;
  value: string;
  onChange: (value: string) => void;
  urlForAttachment?: (attachmentId: string) => string | null;
  attachmentVersion?: number;
}) {
  type EditorComponent = ComponentType<{
    value: string;
    onChange: (value: string) => void;
    /** Only the visual editor uses these; the source editor shows the Markdown as text. */
    urlForAttachment?: (attachmentId: string) => string | null;
    attachmentVersion?: number;
  }>;

  // One component type rather than a union: the two editors take the same required props, and the visual one
  // uses two optional extras that the source editor simply never reads.
  const [Component, setComponent] = useState<EditorComponent | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = mode === "wysiwyg" ? loadWysiwygEditor : loadSourceEditor;
    void load().then((loaded) => {
      if (!cancelled) {
        setComponent(() => loaded as EditorComponent);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  if (!Component) {
    return <p className="muted">Loading the editor…</p>;
  }
  return (
    <Component
      value={value}
      onChange={onChange}
      {...(urlForAttachment === undefined ? {} : { urlForAttachment })}
      {...(attachmentVersion === undefined ? {} : { attachmentVersion })}
    />
  );
}

/**
 * Renders a note's Markdown (§12).
 *
 * `dangerouslySetInnerHTML` is used because the content *is* HTML by the time it
 * gets here — but only after `renderMarkdown`, which runs the whole document through
 * `sanitizeHtml`. Nothing else in the app is inserted this way, and the sanitizer is
 * the reason this one is acceptable.
 */
function MarkdownPreview({
  title,
  body,
  urlForAttachment,
}: {
  title: string;
  body: string;
  /** A displayable URL for an attachment, or null while it is still being read. */
  urlForAttachment: (id: string) => string | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);

  // Rendering is a two-step: the Markdown becomes HTML, then the DOM is committed, and only then can
  // diagrams be drawn into it. Doing the second step from the same promise meant it ran while the
  // component was still showing its placeholder — the container was not mounted, so every diagram
  // was silently skipped and only the code blocks remained.
  useEffect(() => {
    let cancelled = false;
    void loadRender().then(({ renderMarkdown }) => {
      if (!cancelled) {
        setHtml(renderMarkdown(title.trim().length > 0 ? `# ${title}\n\n${body}` : body));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [title, body]);

  useEffect(() => {
    if (html === null || !container.current) {
      return;
    }
    let cancelled = false;
    void loadRender().then(({ renderMermaidBlocks }) => {
      // §12: Markdown -> Mermaid -> SVG -> sanitizer -> DOM.
      if (!cancelled && container.current) {
        void renderMermaidBlocks(container.current);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  if (html === null) {
    return <p className="muted">Rendering…</p>;
  }
  // §12: the sanitizer ran inside `renderMarkdown`, so this HTML is safe. The attachment addresses are then
  // replaced with blob URLs: the endpoint serves ciphertext, so an <img> pointing at it is a broken image.
  return (
    <div
      className="preview"
      ref={container}
      dangerouslySetInnerHTML={{ __html: rewriteAttachmentUrls(html, urlForAttachment) }}
    />
  );
}

/**
 * Reconfigures the authenticator after a recovery login (§3).
 *
 * The server reports `mustRebindTotp` on that path, because the authenticator the user had is gone by
 * definition. Completing the rebind revokes every session including this one, so the app returns to
 * the sign-in screen and the user continues with a code from the new authenticator.
 *
 * The existing recovery codes stay valid: a rebind re-wraps the same DEK, and their wrappings are
 * derived from the codes themselves. That is stated on screen, because "I changed my authenticator,
 * are my printed codes still good?" is exactly the question a user will have.
 */
function RebindTotpPrompt({
  account,
  onFinished,
  onLater,
}: {
  account: UnlockedAccount;
  onFinished: (message: string) => Promise<void>;
  onLater: () => void;
}) {
  const [started, setStarted] = useState<StartedRebind | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      setStarted(await beginTotpRebind());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be started.");
    } finally {
      setBusy(false);
    }
  };

  const finish = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const verified = await verifyTotpRebind(code);
    if (!verified) {
      setBusy(false);
      setError("That code was not accepted.");
      return;
    }
    try {
      await completeTotpRebind({ account, verified });
      await onFinished(
        "Your authenticator was replaced and every device was signed out. Sign in with a code from the new authenticator.",
      );
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : "The change could not be completed.");
    }
  };

  return (
    <div className="palette" role="dialog" aria-label="Set up a new authenticator">
      <h2>Set up a new authenticator</h2>
      <p className="muted">
        You signed in with a recovery code, so the previous authenticator entry is no longer usable
        for this account.
      </p>

      {started === null ? (
        <>
          <button type="button" className="primary" disabled={busy} onClick={() => void begin()}>
            {busy ? "Preparing…" : "Generate a new secret"}
          </button>
          <button type="button" onClick={onLater}>
            Remind me later
          </button>
        </>
      ) : (
        <form onSubmit={finish}>
          <p>Add this to your authenticator app, then enter a code from it:</p>
          <label className="field">
            <span>Authenticator URI</span>
            <code data-testid="rebind-uri">{started.totpUri}</code>
          </label>
          <label className="field">
            <span>Or type this secret</span>
            <code data-testid="rebind-secret">{started.totpSecretBase32}</code>
          </label>
          <label className="field">
            <span>Code from the new authenticator</span>
            <input
              value={code}
              inputMode="numeric"
              aria-label="New authenticator code"
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Finishing…" : "Replace my authenticator"}
          </button>
          <p className="muted">
            Your existing recovery codes keep working: the underlying key does not change. Every
            device, including this one, will be signed out when you finish.
          </p>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Highlights search terms as plain text: no markup is ever injected (§11). */
function renderHighlighted(text: string, query: string) {
  const title = text.length > 0 ? text : "Untitled";
  if (query.trim().length === 0) {
    return title;
  }
  return highlightSegments(title, query).map((segment, index) => (
    <mark key={index} className={segment.highlighted ? "hit" : undefined}>
      {segment.text}
    </mark>
  ));
}

function SetupScreen({
  onEnrolled,
}: {
  onEnrolled: (result: Awaited<ReturnType<typeof enrolAccount>>) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<
    Awaited<ReturnType<typeof enrolAccount>>["secrets"] | null
  >(null);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof enrolAccount>> | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await enrolAccount({ username });
      setPending(result);
      // Secrets are shown before entering the app: §3 requires they are shown once.
      setSecrets(result.secrets);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Enrolment failed");
    } finally {
      setBusy(false);
    }
  };

  if (secrets && pending) {
    return (
      <section className="card">
        <h2>Save these now</h2>
        <p>They are shown once and cannot be retrieved later.</p>
        <label className="field">
          <span>Authenticator URI</span>
          <code data-testid="totp-uri">{secrets.totpUri}</code>
        </label>
        <ol data-testid="recovery-codes">
          {secrets.recoveryCodes.map((entry) => (
            <li key={entry.code}>
              <code>{entry.code}</code>
            </li>
          ))}
        </ol>
        <p className="muted">
          Enrolment is complete once you continue: your keys are wrapped and uploaded, and this
          device is signed in. Later sign-ins still require your authenticator code.
        </p>
        <button type="button" className="primary" onClick={() => void onEnrolled(pending)}>
          I saved them — continue
        </button>
      </section>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>First run</h2>
      <p>
        Choose the account name. It is used to derive your encryption key and cannot be changed.
      </p>
      <label className="field">
        <span>Username</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-label="Username"
        />
      </label>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "Working…" : "Create account"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/**
 * Sign-in (§3).
 *
 * Two ways in, because the second one exists for the day the first stops working: a current
 * authenticator code, or one of the ten recovery codes. The recovery path derives the KEK from the
 * code itself, since the TOTP secret is what the user has lost — and it always asks for a new
 * authenticator afterwards.
 */
function LoginScreen({
  onSignedIn,
  message,
  db,
}: {
  onSignedIn: (account: UnlockedAccount, mustRebindTotp: boolean) => Promise<void>;
  message: string | null;
  db: SecureNotesDatabase;
}) {
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    if (useRecoveryCode) {
      const recovered = await signInWithRecoveryCode({
        username,
        code: recoveryCode,
        rememberDevice,
        db,
      }).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "The recovery code was not accepted.");
        return null;
      });
      setBusy(false);
      if (!recovered) {
        setError(
          (current) => current ?? "That recovery code was not accepted, or it was already used.",
        );
        return;
      }
      // The notice is carried into the app: after a recovery login the authenticator is gone by
      // definition.
      await onSignedIn(recovered.account, recovered.mustRebindTotp);
      return;
    }

    const result = await signIn({ username, code, rememberDevice, db }).catch(() => null);
    setBusy(false);
    if (!result) {
      setError("Those credentials were not accepted.");
      return;
    }
    await onSignedIn(result.account, false);
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Sign in</h2>
      {message && <p className="muted">{message}</p>}
      <label className="field">
        <span>Username</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-label="Username"
        />
      </label>

      {useRecoveryCode ? (
        <label className="field">
          <span>Recovery code</span>
          <p className="muted">
            One of the ten codes from enrolment. Each can be used once, and using one asks you to
            set up a new authenticator.
          </p>
          <input
            value={recoveryCode}
            onChange={(event) => setRecoveryCode(event.target.value)}
            aria-label="Recovery code"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : (
        <label className="field">
          <span>Authenticator code</span>
          <input
            value={code}
            inputMode="numeric"
            onChange={(event) => setCode(event.target.value)}
            aria-label="Authenticator code"
          />
        </label>
      )}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={rememberDevice}
          onChange={(event) => setRememberDevice(event.target.checked)}
        />
        <span>Remember this device for offline access</span>
      </label>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? "Signing in…" : useRecoveryCode ? "Sign in with a recovery code" : "Sign in"}
      </button>
      <button
        type="button"
        onClick={() => {
          setUseRecoveryCode((current) => !current);
          setError(null);
        }}
      >
        {useRecoveryCode
          ? "Use my authenticator instead"
          : "Lost your authenticator? Use a recovery code"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function UnlockScreen({
  onUnlocked,
  onUsePassword,
  message,
  db,
}: {
  onUnlocked: (account: UnlockedAccount) => Promise<void>;
  onUsePassword: () => Promise<void>;
  message: string | null;
  db: SecureNotesDatabase;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="card">
      <h2>Locked</h2>
      {message && <p className="muted">{message}</p>}
      <p>Unlock with this device to keep working offline.</p>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          // Reuses the database opened at boot: opening the same IndexedDB twice
          // concurrently is what would throw here, not the unlock itself.
          const unlocked = await unlockWithDeviceKey(db).catch(() => null);
          setBusy(false);
          if (!unlocked) {
            setError("This device can no longer unlock the notes. Sign in again.");
            return;
          }
          await onUnlocked(unlocked);
        }}
      >
        {busy ? "Unlocking…" : "Unlock this device"}
      </button>
      <button type="button" onClick={() => void onUsePassword()}>
        Sign in with a code instead
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
