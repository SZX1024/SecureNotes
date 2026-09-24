import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiRequest, ApiError } from "./api/client";
import {
  enrolAccount,
  forgetLocalKeys,
  signIn,
  unlockWithDeviceKey,
  type UnlockedAccount,
} from "./app/flows";
import {
  createLocalNote,
  readAllLocalNotes,
  updateLocalNote,
  type LocalContext,
  type StoredNote,
} from "./data/repository";
import { openAppDatabase } from "./local/migrations";
import { KeyStore } from "./local/key-store";
import type { SecureNotesDatabase } from "./local/schema";
import { NoteSearchIndex, highlightSegments } from "./search";
import { defaultEditorMode, type EditorMode } from "./editor/mode";
import type { MarkdownSourceEditor as MarkdownSourceEditorType } from "./editor/MarkdownSourceEditor";
import type { WysiwygEditor as WysiwygEditorType } from "./editor/WysiwygEditor";
import {
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
  const [preview, setPreview] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(() =>
    defaultEditorMode(
      typeof window === "undefined" ? 1024 : window.innerWidth,
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false,
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
  const refresh = useCallback(
    async (database: SecureNotesDatabase, unlocked: UnlockedAccount) => {
      const context: LocalContext = {
        db: database,
        dek: unlocked.dek,
        userId: unlocked.userId,
        keyVersion: unlocked.keyVersion,
      };
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
      return context;
    },
    [searchIndex],
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

  const openNote = useCallback(
    (id: string) => {
      const found = notes.find((entry) => entry.note.id === id);
      if (!found) {
        return;
      }
      setSelectedId(id);
      setDraft({ id, title: found.document.title, body: found.document.body });
      setRecent((current) => rememberOpened(current, id));
    },
    [notes],
  );

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
      await refresh(db, account);
      setMessage("Saved locally and queued for sync.");
    });
  }, [db, account, draft, refresh, runRequest]);

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
      await refresh(db, account);
      openNote(id);
    });
  }, [db, account, refresh, openNote, runRequest]);

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
  }, [notes, searchHits, sortKey]);

  if (screen === "loading" || !db) {
    return <main className="boot">Loading SecureNotes…</main>;
  }

  if (screen === "setup") {
    return (
      <main className="auth">
        <h1>SecureNotes</h1>
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
        <LoginScreen
          db={db}
          message={message}
          onSignedIn={async (unlocked) => {
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
            </li>
          ))}
          {deleted.length === 0 && <li className="muted">Nothing here.</li>}
        </ul>
        <p className="muted">
          Notes stay here for 30 days. Restoring and permanent deletion are handled by the API.
        </p>
      </main>
    );
  }

  return (
    <main className={`shell ${sidebarVisible ? "" : "sidebar-hidden"}`}>
      {sidebarVisible && (
        <aside className="pane folders">
          <button type="button" className="primary" onClick={() => void createNote()}>
            New note
          </button>
          <nav>
            <button type="button" onClick={() => setQuery("")}>
              All notes ({notes.filter((entry) => entry.note.deletedAt === null).length})
            </button>
            <button type="button" onClick={() => setScreen("recycle-bin")}>
              Recycle bin
            </button>
          </nav>
          <label className="field">
            <span>Sort</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
              {SORT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          {recent.length > 0 && (
            <section>
              <h2>Recently opened</h2>
              <ul>
                {recent.slice(0, 5).map((id) => (
                  <li key={id}>
                    <button type="button" onClick={() => openNote(id)}>
                      {notes.find((entry) => entry.note.id === id)?.document.title || id}
                    </button>
                  </li>
                ))}
              </ul>
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
        {draft ? (
          <>
            <input
              className="note-title"
              value={draft.title}
              aria-label="Note title"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
            {preview ? (
              <MarkdownPreview title={draft.title} body={draft.body} />
            ) : (
              <LazyEditor
                key={draft.id}
                mode={editorMode}
                value={draft.body}
                onChange={(body) =>
                  setDraft((current) => (current ? { ...current, body } : current))
                }
              />
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
                onClick={() => setEditorMode((mode) => (mode === "wysiwyg" ? "source" : "wysiwyg"))}
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
  );
}

/** Hosts whichever editor the mode selects, loading it on first use. */
function LazyEditor({
  mode,
  value,
  onChange,
}: {
  mode: EditorMode;
  value: string;
  onChange: (value: string) => void;
}) {
  const [Component, setComponent] = useState<
    typeof MarkdownSourceEditorType | typeof WysiwygEditorType | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    const load = mode === "wysiwyg" ? loadWysiwygEditor : loadSourceEditor;
    void load().then((loaded) => {
      if (!cancelled) {
        setComponent(() => loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  if (!Component) {
    return <p className="muted">Loading the editor…</p>;
  }
  return <Component value={value} onChange={onChange} />;
}

/**
 * Renders a note's Markdown (§12).
 *
 * `dangerouslySetInnerHTML` is used because the content *is* HTML by the time it
 * gets here — but only after `renderMarkdown`, which runs the whole document through
 * `sanitizeHtml`. Nothing else in the app is inserted this way, and the sanitizer is
 * the reason this one is acceptable.
 */
function MarkdownPreview({ title, body }: { title: string; body: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadRender().then(({ renderMarkdown, renderMermaidBlocks }) => {
      if (cancelled) {
        return;
      }
      setHtml(renderMarkdown(title.trim().length > 0 ? `# ${title}\n\n${body}` : body));
      // Mermaid is rendered after insertion and its SVG is sanitised before it goes
      // in (§12: Markdown -> Mermaid -> SVG -> sanitizer -> DOM).
      queueMicrotask(() => {
        if (!cancelled && container.current) {
          void renderMermaidBlocks(container.current);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [title, body]);

  if (html === null) {
    return <p className="muted">Rendering…</p>;
  }
  return <div className="preview" ref={container} dangerouslySetInnerHTML={{ __html: html }} />;
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

function LoginScreen({
  onSignedIn,
  message,
  db,
}: {
  onSignedIn: (account: UnlockedAccount) => Promise<void>;
  message: string | null;
  db: SecureNotesDatabase;
}) {
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [rememberDevice, setRememberDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await signIn({ username, code, rememberDevice, db }).catch(() => null);
    setBusy(false);
    if (!result) {
      setError("Those credentials were not accepted.");
      return;
    }
    await onSignedIn(result.account);
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
      <label className="field">
        <span>Authenticator code</span>
        <input
          value={code}
          inputMode="numeric"
          onChange={(event) => setCode(event.target.value)}
          aria-label="Authenticator code"
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={rememberDevice}
          onChange={(event) => setRememberDevice(event.target.checked)}
        />
        <span>Remember this device for offline access</span>
      </label>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
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
