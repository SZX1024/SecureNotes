import MiniSearch, { type SearchResult } from "minisearch";

/**
 * Search (§11).
 *
 * "Search is client-side after decryption. Do not provide server-side plaintext
 * full-text search." and "Build the search index in memory after unlock; do not
 * persist a plaintext search index."
 *
 * So the index is a plain object graph that lives in memory for as long as the
 * app is unlocked. It has no serialisation, is never written to IndexedDB, and is
 * discarded by `clear()` — the one thing that must never happen is a plaintext
 * index surviving on disk.
 */

export interface SearchableNote {
  id: string;
  title: string;
  body: string;
  tags: string[];
  folderName: string | null;
  /** Attachment filenames and types, which §11 lists as searchable. */
  attachmentNames: string[];
  updatedAt: number;
  createdAt: number;
  pinned: boolean;
}

export interface SearchOptions {
  /** Fuzzy matching tolerates typos; exact matching is prefix-aware instead. */
  fuzzy?: number;
  prefix?: boolean;
  limit?: number;
}

export interface SearchHit {
  id: string;
  /** Fields that matched, so the UI can show why a result was returned. */
  matchedFields: string[];
  score: number;
}

interface IndexedDocument extends Omit<SearchableNote, "tags" | "attachmentNames"> {
  id: string;
  tags: string;
  attachmentNames: string;
}

const FIELDS = ["title", "body", "tags", "folderName", "attachmentNames"] as const;

export class NoteSearchIndex {
  #index: MiniSearch<IndexedDocument> | null = null;
  #count = 0;

  get size(): number {
    return this.#count;
  }

  get isBuilt(): boolean {
    return this.#index !== null;
  }

  /**
   * Builds the index from decrypted notes. Called after unlock, never before:
   * until the DEK is available there is nothing to index but ciphertext.
   */
  build(notes: readonly SearchableNote[]): void {
    const index = new MiniSearch<IndexedDocument>({
      fields: [...FIELDS],
      storeFields: ["title", "updatedAt", "createdAt", "pinned"],
      searchOptions: { boost: { title: 3 }, fuzzy: 0.2, prefix: true },
    });

    index.addAll(
      notes.map((note) => ({
        ...note,
        // Arrays are joined because the index only stores strings; the join is
        // in memory for the lifetime of the unlock.
        tags: note.tags.join(" "),
        attachmentNames: note.attachmentNames.join(" "),
      })),
    );

    this.#index = index;
    this.#count = notes.length;
  }

  /** Adds or replaces one note, for edits made while the app is open. */
  upsert(note: SearchableNote): void {
    if (!this.#index) {
      return;
    }
    const document: IndexedDocument = {
      ...note,
      tags: note.tags.join(" "),
      attachmentNames: note.attachmentNames.join(" "),
    };
    if (this.#index.has(note.id)) {
      this.#index.replace(document);
    } else {
      this.#index.add(document);
      this.#count += 1;
    }
  }

  remove(id: string): void {
    if (!this.#index || !this.#index.has(id)) {
      return;
    }
    this.#index.discard(id);
    this.#count -= 1;
  }

  /** Drops the index and every plaintext term it held (§11, §7). */
  clear(): void {
    this.#index = null;
    this.#count = 0;
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const trimmed = query.trim();
    if (!this.#index || trimmed.length === 0) {
      return [];
    }

    const results: SearchResult[] = this.#index.search(trimmed, {
      ...(options.fuzzy === undefined ? {} : { fuzzy: options.fuzzy }),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });

    const limited = options.limit === undefined ? results : results.slice(0, options.limit);
    return limited.map((result) => ({
      id: result.id,
      matchedFields: matchedFieldsOf(result.match),
      score: result.score,
    }));
  }

  /** The terms of `query` that occur in `text`, for highlighting (§11). */
  termsIn(text: string, query: string): string[] {
    const lowered = text.toLowerCase();
    return this.#tokenize(query).filter((term) => lowered.includes(term));
  }

  #tokenize(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 0);
  }
}

/**
 * Wraps every occurrence of a query term in `text`, returning segments the UI can
 * render without ever injecting HTML: the caller gets plain strings and decides
 * how to mark them, so a search for `<script>` cannot become markup.
 */
export function highlightSegments(
  text: string,
  query: string,
): Array<{ text: string; highlighted: boolean }> {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return [{ text, highlighted: false }];
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
  return text
    .split(pattern)
    .filter((segment) => segment.length > 0)
    .map((segment) => ({ text: segment, highlighted: terms.includes(segment.toLowerCase()) }));
}

/**
 * The fields a result matched.
 *
 * MiniSearch reports `match` as `{ term: field[] }`, so the field names are the
 * values, not the keys. Accepting a `Map` as well keeps this working across the
 * library's own version change rather than silently reporting no matches.
 */
function matchedFieldsOf(match: unknown): string[] {
  if (match instanceof Map) {
    return [...match.keys()].map(String);
  }
  if (match && typeof match === "object") {
    const fields = new Set<string>();
    for (const value of Object.values(match as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const field of value) {
          if (typeof field === "string") {
            fields.add(field);
          }
        }
      }
    }
    return [...fields];
  }
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
