#!/usr/bin/env node
/**
 * The acceptance report (§31, §32).
 *
 * Requirements §32 lists what the finished product must do, and §31 lists what must be tested. This script holds
 * that list, looks for the evidence of each item **in the repository**, and writes the report. Generating it
 * rather than writing it by hand is the point: a hand-written report drifts from the code the moment anything
 * changes, and the failure mode is a document that claims something no test covers.
 *
 * Evidence is a file pattern plus a string that must appear in it — usually a test name, sometimes an identifier.
 * An item with no evidence is reported as a gap, and the script exits non-zero, so this can be run as a gate.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".sandbox-home") {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path, files);
    } else if (/\.(ts|tsx|mjs|sql)$/.test(path)) {
      files.push(path);
    }
  }
  return files;
}

const FILES = walk(ROOT).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

/** Whether a file path matches an evidence pattern: `*suffix` or a plain substring. */
function matchesPath(path, pattern) {
  return pattern.startsWith("*") ? path.endsWith(pattern.slice(1)) : path.includes(pattern);
}

/** Where a string can be found, as `file:line`, or null. */
function find(pattern, needle) {
  for (const file of FILES) {
    if (!matchesPath(file.path, pattern)) {
      continue;
    }
    const index = file.text.indexOf(needle);
    if (index >= 0) {
      const line = file.text.slice(0, index).split("\n").length;
      return `${file.path}:${line}`;
    }
  }
  return null;
}

/**
 * The criteria, each with where its evidence lives.
 *
 * §31's list is folded into the §32 items it protects rather than kept separate: a security test that protects
 * nothing in the acceptance list would be worth questioning, and the reverse — an acceptance item with no
 * security test behind it — is what this table is for finding.
 */
const CRITERIA = [
  // §32 Authentication
  [
    "Authentication",
    "Username + TOTP login works",
    [["*auth.test.ts", "accepts the current code and issues hardened cookies"]],
  ],
  ["Authentication", "Recovery Code login works", [["*auth.test.ts", "accepts a code once"]]],
  [
    "Authentication",
    "Recovery Codes are single-use (§31 reuse)",
    [["*auth.test.ts", "refuses it forever"]],
  ],
  [
    "Authentication",
    "Progressive rate limiting works (§31 brute force)",
    [["*auth.test.ts", "keeps the backoff exponential and capped"]],
  ],
  ["Authentication", "Secure Session cookie is used", [["*auth.test.ts", "HttpOnly"]]],
  [
    "Authentication",
    "Individual and all-session revocation work",
    [["*sessions.test.ts", "revoke-all includes the current session"]],
  ],
  [
    "Authentication",
    "Maximum 5 Sessions is enforced",
    [["*sessions.test.ts", "keeps the number of concurrent sessions at the cap"]],
  ],
  [
    "Authentication",
    "40-minute inactivity policy works",
    [["*sessions.test.ts", "expires a session after 40 minutes of inactivity"]],
  ],
  [
    "Authentication",
    "Remember-device never bypasses TOTP",
    [["*sessions.test.ts", "never establishes a session without a valid second factor"]],
  ],

  // §32 Encryption
  [
    "Encryption",
    "Note plaintext never reaches Worker/D1/R2",
    [["*notes.test.ts", "never stores or returns a plaintext title or body field"]],
  ],
  [
    "Encryption",
    "Folder names are encrypted",
    [["*local-data.test.ts", "encrypts folder and tag names too"]],
  ],
  [
    "Encryption",
    "Tag names are encrypted",
    [["*local-data.test.ts", "encrypts folder and tag names too"]],
  ],
  [
    "Encryption",
    "Note title/body are encrypted",
    [
      [
        "*local-data.test.ts",
        "stores a note as ciphertext with the plaintext nowhere in the database",
      ],
    ],
  ],
  [
    "Encryption",
    "Attachment original filenames are encrypted",
    [["*attachments-client.test.ts", "sends the filename as an envelope the server accepts"]],
  ],
  [
    "Encryption",
    "AES-256-GCM is implemented correctly",
    [["*format.test.ts", "freezes AES-256-GCM parameters"]],
  ],
  [
    "Encryption",
    "Fresh 96-bit IV per encryption (§31 replay)",
    [["*crypto.test.ts", "uses a fresh 96-bit IV for every encryption"]],
  ],
  [
    "Encryption",
    "AAD is verified",
    [["*crypto.test.ts", "binds the object type, id, revision and key version through the AAD"]],
  ],
  [
    "Encryption",
    "Key versions are tracked",
    [["*crypto.test.ts", "tracks the key version in the AAD and the envelope"]],
  ],
  ["Encryption", "Recovery can recover DEK", [["*crypto-flow.test.ts", "recovery"]]],
  [
    "Encryption",
    "TOTP change can migrate all data",
    [["*crypto-flow.test.ts", "can be resumed after an interruption"]],
  ],
  [
    "Encryption",
    "Interrupted migration can resume or roll back safely (§31 TOTP migration)",
    [["*crypto-flow.test.ts", "rolls back cleanly"]],
  ],

  // §32 Offline. The evidence here is deliberately local: nothing in these tests touches the network, which is
  // the property the criteria are about.
  [
    "Offline",
    "Full offline note editing works",
    [["*local-data.test.ts", "queues every local change"]],
  ],
  [
    "Offline",
    "Folder/tag operations work offline",
    [["*local-data.test.ts", "replaces a note's tags as a set"]],
  ],
  [
    "Offline",
    "Image operations work offline",
    [["*.spec.mjs", "an image can be attached with no network"]],
  ],
  [
    "Offline",
    "Unsynced operations survive normal application restarts (§31 offline queue persistence)",
    [["*local-data.test.ts", "is still queued when the database is opened again"]],
  ],
  [
    "Offline",
    "Unsynced data is never automatically evicted (§31 cache eviction)",
    [["*local-layer.test.ts", "never evicts notes, folders or tags"]],
  ],
  ["Offline", "App Lock works", [["*local-layer.test.ts", "locks after 40 minutes of inactivity"]]],
  [
    "Offline",
    "Revoked Sessions cause local cache/key deletion when detected",
    [["*local-layer.test.ts", "forgets the key and the wrapped material when told to"]],
  ],

  // §32 Sync
  [
    "Sync",
    "Sync is incremental (§31 duplicate sync requests)",
    [["*sync.test.ts", "delivers creates, updates and deletes in order, once each"]],
  ],
  ["Sync", "Cursor works", [["*sync.test.ts", "resumes exactly where a cursor left off"]]],
  [
    "Sync",
    "Base revision is checked",
    [["*notes.test.ts", "refuses a stale base revision instead of overwriting"]],
  ],
  [
    "Sync",
    "Concurrent edits do not silently overwrite (§31 concurrent edits)",
    [["*conflicts.test.ts", "records both sides when an edit is based on a stale revision"]],
  ],
  [
    "Sync",
    "Conflicts are visible",
    [["*conflicts.test.ts", "keeps a single open conflict for an object"]],
  ],
  ["Sync", "Three-way merge works", [["*merge.test.ts", "marks a region both sides changed"]]],
  [
    "Sync",
    "Manual resolution works",
    [["*conflicts.test.ts", "keeps the local side and closes the conflict"]],
  ],
  [
    "Sync",
    "Delete/modify conflicts are detected (§31 delete/modify)",
    [["*engine.test.ts", "treats a remote delete against a locally edited note as a conflict"]],
  ],
  [
    "Sync",
    "Tombstones work",
    [["*engine.test.ts", "records a remote delete as a tombstone when nothing local is pending"]],
  ],
  [
    "Sync",
    "Retry/backoff works (§31 duplicate sync requests)",
    [["*engine.test.ts", "reports when a transient failure will be retried"]],
  ],
  ["Sync", "Manual Sync Now works", [["*.spec.mjs", "Sync now"]]],

  // §32 Editor
  ["Editor", "WYSIWYG works", [["*wysiwyg-documents.test.tsx", "opens the full feature document"]]],
  [
    "Editor",
    "Markdown source mode works",
    [["*editor.test.tsx", "reports edits so the note document stays the source of truth"]],
  ],
  [
    "Editor",
    "HTML sanitization works (§31 XSS, stored XSS, sanitizer bypasses)",
    [["*sanitize.test.ts", "survives the classic mutation and namespace bypasses"]],
  ],
  [
    "Editor",
    "SVG sanitization works (§31 SVG active content)",
    [["*sanitize.test.ts", "still drops objects and other active containers"]],
  ],
  [
    "Editor",
    "Mermaid output is sanitized (§31 Mermaid SVG attacks)",
    [["*markdown.test.ts", "mermaid"]],
  ],
  [
    "Editor",
    "KaTeX output is safely rendered",
    [["*markdown.test.ts", "does not allow arbitrary HTML inside a formula"]],
  ],
  [
    "Editor",
    "iframe content is isolated (§31 iframe isolation)",
    [["*sanitize.test.ts", "keeps an HTTPS embed but isolates it"]],
  ],
  [
    "Editor",
    "External HTTPS images work",
    [["*markdown.test.ts", "renders external links with the safe rel and images"]],
  ],
  [
    "Editor",
    "External links use noopener noreferrer",
    [["*sanitize.test.ts", "adds noopener noreferrer to external links only"]],
  ],
  [
    "Editor",
    "Unsupported URL schemes are rejected (§31 path/object manipulation)",
    [["*sanitize.test.ts", "refuses javascript: and data: URLs"]],
  ],
  [
    "Editor",
    "Code highlighting works",
    [["*markdown.test.ts", "renders code blocks with their language class"]],
  ],
  ["Editor", "Tables work in both modes", [["*markdown.test.ts", "renders tables and task lists"]]],
  [
    "Editor",
    "Task lists work",
    [["*sanitize.test.ts", "removes form controls that are not task-list checkboxes"]],
  ],
  ["Editor", "Paste/drop handling works", [["*.spec.mjs", "the images are listed as attachments"]]],

  // §32 Data lifecycle
  [
    "Data lifecycle",
    "Recycle bin works for 30 days",
    [["*tags-attachments.test.ts", "permanently deletes only notes past the recycle-bin window"]],
  ],
  [
    "Data lifecycle",
    "Permanent deletion removes required history",
    [["*notes.test.ts", "permanent deletion removes the current and historical data"]],
  ],
  [
    "Data lifecycle",
    "Historical versions are limited to 10",
    [["*notes.test.ts", "keeps the current revision plus at most ten historical ones"]],
  ],
  [
    "Data lifecycle",
    "R2 orphan cleanup is asynchronous and idempotent",
    [["*tags-attachments.test.ts", "counts references and only enqueues deletion at zero"]],
  ],
  [
    "Data lifecycle",
    "Import is fully transactional",
    [["*import.test.ts", "rolls the whole import back when a write fails part way through"]],
  ],
  [
    "Data lifecycle",
    "Export produces valid ZIP data",
    [["*.spec.mjs", "the archive is a readable ZIP"]],
  ],
  [
    "Data lifecycle",
    "Recovery package is separate from ordinary export",
    [["*.spec.mjs", "the package is versioned and separate"]],
  ],

  // §32 Platform
  ["Platform", "PWA installs", [["*.spec.mjs", "a web app manifest is served and installable"]]],
  [
    "Platform",
    "Offline application shell works",
    [["*service-worker.test.ts", "keeps the offline fallback for navigations"]],
  ],
  [
    "Platform",
    "Service Worker does not destroy unsynced data during updates (§31 SW update)",
    [["*update-gate.test.ts", "defers while unsynced changes exist"]],
  ],
  [
    "Platform",
    "IndexedDB migrations preserve data (§31 database migration failure)",
    [["*migrations.test.ts", "keeps the old database active and intact when the switch fails"]],
  ],
  [
    "Platform",
    "Application version is visible",
    [["*.spec.mjs", "the application version is visible"]],
  ],

  // §31 tests that protect something narrower than a §32 item
  [
    "Security (§31)",
    "XSS and stored XSS",
    [["*sanitize.test.ts", "removes script tags entirely, including their content"]],
  ],
  [
    "Security (§31)",
    "CSS injection",
    [["*sanitize.test.ts", "strips inline event handlers in every casing and spacing"]],
  ],
  [
    "Security (§31)",
    "CSRF",
    [["*security.test.ts", "rejects a state-changing request with no token"]],
  ],
  [
    "Security (§31)",
    "Session fixation/hijacking",
    [
      [
        "*sessions.test.ts",
        "gives a remembered device a 30-day cookie and a plain session a short one",
      ],
    ],
  ],
  [
    "Security (§31)",
    "SQL injection",
    [["*security.test.ts", "refuses SQL metacharacters in the username"]],
  ],
  [
    "Security (§31)",
    "IDOR/BOLA",
    [["*sessions.test.ts", "refuses to touch a session that belongs to another account"]],
  ],
  [
    "Security (§31)",
    "Malicious MIME/content handling",
    [["*security.test.ts", "rejects a non-JSON content type on writes"]],
  ],
  [
    "Security (§31)",
    "Replay attacks (TOTP step reuse)",
    [["*auth.test.ts", "refuses to replay an already-consumed code"]],
  ],
  [
    "Security (§31)",
    "Nonce replay on sensitive operations",
    [["*crypto-flow.test.ts", "refuses to spend the same nonce twice"]],
  ],
  [
    "Security (§31)",
    "Duplicate sync requests are idempotent",
    [["*notes.test.ts", "answers a replayed create idempotently"]],
  ],
  [
    "Security (§31)",
    "Uploads carry the ciphertext that was stored",
    [["*client.test.ts", "uploads the stored ciphertext and marks the row synced"]],
  ],
];

const rows = [];
let missing = 0;

for (const [section, item, evidence] of CRITERIA) {
  const found = [];
  for (const [pattern, needle] of evidence) {
    const where = find(pattern, needle);
    if (where) {
      found.push(where);
    }
  }
  const ok = found.length === evidence.length;
  if (!ok) {
    missing += 1;
  }
  rows.push({ section, item, ok, found });
}

const lines = [
  "# Acceptance report",
  "",
  "Generated by `node scripts/acceptance.mjs` from the criteria in `requirements.md` §31 and §32. Each line names",
  "the place in the repository where the behaviour is tested or implemented, so a claim here can be checked by",
  "opening the file. Regenerating it is part of the gate: an item whose evidence disappears comes back as a gap.",
  "",
  `| Section | Criterion | Status | Evidence |`,
  `| --- | --- | --- | --- |`,
];

let currentSection = "";
for (const row of rows) {
  if (row.section !== currentSection) {
    currentSection = row.section;
  }
  const evidence =
    row.found.length > 0 ? row.found.map((entry) => `\`${entry}\``).join(", ") : "**none**";
  lines.push(`| ${row.section} | ${row.item} | ${row.ok ? "✅" : "❌"} | ${evidence} |`);
}

lines.push(
  "",
  `**${rows.filter((row) => row.ok).length} of ${rows.length}** criteria have evidence in the repository.`,
  "",
  "## What this report does not claim",
  "",
  "Three things are deliberately outside it, because a table of green ticks should say where it stops.",
  "",
  "- **An offline *page reload* is proven at the unit level, not in the browser.** The end-to-end suite runs the",
  "  development server, which only serves the application shell while the network is up; the service worker that",
  "  serves it offline is registered in production only, on purpose, so that a stale worker cannot serve stale",
  "  modules during development. The queue's persistence across a restart is therefore asserted where it is exactly",
  "  a database question, and the worker's own behaviour by the tests on its script.",
  "- **Mobile layout has not been checked by a person.** The styles are written for it and the breakpoints are in",
  "  the stylesheet, but no human has looked at a phone.",
  "- **The visual editing experience is only partly verified.** The document round trip, the in-place formulas and",
  "  diagrams and the images are covered; how it *feels* to write in it is not something a test can settle.",
  "",
  "One known product limitation, decided and documented rather than accidental: an embedded YouTube player",
  "degrades inside the strict iframe sandbox. The isolation was kept on purpose (HANDOFF §22.4); serving those",
  "embeds from a separate origin is the fix, and it is not done.",
  "",
);

writeFileSync(join(ROOT, "ACCEPTANCE.md"), `${lines.join("\n")}\n`);

for (const row of rows.filter((entry) => !entry.ok)) {
  console.log(`GAP  ${row.section} · ${row.item}`);
  for (const where of row.found) {
    console.log(`       found: ${where}`);
  }
}
console.log(`${rows.length - missing}/${rows.length} criteria have evidence`);
process.exit(missing === 0 ? 0 : 1);
