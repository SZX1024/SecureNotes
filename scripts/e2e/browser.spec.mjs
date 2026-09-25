/**
 * The browser checks themselves (§12, §31).
 *
 * Enrolment is performed here rather than assumed, so the run needs no existing account and no
 * secret from anyone's database: a fresh persistence directory means the app opens on its first-run
 * screen, and the authenticator URI it displays is read straight out of the page.
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5174";
const SHOTS = `${ROOT}/.sandbox-home/shots`;

/**
 * Waits until a page reports it has nothing left to do.
 *
 * The app schedules a sync five seconds after every edit, so a step that depends on the server's revision
 * has to wait for quiet. Sleeping a fixed time instead made this suite flap: the two devices' automatic
 * passes interleaved differently on each run.
 */
async function waitForQuiet(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const label =
      (await page
        .getByTestId("sync-state")
        .textContent()
        .catch(() => "")) ?? "";
    if (/Synced|Conflict|Sync error|Sign in/.test(label)) {
      return label.trim();
    }
    await page.waitForTimeout(500);
  }
  return "timed out";
}

/**
 * Opens a side panel from the activity rail.
 *
 * Idempotent, because clicking the view that is already showing collapses the panel: asking for the same view
 * twice must leave it open rather than toggle it away.
 */
async function openPanel(target, label) {
  const showing = await target.evaluate((wanted) => {
    const button = [...document.querySelectorAll(".rail button")].find(
      (candidate) => candidate.getAttribute("aria-label") === wanted,
    );
    return button?.getAttribute("aria-pressed") === "true";
  }, label);
  if (!showing) {
    await target.getByRole("button", { name: label, exact: true }).click();
  }
  await target.waitForTimeout(300);
}

/**
 * Clicks a button inside the editor pane.
 *
 * By name, with a fallback that dispatches the click directly. The fallback is evidenced rather than a shrug: once
 * the workspace became a fixed-height frame, these buttons resolve to exactly one element and are visible, enabled,
 * stable across samples, receive pointer events at their own centre, and have no DOM churn around them — and the
 * actionability check still never settles. What the fallback skips is the synthetic pointer sequence, not the
 * assertion: every caller still checks that the thing it clicked actually happened.
 */
async function clickEditorButton(target, name) {
  const button = target.getByRole("button", { name }).first();
  try {
    await button.click({ timeout: 10_000 });
  } catch {
    await button.evaluate((element) => element.click());
  }
  await target.waitForTimeout(700);
}

/** Runs a File-menu item by its label, the way a person would. */
async function openFileMenuItem(target, label) {
  await target.getByRole("button", { name: "File", exact: true }).click();
  await target.getByRole("menuitem", { name: label }).click();
  await target.waitForTimeout(300);
}

/** RFC 6238, so the run can sign in without reaching into anyone's database. */
function totpFromBase32(secret) {
  if (!secret) {
    return "";
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

const failures = [];
/** Diagnostics kept for a failing run: printed at the end, silent on a pass. */
const diagnostics = [];
const notes = [];

function check(label, condition, detail = "") {
  if (condition) {
    notes.push(`  ok   ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

/**
 * Errors that come from the embedded page rather than from the app.
 *
 * Attributed by measurement, not by assumption: the same run with the embed pointed at a
 * script-free page reports no errors at all, so these three belong to the embed's own scripts
 * running inside the sandbox. They are still printed on every run — filtering them out of the
 * failure list must not mean hiding them.
 */
const EMBED_ORIGINATED =
  /writeEmbed|caches' property|allow-same-origin|youtube|Uncaught undefined/i;

/**
 * A conflict is an expected outcome rather than a fault, and this run deliberately creates one: the
 * stale edit is answered with 409, which is the mechanism §16 asks for and which the checks below
 * assert.
 */
const EXPECTED_CONFLICT = /409 \(Conflict\)/;

/**
 * Preconditions this run provokes on purpose: a note can reach the server before the folder it was moved into, and
 * the client retries. The 412 is the mechanism, not a fault.
 */
const EXPECTED_PRECONDITION = /412 \(Precondition Failed\)/;

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => pageErrors.push(String(error)));

/** The app's own trace, so a step that hangs can say where it stopped. */
const appLogs = [];
page.on("console", (message) => appLogs.push(`${message.type()}: ${message.text()}`));

/** Records what the client actually sent, so a mismatch can be read rather than guessed at. */
const noteCalls = [];
/** Every API response that failed, so a 500 names the request that caused it. */
const apiFailures = [];
page.on("response", async (response) => {
  const url = response.url();
  if (/\/api\/v1\//.test(url) && response.status() >= 400) {
    // The status alone does not say why the server refused, and 409 and 500 each have several causes.
    const body = await response.text().catch(() => "");
    apiFailures.push(
      `${response.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")} -> ${response.status()} ${body.slice(0, 200)}`,
    );
  }
  if (!/\/api\/v1\//.test(url)) {
    return;
  }
  const request = response.request();
  const body = request.postData() ?? "";
  noteCalls.push({
    method: request.method(),
    path: url.replace(/^https?:\/\/[^/]+/, ""),
    status: response.status(),
    revision: /"revision":(\d+)/.exec(body)?.[1] ?? null,
    baseRevision: /"baseRevision":(\d+)/.exec(body)?.[1] ?? null,
  });
});

try {
  // 1. First run: enrol. The app shows the URI and the recovery codes exactly once.
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('input[aria-label="Username"]', { timeout: 30_000 });
  await page.fill('input[aria-label="Username"]', "e2e-account");
  await page.getByRole("button", { name: /create account/i }).click();

  const totpUri = await page.getByTestId("totp-uri").textContent({ timeout: 20_000 });
  const recoveryCodes = await page.getByTestId("recovery-codes").locator("code").allTextContents();
  // Taken from the URI the app displays rather than from any database: the run needs no access to a
  // developer's secrets, and this exercises the same value the user would scan.
  const base32Secret = /secret=([A-Z2-7]+)/.exec(totpUri ?? "")?.[1] ?? "";
  check(
    "enrolment shows an authenticator URI",
    Boolean(totpUri?.startsWith("otpauth://")),
    totpUri?.slice(0, 24),
  );
  check(
    "enrolment shows ten recovery codes",
    recoveryCodes.length === 10,
    `${recoveryCodes.length}`,
  );

  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForSelector('button:has-text("New note")', { timeout: 30_000 });
  check("enrolment leads into the app", true);

  // 2. Creating a note must open it: this is the regression that made the preview look broken.
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.waitForSelector('input[aria-label="Note title"]', { timeout: 20_000 });
  // The editor itself is loaded on demand, so "the pane appeared" and "the editor is ready" are two
  // different moments; the earlier check conflated them and failed on its own timing.
  const editorReady = await page
    .waitForSelector(".cm-content, .wysiwyg-editor", { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check("a new note opens in an editor", editorReady);

  // 3. Put the feature document in through the Markdown source editor.
  if (await page.$(".wysiwyg-editor")) {
    await page.getByRole("button", { name: "Markdown source", exact: true }).click();
    await page.waitForTimeout(500);
  }
  await page.waitForSelector(".cm-content", { timeout: 20_000 });
  await page.click(".cm-content");
  const document = readFileSync(`${ROOT}/scripts/test-document.md`, "utf8").replace(
    /https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]+/g,
    process.env.E2E_EMBED_URL ?? "https://www.youtube.com/embed/dQw4w9WgXcQ",
  );
  await page.keyboard.insertText(document);
  await page.waitForTimeout(1500);

  // 4. Preview.
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.waitForSelector(".preview", { timeout: 20_000 });
  // Diagrams render after the DOM is committed, so give the second pass time.
  await page.waitForTimeout(4000);

  const preview = await page.evaluate(() => {
    const host = document.querySelector(".preview");
    const frames = [...(host?.querySelectorAll("iframe") ?? [])];
    return {
      katex: host?.querySelectorAll(".katex").length ?? 0,
      diagrams: host?.querySelectorAll(".diagram-preview, .mermaid-diagram").length ?? 0,
      highlighted: host?.querySelectorAll("[class*='hljs-']").length ?? 0,
      tables: host?.querySelectorAll("table").length ?? 0,
      checkboxes: host?.querySelectorAll('input[type="checkbox"]').length ?? 0,
      scripts: host?.querySelectorAll("script").length ?? 0,
      handlers: [...(host?.querySelectorAll("*") ?? [])].filter((el) =>
        [...el.attributes].some((a) => a.name.toLowerCase().startsWith("on")),
      ).length,
      dangerousUrls: [...(host?.querySelectorAll("*") ?? [])].filter((el) =>
        [...el.attributes].some((a) => /javascript:|vbscript:/i.test(a.value)),
      ).length,
      frames: frames.length,
      framesIsolated: frames.every(
        (frame) =>
          (frame.getAttribute("sandbox") ?? "").includes("allow-scripts") &&
          !(frame.getAttribute("sandbox") ?? "").includes("allow-same-origin"),
      ),
      diagramsStyled:
        host?.querySelectorAll(".diagram-preview svg style, .mermaid-diagram svg style").length ??
        0,
    };
  });

  check("formulas render", preview.katex >= 3, `${preview.katex}`);

  // Rendering is not the same as rendering correctly, and counting `.katex` elements cannot tell the difference — the
  // markup is all there whether or not the stylesheet that gives it meaning was ever loaded. The thickness of a
  // fraction's rule and the centring of display maths come from that stylesheet and from nowhere else, so they are
  // what is measured here. This is the check that was missing when block formulas "rendered but were wrong".
  const mathGeometry = await page.evaluate(() => {
    const rule = document.querySelector(".katex .frac-line");
    const display = document.querySelector(".katex-display");
    const inner = document.querySelector(".katex .vlist > span");
    return {
      fracLineThickness: rule ? getComputedStyle(rule).borderBottomWidth : null,
      displayAlign: display ? getComputedStyle(display).textAlign : null,
      innerDisplay: inner ? getComputedStyle(inner).display : null,
    };
  });
  check(
    "a block formula is displayed with its layout intact (§12)",
    mathGeometry.fracLineThickness !== null &&
      mathGeometry.fracLineThickness !== "0px" &&
      mathGeometry.displayAlign === "center",
    JSON.stringify(mathGeometry),
  );
  check("diagrams render", preview.diagrams >= 1, `${preview.diagrams}`);
  check(
    "diagram styling survives the SVG sanitizer",
    preview.diagramsStyled >= 1,
    `${preview.diagramsStyled}`,
  );
  check("code is highlighted", preview.highlighted > 0, `${preview.highlighted}`);
  check("tables render", preview.tables >= 1, `${preview.tables}`);
  check("task lists render as checkboxes", preview.checkboxes >= 2, `${preview.checkboxes}`);
  check("no script element survives", preview.scripts === 0, `${preview.scripts}`);
  check("no event handler attributes survive", preview.handlers === 0, `${preview.handlers}`);
  check("no javascript: URLs survive", preview.dangerousUrls === 0, `${preview.dangerousUrls}`);
  check(
    "the HTTPS embed is kept and isolated",
    preview.frames === 1 && preview.framesIsolated,
    `${preview.frames}`,
  );
  check("the HTTP embed was removed", preview.frames === 1, `${preview.frames}`);
  await page.screenshot({ path: `${SHOTS}/e2e-preview.png` });

  // 5. WYSIWYG: the note opens, formulas render in place, and nothing is silently broken.
  await clickEditorButton(page, "Edit");
  await page.waitForTimeout(1000);
  await clickEditorButton(page, "WYSIWYG");
  await page.waitForTimeout(6000);

  const wysiwyg = await page.evaluate(() => {
    const host = document.querySelector(".wysiwyg-editor");
    return {
      present: Boolean(host),
      katex: host?.querySelectorAll(".katex").length ?? 0,
      hidden: host?.querySelectorAll(".render-source-hidden").length ?? 0,
      images: host?.querySelectorAll("img").length ?? 0,
      failed: document.body.innerText.includes("could not be opened"),
    };
  });
  check("the visual editor opens a note with images", wysiwyg.present && !wysiwyg.failed);
  check("images survive the conversion", wysiwyg.images > 0, `${wysiwyg.images}`);
  check("formulas render in place", wysiwyg.katex > 0, `${wysiwyg.katex}`);
  check("formula source is hidden, not deleted", wysiwyg.hidden > 0, `${wysiwyg.hidden}`);
  await page.screenshot({ path: `${SHOTS}/e2e-wysiwyg.png` });

  // 6. Saving persists: reload and the note is still there.
  if (await page.$(".wysiwyg-editor")) {
    await page.getByRole("button", { name: "Markdown source", exact: true }).click();
    await page.waitForTimeout(500);
  }
  await clickEditorButton(page, /save/i);
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // A reload after enrolment lands on the sign-in screen: enrolment deliberately stores no device
  // key, so an offline unlock is not available yet. Signing in again is also the check that a code
  // derived from the enrolment URI is accepted.
  const needsSignIn = (await page.$('input[aria-label="Authenticator code"]')) !== null;
  if (needsSignIn) {
    await page.fill('input[aria-label="Username"]', "e2e-account");
    await page.fill('input[aria-label="Authenticator code"]', totpFromBase32(base32Secret));
    await page.click('button[type="submit"]');
    await page.waitForSelector('button:has-text("New note")', { timeout: 20_000 });
  }
  check("a reload asks for a code, as enrolment stores no device key", needsSignIn);

  const afterSignIn = await page.evaluate(() => document.body.innerText);
  check("the note survives a reload and a sign-in", /Untitled|全量|Markdown/.test(afterSignIn));

  // 7. A recovery code must unlock the notes, not merely sign in: the KEK is derived from the code
  //    itself, because the TOTP secret is what a user who needs this path has lost.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // Signing in with "remember this device" stores a device wrapping, so a reload offers the offline
  // unlock instead of the sign-in form. That is the designed behaviour, and the recovery path has to
  // be reachable from it.
  const locked = await page.$('button:has-text("Sign in with a code instead")');
  check("a remembered device offers offline unlock after a reload", locked !== null);
  if (locked) {
    await locked.click();
    await page.waitForTimeout(800);
  }

  await page.getByRole("button", { name: /recovery code/i }).click();
  await page.waitForSelector('input[aria-label="Recovery code"]', { timeout: 15_000 });
  await page.fill('input[aria-label="Username"]', "e2e-account");
  await page.fill('input[aria-label="Recovery code"]', recoveryCodes[0].trim());
  await page.click('button[type="submit"]');
  await page.waitForSelector('button:has-text("New note")', { timeout: 25_000 });
  await page.waitForTimeout(2000);

  const afterRecovery = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      list: body,
      rebindNotice: /recovery code/i.test(body) && /authenticator/i.test(body),
      opened: [...document.querySelectorAll(".note-list button")].length,
    };
  });
  check("a recovery code signs in", true);
  check(
    "a recovery code unlocks the key material",
    afterRecovery.opened >= 1,
    `${afterRecovery.opened} note(s) listed`,
  );
  check(
    "a recovery login asks for a new authenticator (§3)",
    afterRecovery.rebindNotice,
    afterRecovery.rebindNotice ? "" : "no notice found",
  );

  // The note's text must be readable, which is the part a session alone cannot prove.
  await page.click(".note-list button");
  await page.waitForTimeout(2000);
  const decrypted = await page.evaluate(() => document.body.innerText);
  check("the note decrypts after a recovery login", /文本与结构|Markdown|Untitled/.test(decrypted));

  // 8. Sync (§16): the saved note reaches the server, and a second device pulls it back.
  await openPanel(page, "Sync and backup");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page.waitForTimeout(4000);

  diagnostics.push(`API CALLS: ${JSON.stringify(noteCalls.slice(-24))}`);
  diagnostics.push(`APP LOGS: ${JSON.stringify(appLogs.slice(-12))}`);
  const syncLabel = (await page.getByTestId("sync-state").textContent()) ?? "";
  check(
    "the interface reports a state from §17",
    /Synced|Pending|Syncing|Conflict|Offline|Sync error|Sign in/.test(syncLabel),
    syncLabel.trim(),
  );

  const serverNoteIds = await page.evaluate(async () => {
    const response = await fetch("/api/v1/notes", { credentials: "same-origin" });
    const payload = await response.json();
    return (payload.data?.notes ?? []).map((note) => note.id);
  });
  check(
    "the saved note reached the server (§16)",
    serverNoteIds.length >= 1,
    `${serverNoteIds.length} note(s)`,
  );

  // A second device starts with an empty database, so anything it shows came from the server.
  const secondContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const secondPage = await secondContext.newPage();
  try {
    await secondPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await secondPage.waitForSelector('input[aria-label="Username"]', { timeout: 30_000 });

    // A code is single-use per step, so a replay in the same window is retried on the next one.
    let signedIn = false;
    for (let attempt = 0; attempt < 3 && !signedIn; attempt += 1) {
      await secondPage.fill('input[aria-label="Username"]', "e2e-account");
      await secondPage.fill('input[aria-label="Authenticator code"]', totpFromBase32(base32Secret));
      await secondPage.click('button[type="submit"]');
      signedIn = await secondPage
        .waitForSelector('button:has-text("New note")', { timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
      if (!signedIn) {
        // Wait for the next 30-second step rather than hammering the endpoint.
        await secondPage.waitForTimeout(31_000);
      }
    }
    check("a second device can sign in", signedIn);

    if (signedIn) {
      await secondPage.waitForTimeout(6000);
      const pulled = await secondPage.evaluate(
        () => document.querySelectorAll(".note-list button").length,
      );
      check(
        "the second device pulled the note from the server (§16)",
        pulled >= 1,
        `${pulled} note(s)`,
      );

      // The second device edits the same note and uploads it.
      await secondPage.click(".note-list button");
      await secondPage.waitForTimeout(1500);
      if (await secondPage.$(".wysiwyg-editor")) {
        await clickEditorButton(secondPage, "Markdown source");
        await secondPage.waitForTimeout(600);
      }
      await secondPage.click(".cm-content");
      await secondPage.keyboard.insertText("\n\nsecond device edit\n");
      await clickEditorButton(secondPage, /save/i);
      await secondPage.waitForTimeout(1200);
      await openPanel(secondPage, "Sync and backup");
      await secondPage.getByRole("button", { name: "Sync now", exact: true }).click();
      // Quiet before reading the revision: the second device's idle sync must not land mid-check.
      check(
        "the second device settles after its edit",
        (await waitForQuiet(secondPage)) !== "timed out",
      );

      const revisionAfterSecondDevice = await secondPage.evaluate(async () => {
        const payload = await (await fetch("/api/v1/notes", { credentials: "same-origin" })).json();
        return (payload.data?.notes ?? [])[0]?.revision ?? 0;
      });
      check(
        "the second device's edit reached the server (§16)",
        revisionAfterSecondDevice >= 2,
        `revision ${revisionAfterSecondDevice}`,
      );

      // The first device edits from a revision the server has moved past. That is a conflict, and it must
      // neither be applied nor silently overwrite the other edit.
      await page.click(".note-list button");
      await page.waitForTimeout(1500);
      if (await page.$(".wysiwyg-editor")) {
        await clickEditorButton(page, "Markdown source");
        await page.waitForTimeout(600);
      }
      await page.click(".cm-content");
      await page.keyboard.insertText("\n\nfirst device edit\n");
      await clickEditorButton(page, /save/i);
      await page.waitForTimeout(1200);
      await openPanel(page, "Sync and backup");
      await page.getByRole("button", { name: "Sync now", exact: true }).click();
      // The stale edit is retried until it conflicts, so wait for the conflict rather than for a duration.
      await page
        .waitForFunction(
          () =>
            /Conflict/i.test(
              document.querySelector('[data-testid="sync-state"]')?.textContent ?? "",
            ),
          { timeout: 30_000 },
        )
        .catch(() => undefined);

      const conflictedLabel = (await page.getByTestId("sync-state").textContent()) ?? "";
      check(
        "a stale edit becomes a conflict, not an overwrite (§16)",
        /Conflict/i.test(conflictedLabel),
        conflictedLabel.trim(),
      );

      // The three versions §16 requires, then a decision.
      await page.getByRole("button", { name: /resolve a conflict/i }).click();
      await page.waitForSelector('[aria-label="Resolve conflict"]', { timeout: 20_000 });
      await page.waitForTimeout(2500);

      const panelText = await page.evaluate(
        () =>
          document.querySelector('[aria-label="Resolve conflict"]')?.textContent?.slice(0, 300) ??
          "(no panel)",
      );
      diagnostics.push(`CONFLICT PANEL: ${JSON.stringify(panelText)}`);

      const columns = await page.evaluate(() => ({
        local: document.querySelector('[data-testid="conflict-local"] pre')?.textContent ?? "",
        remote: document.querySelector('[data-testid="conflict-remote"] pre')?.textContent ?? "",
      }));
      check(
        "all three versions are shown (§16)",
        columns.local.length > 0 && columns.remote.length > 0,
        `local ${columns.local.length}, remote ${columns.remote.length}`,
      );
      check("the local column is this device's text", columns.local.includes("first device edit"));
      check(
        "the remote column is the other device's text",
        columns.remote.includes("second device edit"),
      );

      // What is actually on top of that button decides whether a click can reach it at all.
      diagnostics.push(
        `KEEP LOCAL HIT TEST: ${JSON.stringify(
          await page.evaluate(() => {
            const button = [...document.querySelectorAll("button")].find(
              (candidate) => candidate.textContent?.trim() === "Keep local",
            );
            if (!button) {
              return "no button";
            }
            const rect = button.getBoundingClientRect();
            const top = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return {
              disabled: button.disabled,
              coveredBy: top === button ? "itself" : `${top?.tagName}.${top?.className ?? ""}`,
              rect: [
                Math.round(rect.x),
                Math.round(rect.y),
                Math.round(rect.width),
                Math.round(rect.height),
              ],
              viewport: [window.innerWidth, window.innerHeight],
            };
          }),
        )}`,
      );
      await page.getByRole("button", { name: "Keep local", exact: true }).click();
      // The conflict state has to be waited for *out*: a conflict is a settled state, so the general
      // "is it quiet?" helper returns immediately with the very label under test.
      const cleared = await page
        .waitForFunction(
          () =>
            !/Conflict/i.test(
              document.querySelector('[data-testid="sync-state"]')?.textContent ?? "",
            ),
          { timeout: 30_000 },
        )
        .then(() => true)
        .catch(() => false);
      check("the conflict clears after a resolution (§16)", cleared);
      diagnostics.push(
        `AFTER RESOLVE: ${JSON.stringify(
          await page.evaluate(() => {
            const panel = document.querySelector('[aria-label="Resolve conflict"]');
            return {
              open: panel !== null,
              // The panel renders the failure here, which is the fastest way to see why a resolution did not
              // take effect.
              error: panel?.querySelector(".error")?.textContent ?? null,
              keepLocal: [...document.querySelectorAll("button")].some(
                (button) => button.textContent?.trim() === "Keep local",
              ),
              label: document.querySelector('[data-testid="sync-state"]')?.textContent ?? null,
            };
          }),
        )}`,
      );

      const resolvedLabel = (await page.getByTestId("sync-state").textContent()) ?? "";
      check(
        "resolving clears the conflict (§16)",
        !/Conflict/i.test(resolvedLabel),
        resolvedLabel.trim(),
      );

      const finalRevision = await page.evaluate(async () => {
        const payload = await (await fetch("/api/v1/notes", { credentials: "same-origin" })).json();
        return (payload.data?.notes ?? [])[0]?.revision ?? 0;
      });
      check(
        "the resolution is written as a new revision (§16)",
        finalRevision > revisionAfterSecondDevice,
        `${revisionAfterSecondDevice} -> ${finalRevision}`,
      );
    }
  } finally {
    await secondContext.close();
  }

  // 9. Diagrams render in place in the visual editor, not only in the preview.
  if (await page.$(".cm-content")) {
    await clickEditorButton(page, "WYSIWYG");
    await page.waitForTimeout(7000);
  }
  const inPlace = await page.evaluate(() => ({
    diagrams: document.querySelectorAll(".wysiwyg-editor .diagram-preview svg").length,
    katex: document.querySelectorAll(".wysiwyg-editor .katex").length,
  }));
  check("formulas render in place in the editor", inPlace.katex > 0, `${inPlace.katex}`);
  check("diagrams render in place in the editor", inPlace.diagrams > 0, `${inPlace.diagrams}`);

  // 10. Organisation (§9, §10): folders, tags, the filters built from them, and the server receiving them.
  await waitForQuiet(page);
  await openPanel(page, "Folders");
  await page.getByLabel("New folder name").fill("Work");
  await page.getByRole("button", { name: "Add folder" }).click();
  await page.waitForTimeout(1500);

  const treeHasFolder = await page.evaluate(() =>
    [...document.querySelectorAll(".folder-tree button")].some(
      (button) => button.textContent?.trim() === "Work",
    ),
  );
  check("a folder appears in the tree (§9)", treeHasFolder);

  // Put the open note into it.
  await page.getByLabel("Note folder").selectOption({ label: "Work" });
  await page.waitForTimeout(2000);

  // The tree filter shows the notes in that folder, including its subfolders.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".folder-tree button")].find(
      (candidate) => candidate.textContent?.trim() === "Work",
    );
    button?.click();
  });
  await page.waitForTimeout(1500);
  const inFolder = await page.evaluate(() => document.querySelectorAll(".note-list button").length);
  check("the folder filter shows the note (§10)", inFolder >= 1, `${inFolder} note(s)`);

  // A tag, and the note carrying it.
  await openPanel(page, "Tags");
  await page.getByLabel("New tag name").fill("urgent");
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("checkbox", { name: "urgent" }).check();
  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".tags-pane button")].find(
      (candidate) => candidate.textContent?.trim() === "urgent",
    );
    button?.click();
  });
  await page.waitForTimeout(1500);
  const tagged = await page.evaluate(() => document.querySelectorAll(".note-list button").length);
  check("the tag filter shows the note (§10)", tagged >= 1, `${tagged} note(s)`);

  // A folder that still holds a note is not deleted: the server would refuse, so the interface refuses first
  // rather than letting the folder reappear on the next pull.
  await openPanel(page, "Folders");
  await page.getByRole("button", { name: "Delete folder Work" }).click();
  await page.waitForTimeout(1000);
  const refusal = await page.evaluate(() => document.body.innerText);
  check(
    "deleting a folder that holds a note is refused",
    /Move its notes and subfolders out/i.test(refusal),
  );

  // And the organisation reaches the server. Whether a pass runs at all decides where a failure lies, so
  // record what the click produces instead of waiting a fixed time and inspecting the server afterwards.
  const callsBefore = noteCalls.length;
  await openPanel(page, "Sync and backup");
  const syncButton = page.getByRole("button", { name: "Sync now", exact: true });
  check("the sync control is available", await syncButton.isEnabled());
  await syncButton.click();

  const passDeadline = Date.now() + 25_000;
  while (Date.now() < passDeadline && noteCalls.length === callsBefore) {
    await page.waitForTimeout(500);
  }
  const passCalls = noteCalls
    .slice(callsBefore)
    .map((call) => `${call.method} ${call.path} -> ${call.status}`);
  diagnostics.push(`PASS AFTER ORGANISATION: ${JSON.stringify(passCalls)}`);
  check(
    "a sync pass runs after the organisation changes",
    passCalls.length > 0,
    JSON.stringify(passCalls),
  );

  const onServer = await page.evaluate(async () => {
    const read = async (path) =>
      (await (await fetch(path, { credentials: "same-origin" })).json()).data;
    const [folders, tags, notes] = await Promise.all([
      read("/api/v1/folders"),
      read("/api/v1/tags"),
      read("/api/v1/notes"),
    ]);
    const noteId = (notes.notes ?? [])[0]?.id;
    const links = noteId ? await read(`/api/v1/notes/${noteId}/tags`) : { tagIds: [] };
    return {
      folders: (folders.folders ?? []).length,
      tags: (tags.tags ?? []).length,
      links: (links.tagIds ?? []).length,
    };
  });
  check("the folder reached the server (§16)", onServer.folders >= 1, JSON.stringify(onServer));
  check("the tag reached the server (§16)", onServer.tags >= 1, JSON.stringify(onServer));
  check(
    "the note's tag link reached the server (§16)",
    onServer.links >= 1,
    JSON.stringify(onServer),
  );

  // 9b. Pasting and dropping an image (§12). This is the path a user actually takes and it had no end-to-end
  // coverage at all: the rules were unit-tested, the wiring was not. The events are dispatched on the element
  // the editor owns and they bubble like real ones, so an editor that swallowed them would fail here.
  await openPanel(page, "Notes");
  await page.getByRole("button", { name: "New note", exact: true }).first().click();
  await page.waitForTimeout(3000);

  const pasteAndDrop = await page.evaluate(async () => {
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const make = (name) => new File([bytes], name, { type: "image/png" });

    const pasteTarget =
      document.querySelector(".cm-content") ?? document.querySelector(".wysiwyg-editor");
    if (!pasteTarget) {
      return "no editor";
    }
    const pasteTransfer = new DataTransfer();
    pasteTransfer.items.add(make("pasted.png"));
    pasteTarget.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: pasteTransfer,
        bubbles: true,
        cancelable: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 4000));

    const dropTransfer = new DataTransfer();
    dropTransfer.items.add(make("dropped.png"));
    const host = document.querySelector(".editor-host") ?? pasteTarget;
    host.dispatchEvent(
      new DragEvent("dragover", { dataTransfer: dropTransfer, bubbles: true, cancelable: true }),
    );
    host.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dropTransfer, bubbles: true, cancelable: true }),
    );
    return "dispatched";
  });

  await page.waitForTimeout(8000);
  const attachmentCalls = noteCalls.filter((call) => call.path.includes("/attachments"));
  diagnostics.push(`ATTACHMENTS: ${pasteAndDrop} ${JSON.stringify(attachmentCalls)}`);
  check(
    "pasting and dropping an image upload it (§12)",
    attachmentCalls.filter((call) => call.method === "POST" && call.status < 300).length >= 2,
    JSON.stringify(attachmentCalls),
  );

  const listedAttachments = await page.evaluate(
    () => document.querySelectorAll(".attachments li").length,
  );
  check(
    "the images are listed as attachments (§12)",
    listedAttachments >= 2,
    `${listedAttachments}`,
  );

  // The queue is the honest witness that the links reached the server: §16 removes a queued change only on a
  // server acknowledgement, and a rejected or still-blocked push leaves the entry behind.
  const pasteNoteId = await page.evaluate(
    () => document.querySelector(".editor-host")?.getAttribute("data-note-id") ?? null,
  );
  let linkState = { mine: -1, all: [], noteOnServer: false };
  const linkDeadline = Date.now() + 40_000;
  while (Date.now() < linkDeadline) {
    linkState = await page.evaluate(async (noteId) => {
      const names = (await indexedDB.databases()).map((entry) => entry.name ?? "");
      const name = names.find((candidate) => candidate.startsWith("securenotes")) ?? names[0];
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const request = db.transaction("syncQueue").objectStore("syncQueue").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const notes = await (
        await fetch("/api/v1/notes", { credentials: "same-origin", cache: "no-store" })
      ).json();
      return {
        mine: rows.filter((row) => row.objectType === "note_attachment" && row.objectId === noteId)
          .length,
        all: rows.map((row) => `${row.objectType}:${row.attempts}`),
        noteOnServer: (notes.data?.notes ?? []).some((note) => note.id === noteId),
      };
    }, pasteNoteId);
    if (linkState.mine === 0) {
      break;
    }
    await page.waitForTimeout(1000);
  }
  diagnostics.push(`LINK STATE: ${JSON.stringify(linkState)} for ${pasteNoteId}`);
  check(
    "the server accepted the attachment links (§12)",
    linkState.mine === 0,
    JSON.stringify(linkState),
  );

  // The bytes have to be *displayed*. The endpoint serves ciphertext, so an <img> pointing at it shows a broken
  // image — the markup would look right and the note would be full of empty boxes. The URL scheme and the
  // decoded size are what distinguish a rendered picture from a broken one.
  {
    // Decisive question: can a person reach this button, or only a fallback? If the pane cannot scroll, the layout is
    // broken for the user too and a DOM click would be hiding it.
    diagnostics.push(
      `PREVIEW REACHABILITY: ${JSON.stringify(
        await page.evaluate(() => {
          const pane = document.querySelector(".pane.editor");
          const before = pane ? [pane.scrollTop, pane.scrollHeight, pane.clientHeight] : null;
          if (pane) {
            pane.scrollTop = 400;
          }
          const after = pane ? [pane.scrollTop] : null;
          const button = [...document.querySelectorAll(".pane.editor button")].find((candidate) =>
            /preview/i.test(candidate.textContent ?? ""),
          );
          button?.scrollIntoView({ block: "center" });
          const box = button?.getBoundingClientRect();
          return {
            before,
            after,
            paneOverflow: pane ? getComputedStyle(pane).overflow : null,
            buttonRect: box ? [Math.round(box.top), Math.round(box.height)] : null,
            inViewport: box ? box.top >= 0 && box.bottom <= window.innerHeight : null,
          };
        }),
      )}`,
    );
  }

  await clickEditorButton(page, "Preview");
  await page.waitForTimeout(6000);
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll(".preview img")].map((image) => ({
      src: (image.getAttribute("src") ?? "").slice(0, 24),
      width: image.naturalWidth,
    })),
  );
  diagnostics.push(`SHOWN IMAGES: ${JSON.stringify(shown)}`);
  check(
    "the pasted image is displayed, decrypted (§12)",
    shown.some((image) => image.src.startsWith("blob:") && image.width > 0),
    JSON.stringify(shown),
  );

  // And the visual editor, which renders the images itself from the Markdown: those addresses point at the
  // content endpoint too, so it needed its own fix and its own check.
  // Preview and the editor mode are separate toggles: switching the mode does not leave the preview, so the
  // preview is left first. Both are found by their own state rather than by assuming where the interface is.
  await page.evaluate(() => {
    if (document.querySelector(".preview")) {
      for (const button of document.querySelectorAll("button")) {
        if (button.textContent?.trim() === "Edit") {
          button.click();
          break;
        }
      }
    }
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "WYSIWYG",
    );
    button?.click();
  });
  await page.waitForTimeout(7000);
  const inEditor = await page.evaluate(() => {
    const host = document.querySelector(".editor-host");
    return [...(host?.querySelectorAll("img") ?? [])].map((image) => ({
      src: (image.getAttribute("src") ?? "").slice(0, 24),
      width: image.naturalWidth,
    }));
  });
  const editorState = await page.evaluate(() => ({
    host: Boolean(document.querySelector(".editor-host")),
    contentEditable: Boolean(document.querySelector('[contenteditable="true"]')),
    source: Boolean(document.querySelector(".cm-content")),
    preview: Boolean(document.querySelector(".preview")),
    buttons: [...document.querySelectorAll("button")]
      .map((button) => button.textContent?.trim() ?? "")
      .filter((label) => /WYSIWYG|Markdown source|Preview|Edit/.test(label)),
    totalImages: document.querySelectorAll("img").length,
  }));
  diagnostics.push(
    `WYSIWYG IMAGES: ${JSON.stringify(inEditor)} STATE: ${JSON.stringify(editorState)}`,
  );
  // 9c. Export (§20). The archive is downloaded as a real ZIP, and the check is not "a file was produced": the
  // bytes are validated afterwards by an independent unzip implementation, which is the only way to know the
  // export is readable by something that has never heard of this application.
  const downloadDirectory = mkdtempSync(join(tmpdir(), "securenotes-export-"));
  let downloaded = "";
  page.on("download", async (download) => {
    downloaded = join(downloadDirectory, download.suggestedFilename());
    await download.saveAs(downloaded);
  });

  const reminderBefore = await page.evaluate(
    () => document.querySelector('[data-testid="export-reminder"]')?.textContent ?? "",
  );
  check(
    "the interface says when a backup is overdue (§20)",
    /not exported|days ago/i.test(reminderBefore),
    reminderBefore.trim(),
  );

  await openFileMenuItem(page, /Export everything/);
  const exportDeadline = Date.now() + 40_000;
  while (Date.now() < exportDeadline && downloaded.length === 0) {
    await page.waitForTimeout(500);
  }
  diagnostics.push(`EXPORT: ${downloaded}`);
  check("exporting produces a download (§20)", downloaded.length > 0, downloaded);

  if (downloaded.length > 0) {
    // An independent reader: if Python's zipfile can list and extract this, so can the user's tools.
    const listing = execFileSync("python3", [
      "-c",
      `import json,zipfile,sys
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
manifest = json.loads(z.read("manifest.json"))
notes = [n for n in names if n.startswith("notes/") and n.endswith(".md")]
print(json.dumps({"names": names, "format": manifest["format"], "version": manifest["formatVersion"],
                  "encryption": manifest["encryption"], "notes": len(notes),
                  "firstNote": z.read(sorted(notes)[0]).decode()[:200] if notes else ""}))`,
      downloaded,
    ]).toString();
    const report = JSON.parse(listing);
    diagnostics.push(
      `EXPORT REPORT: ${JSON.stringify({ ...report, firstNote: report.firstNote.slice(0, 40) })}`,
    );
    check(
      "the archive is a readable ZIP (§20)",
      report.names.includes("manifest.json"),
      JSON.stringify(report.names.slice(0, 6)),
    );
    check(
      "it is a SecureNotes export (§20)",
      report.format === "securenotes-export" && report.version === 1,
    );
    check("it states that it is plaintext (§20)", report.encryption === "none");
    check(
      "it carries the notes as Markdown (§20)",
      report.notes >= 1 && report.firstNote.startsWith("#"),
      report.firstNote.slice(0, 40),
    );
    check(
      "it carries the attachment content (§20)",
      report.names.some((name) => name.startsWith("attachments/")),
      JSON.stringify(report.names.filter((name) => name.startsWith("attachments/"))),
    );

    // 9d. Import (§20): the archive that was just written, read back through the interface. A round trip is the
    // only thing that proves the two halves agree — and the duplicates in it are exactly the case §20 says the
    // user has to decide.
    // Counted in the database rather than in the list: a filter left over from an earlier step would hide the
    // very notes this assertion is about, and filtering is covered by its own checks.
    const storedNoteCount = async () =>
      page.evaluate(async () => {
        const names = (await indexedDB.databases()).map((entry) => entry.name ?? "");
        const name = names.find((candidate) => candidate.startsWith("securenotes")) ?? names[0];
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return new Promise((resolve, reject) => {
          const request = db.transaction("notes").objectStore("notes").count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      });

    const notesBeforeImport = await storedNoteCount();
    await page.setInputFiles('input[type="file"][aria-label="Import an archive"]', downloaded);
    await page.waitForSelector('[aria-label="Import an archive"][role="dialog"]', {
      timeout: 20_000,
    });
    const prompt = await page.evaluate(
      () =>
        document.querySelector('[role="dialog"][aria-label="Import an archive"]')?.textContent ??
        "",
    );
    diagnostics.push(`IMPORT PROMPT: ${prompt.slice(0, 120)}`);
    check(
      "duplicate ids are put to the user (§20)",
      /already exist here/i.test(prompt),
      prompt.slice(0, 120),
    );

    await page.getByRole("button", { name: "Import as copies", exact: true }).click();
    await page.waitForTimeout(6000);
    diagnostics.push(
      `IMPORT AFTER COPIES: ${JSON.stringify(
        await page.evaluate(async () => {
          const names = (await indexedDB.databases()).map((entry) => entry.name ?? "");
          const name = names.find((candidate) => candidate.startsWith("securenotes")) ?? names[0];
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const notes = await new Promise((resolve, reject) => {
            const request = db.transaction("notes").objectStore("notes").getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return {
            dialogOpen: Boolean(
              document.querySelector('[role="dialog"][aria-label="Import an archive"]'),
            ),
            listed: document.querySelectorAll(".note-list button").length,
            storedNotes: notes.length,
            created: notes.map((note) => note.createdAt),
            message: document.querySelector(".message, .notice, .status")?.textContent ?? null,
          };
        }),
      )}`,
    );
    const notesAfterCopies = await storedNoteCount();
    check(
      "importing as copies adds the archive's notes (§20)",
      notesAfterCopies > notesBeforeImport,
      `${notesBeforeImport} -> ${notesAfterCopies}`,
    );

    // And again, merging this time: everything in the archive is already here and unchanged, so a merge is a
    // no-op rather than an overwrite.
    await page.setInputFiles('input[type="file"][aria-label="Import an archive"]', downloaded);
    await page.waitForSelector('[role="dialog"][aria-label="Import an archive"]', {
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await page.waitForTimeout(6000);
    const notesAfterMerge = await storedNoteCount();
    check(
      "merging an archive that is already here changes nothing (§20)",
      notesAfterMerge === notesAfterCopies,
      `${notesAfterCopies} -> ${notesAfterMerge}`,
    );
    const importMessage = await page.evaluate(() => document.body.innerText);
    check("the import reports what it did", /Imported \d+ new item/.test(importMessage), "");

    // 9b2. Image operations with no network (§32). This is what the local-first design is for: the bytes are
    // encrypted here, the reference goes into the note, and the upload waits for the network. Proven by going
    // offline, pasting, checking what the device holds, and then coming back online to watch it upload.
    const localAttachmentState = () =>
      page.evaluate(async () => {
        const names = (await indexedDB.databases()).map((entry) => entry.name ?? "");
        const name = names.find((candidate) => candidate.startsWith("securenotes")) ?? names[0];
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const read = (store) =>
          new Promise((resolve, reject) => {
            const request = db.transaction(store).objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const attachments = await read("attachments");
        const queue = await read("syncQueue");
        return {
          attachments: attachments.map((row) => ({
            synced: row.syncedAt !== null,
            cached: row.cachedBlob !== null,
          })),
          queued: queue.map((row) => `${row.objectType}:${row.attempts}`),
        };
      });

    await context.setOffline(true);
    await page.evaluate(async () => {
      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "offline.png", { type: "image/png" }));
      const target =
        document.querySelector(".cm-content") ?? document.querySelector(".wysiwyg-editor");
      target?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    });
    await page.waitForTimeout(5000);

    const offlineAttachments = await localAttachmentState();
    const listedOffline = await page.evaluate(
      () => document.querySelectorAll(".attachments li").length,
    );
    diagnostics.push(
      `OFFLINE: ${JSON.stringify({ ...offlineAttachments, listed: listedOffline })}`,
    );
    check(
      "an image can be attached with no network (§32)",
      listedOffline >= 1 && offlineAttachments.attachments.some((row) => row.cached && !row.synced),
      JSON.stringify(offlineAttachments),
    );
    check(
      "its upload is queued rather than lost (§32)",
      offlineAttachments.queued.some((entry) => entry.startsWith("attachment:")),
      JSON.stringify(offlineAttachments.queued),
    );

    await context.setOffline(false);
    const callsBeforeOfflineUpload = noteCalls.length;
    await openPanel(page, "Sync and backup");
    await page.getByRole("button", { name: "Sync now", exact: true }).click();
    const uploadDeadline = Date.now() + 40_000;
    let uploaded = false;
    while (Date.now() < uploadDeadline && !uploaded) {
      const state = await localAttachmentState();
      uploaded =
        state.attachments.every((row) => row.synced) &&
        !state.queued.some((entry) => entry.startsWith("attachment:"));
      if (!uploaded) {
        await page.waitForTimeout(1000);
      }
    }
    const uploadCalls = noteCalls
      .slice(callsBeforeOfflineUpload)
      .filter((call) => call.path.includes("/attachments"))
      .map((call) => `${call.method} ${call.path} -> ${call.status}`);
    diagnostics.push(`OFFLINE UPLOAD: ${JSON.stringify(uploadCalls)}`);
    check(
      "the queued image uploads once the network returns (§32)",
      uploaded,
      JSON.stringify(uploadCalls),
    );

    // 9c2. The recovery package (§20). Separate from the export, versioned, and — the requirement with teeth —
    // it must not contain the authenticator secret. That is checked against the real secret this run enrolled with,
    // because a list of field names is exactly what a leak would not appear in.
    let recoveryDownload = "";
    const recoveryDirectory = mkdtempSync(join(tmpdir(), "securenotes-recovery-"));
    const onRecoveryDownload = async (download) => {
      recoveryDownload = join(recoveryDirectory, download.suggestedFilename());
      await download.saveAs(recoveryDownload);
    };
    page.on("download", onRecoveryDownload);

    await openFileMenuItem(page, /Recovery package/);
    const recoveryDeadline = Date.now() + 30_000;
    while (Date.now() < recoveryDeadline && recoveryDownload.length === 0) {
      await page.waitForTimeout(500);
    }
    page.off("download", onRecoveryDownload);
    diagnostics.push(`RECOVERY: ${recoveryDownload}`);
    check("a recovery package can be written (§20)", recoveryDownload.length > 0, recoveryDownload);

    if (recoveryDownload.length > 0) {
      const report = JSON.parse(
        execFileSync("python3", [
          "-c",
          `import base64,json,zipfile,sys
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
raw = open(sys.argv[1], "rb").read()
manifest = json.loads(z.read("manifest.json"))
material = json.loads(z.read("key-material.json"))
secret = sys.argv[2]
print(json.dumps({
  "names": names,
  "format": manifest["format"],
  "fileVersion": manifest["fileVersion"],
  "excludes": manifest["excludes"],
  "wrappings": len(material["recoveryWrappings"]),
  "hasAccountWrapping": bool(material["accountWrapping"].get("ciphertext")),
  "containsSecretText": secret.encode() in raw if secret else None,
  "containsSecretBytes": base64.b64decode(secret + "=" * (-len(secret) % 8)) in raw if secret else None,
  "readme": z.read("README.txt").decode()[:40],
}))`,
          recoveryDownload,
          base32Secret,
        ]).toString(),
      );
      diagnostics.push(
        `RECOVERY REPORT: ${JSON.stringify({ ...report, readme: report.readme.slice(0, 20) })}`,
      );

      check(
        "the package is versioned and separate (§20)",
        report.format === "securenotes-recovery" && report.fileVersion === 1,
        JSON.stringify(report),
      );
      check(
        "it carries the protected key material (§20)",
        report.hasAccountWrapping && report.wrappings >= 1,
        JSON.stringify(report),
      );
      check(
        "it never contains the authenticator secret (§20)",
        report.containsSecretText === false && report.containsSecretBytes === false,
        JSON.stringify({ text: report.containsSecretText, bytes: report.containsSecretBytes }),
      );
      check(
        "it says what it does not contain (§20)",
        Array.isArray(report.excludes) && report.excludes.includes("totp_secret"),
        JSON.stringify(report.excludes),
      );
    }

    // §20: the reminder is measured from the export that just happened.
    await page.waitForTimeout(2000);
    const reminderAfter = await page.evaluate(
      () => document.querySelector('[data-testid="export-reminder"]')?.textContent ?? null,
    );
    check(
      "the reminder clears after an export (§20)",
      reminderAfter === null,
      String(reminderAfter),
    );
  }

  check(
    "the image is displayed in the visual editor (§12)",
    inEditor.some((image) => image.src.startsWith("blob:") && image.width > 0),
    JSON.stringify(inEditor),
  );
  diagnostics.push(
    `ATT LOGS: ${JSON.stringify(appLogs.filter((line) => line.includes("[att]")).slice(-6))}`,
  );

  // 11b. The frame (§22): the rail, the menus, the settings dialog and the status bar.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  const settings = await page.evaluate(
    () => document.querySelector('[role="dialog"][aria-label="Settings"]')?.textContent ?? "",
  );
  check(
    "settings opens from the menu bar (§22)",
    /Appearance/.test(settings),
    settings.slice(0, 60),
  );

  // One control per setting: the theme used to offer a selector and a cycling button for the same value.
  // Scoped to the theme's own group: the settings dialog now has a second radiogroup for the line width, and a
  // count of every radio on the page would pass or fail for reasons that have nothing to do with the theme.
  const themeChoices = await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio")
    .count();
  check(
    "the theme is one control with three choices (§22)",
    themeChoices === 3,
    `${themeChoices} choices`,
  );

  await page.getByRole("radio", { name: "Dark" }).click();
  await page.waitForTimeout(600);
  const resolved = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  check("choosing a theme applies it (§22)", resolved === "dark", resolved);
  // Typography (§22): a preference that has to be visible, not merely stored.
  const before = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--text-ui").trim(),
  );
  await page.getByLabel("Interface size").selectOption("16");
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    variable: getComputedStyle(document.documentElement).getPropertyValue("--text-ui").trim(),
    bodySize: getComputedStyle(document.body).fontSize,
  }));
  check(
    "changing a font size applies immediately (§22)",
    before !== after.variable && after.bodySize === "16px",
    `${before} -> ${after.variable}, body ${after.bodySize}`,
  );

  await page.getByLabel("Note text size").selectOption("18");
  await page.waitForTimeout(400);
  const noteSize = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-note-size").trim(),
  );
  check(
    "the note text size is separate from the interface size (§22)",
    noteSize === "18px",
    noteSize,
  );

  await page.getByRole("radio", { name: "Comfortable" }).click();
  await page.waitForTimeout(300);
  const width = await page.evaluate(() => document.documentElement.dataset.editorWidth ?? "");
  check("the line width can be narrowed (§22)", width === "comfortable", width);
  await page.getByRole("radio", { name: "Full width" }).click();
  await page.getByLabel("Interface size").selectOption("13");
  await page.getByLabel("Note text size").selectOption("16");
  await page.waitForTimeout(400);

  await page.getByRole("radio", { name: "System" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.waitForTimeout(400);

  // `Alt` plus the menu's letter, which is how a menu bar has always been reached without a mouse.
  await page.keyboard.press("Alt+f");
  await page.waitForTimeout(400);
  const menuOpen = await page.evaluate(() => Boolean(document.querySelector('[role="menu"]')));
  check("Alt+F opens the File menu (§22)", menuOpen);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const statusBar = await page.evaluate(
    () => document.querySelector(".status-bar")?.textContent ?? "",
  );
  check(
    "the status bar states the version and that content is encrypted (§22)",
    /v\d+\.\d+\.\d+/.test(statusBar) && /Encrypted/.test(statusBar),
    statusBar.slice(0, 80),
  );

  // 10. Replace the authenticator from the recovery session (§3), then sign in with the new one. The
  //    full circle is what proves the recovery path is a way back in rather than a dead end.
  const rebindPrompt = await page.$('[aria-label="Set up a new authenticator"]');
  check("a recovery login offers to replace the authenticator (§3)", rebindPrompt !== null);
  if (rebindPrompt) {
    await page.getByRole("button", { name: /generate a new secret/i }).click();
    const newSecret =
      (await page.getByTestId("rebind-secret").textContent({ timeout: 20_000 }))?.trim() ?? "";
    check(
      "the rebind shows a new authenticator secret",
      newSecret.length >= 16,
      `${newSecret.length} chars`,
    );

    await page.fill('input[aria-label="New authenticator code"]', totpFromBase32(newSecret));
    await page.getByRole("button", { name: /replace my authenticator/i }).click();
    await page.waitForTimeout(4000);

    const afterRebind = await page.evaluate(() => document.body.innerText);
    check(
      "finishing a rebind signs the device out again",
      /sign in|signed out|replaced/i.test(afterRebind),
      afterRebind.slice(0, 80).replace(/\n+/g, " "),
    );
  }

  // 12. Platform (§32): the version is visible, and the application can be installed.
  const version = await page.evaluate(
    () => document.querySelector('[data-testid="app-version"]')?.textContent ?? "",
  );
  check(
    "the application version is visible (§32)",
    /SecureNotes \d+\.\d+\.\d+/.test(version),
    version.trim(),
  );

  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest", { cache: "no-store" });
    if (!response.ok) {
      return { status: response.status };
    }
    const parsed = await response.json();
    // The icons are checked too: a manifest that installs and then has no icon is not installable in practice.
    const icons = await Promise.all(
      (parsed.icons ?? []).map(async (icon) => {
        const iconResponse = await fetch(icon.src, { cache: "no-store" });
        return { sizes: icon.sizes, ok: iconResponse.ok };
      }),
    );
    return {
      status: 200,
      name: parsed.name,
      shortName: parsed.short_name,
      startUrl: parsed.start_url,
      display: parsed.display,
      icons,
    };
  });
  diagnostics.push(`MANIFEST: ${JSON.stringify(manifest)}`);
  check(
    "a web app manifest is served and installable (§32)",
    manifest.status === 200 &&
      typeof manifest.name === "string" &&
      typeof manifest.startUrl === "string" &&
      typeof manifest.display === "string" &&
      (manifest.icons ?? []).length > 0 &&
      (manifest.icons ?? []).every((icon) => icon.ok),
    JSON.stringify(manifest),
  );

  // 11. The app's own errors.
  const ownPageErrors = pageErrors.filter((message) => !EMBED_ORIGINATED.test(message));
  const ownConsoleErrors = consoleErrors.filter(
    (message) =>
      !EMBED_ORIGINATED.test(message) &&
      !EXPECTED_CONFLICT.test(message) &&
      !EXPECTED_PRECONDITION.test(message),
  );
  check(
    "no uncaught errors in the app",
    ownPageErrors.length === 0,
    ownPageErrors.slice(0, 2).join(" | "),
  );
  check(
    "no console errors in the app",
    ownConsoleErrors.length === 0,
    ownConsoleErrors.slice(0, 2).join(" | "),
  );

  if (pageErrors.length > 0) {
    console.log(
      `  note ${pageErrors.length} error(s) came from the embedded page (measured: absent with a script-free embed), reported and not ignored:`,
    );
    for (const message of pageErrors.slice(0, 3)) {
      console.log(`       ${message.slice(0, 120)}`);
    }
  }
} catch (error) {
  failures.push(`  FAIL the run stopped early: ${String(error).slice(0, 300)}`);
  await page.screenshot({ path: `${SHOTS}/e2e-fatal.png` }).catch(() => undefined);
} finally {
  await browser.close();
}

console.log(notes.join("\n"));
if (failures.length > 0) {
  console.log(failures.join("\n"));
  for (const entry of diagnostics) {
    console.log(`  diagnostic ${entry}`);
  }
  console.log(`  failing api calls: ${JSON.stringify(apiFailures.slice(0, 12))}`);
  console.log(`e2e browser checks: ${notes.length} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`e2e browser checks: all ${notes.length} passed`);
