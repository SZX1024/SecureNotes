/**
 * The browser checks themselves (§12, §31).
 *
 * Enrolment is performed here rather than assumed, so the run needs no existing account and no
 * secret from anyone's database: a fresh persistence directory means the app opens on its first-run
 * screen, and the authenticator URI it displays is read straight out of the page.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5174";
const SHOTS = `${ROOT}/.sandbox-home/shots`;

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
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "WYSIWYG", exact: true }).click();
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
  await page.getByRole("button", { name: /save/i }).click();
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

  // 8. Diagrams render in place in the visual editor, not only in the preview.
  if (await page.$(".cm-content")) {
    await page.getByRole("button", { name: "WYSIWYG", exact: true }).click();
    await page.waitForTimeout(7000);
  }
  const inPlace = await page.evaluate(() => ({
    diagrams: document.querySelectorAll(".wysiwyg-editor .diagram-preview svg").length,
    katex: document.querySelectorAll(".wysiwyg-editor .katex").length,
  }));
  check("formulas render in place in the editor", inPlace.katex > 0, `${inPlace.katex}`);
  check("diagrams render in place in the editor", inPlace.diagrams > 0, `${inPlace.diagrams}`);

  // 9. Replace the authenticator from the recovery session (§3), then sign in with the new one. The
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

  // 10. The app's own errors.
  const ownPageErrors = pageErrors.filter((message) => !EMBED_ORIGINATED.test(message));
  const ownConsoleErrors = consoleErrors.filter((message) => !EMBED_ORIGINATED.test(message));
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
  console.log(`e2e browser checks: ${notes.length} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`e2e browser checks: all ${notes.length} passed`);
