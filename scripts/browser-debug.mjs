/**
 * Drives the running app in a real browser to find rendering faults.
 *
 * This exists because every unit test runs in Node or jsdom, which is exactly why the service
 * worker's cache-first rule could hide the preview from a real browser while the tests stayed
 * green. Screenshots and console output are the evidence.
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const CHROME = "/usr/bin/google-chrome";
const ROOT = "/home/SZX10246/Projects/software/SecureNotes";
const OUT = process.env.SHOT_DIR ?? `${ROOT}/.sandbox-home/shots`;

const { username, code } = JSON.parse(
  execFileSync("node", [`${ROOT}/scripts/dev-totp.mjs`], { encoding: "utf8" }),
);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();

const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", (message) => consoleMessages.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("requestfailed", (request) =>
  failedRequests.push(`${request.url()} :: ${request.failure()?.errorText}`),
);

const report = { steps: [] };
const step = (name, detail) => {
  report.steps.push({ name, ...detail });
  console.log("STEP", name, JSON.stringify(detail));
};

try {
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 30000 });
  step("loaded", { title: await page.title() });

  // Log in.
  await page.waitForSelector('input[aria-label="Username"]', { timeout: 20000 });
  await page.fill('input[aria-label="Username"]', username);
  await page.fill('input[aria-label="Authenticator code"]', code);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  report.afterLogin = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log("AFTER LOGIN:", report.afterLogin.replace(/\n/g, " | "));

  if (!(await page.$('button:has-text("New note")'))) {
    await page.screenshot({ path: `${OUT}/01-login-stuck.png` });
    step("login-stuck", { body: report.afterLogin });
    throw new Error("did not reach the app shell");
  }
  step("logged-in", {});

  // Create a note and put the test document into the Markdown source editor.
  await page.click('button:has-text("New note")');
  await page.waitForTimeout(2500);

  // Diagnose the editor pane before assuming anything about it.
  const afterNew = await page.evaluate(() => ({
    body: document.body.innerText.replace(/\n+/g, " | ").slice(0, 600),
    toast: document.querySelector(".toast")?.textContent ?? null,
    titleInput: Boolean(document.querySelector('input[aria-label="Note title"]')),
    editorHost: Boolean(document.querySelector(".editor-host")),
    cmContent: Boolean(document.querySelector(".cm-content")),
    wysiwyg: Boolean(document.querySelector(".wysiwyg-editor")),
    buttons: [...document.querySelectorAll("button")]
      .map((b) => (b.textContent ?? "").trim())
      .filter(Boolean),
  }));
  step("after-new-note", afterNew);
  console.log("ALL CONSOLE:", JSON.stringify(consoleMessages.slice(0, 15)));
  await page.screenshot({ path: `${OUT}/01b-after-new-note.png` });

  const markdown = execFileSync("cat", [`${ROOT}/scripts/test-document.md`], { encoding: "utf8" });
  const mode = await page.evaluate(() => {
    const toggle = [...document.querySelectorAll("button")].find((b) =>
      /WYSIWYG|Markdown source/.test(b.textContent ?? ""),
    );
    return toggle?.textContent?.trim() ?? null;
  });
  step("editor-mode-toggle", { label: mode });

  // Source mode is what we want; the toggle's label names the mode it would switch *to*.
  if (mode === "Markdown source") {
    await page.click('button:has-text("Markdown source")');
    await page.waitForTimeout(800);
  }
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.click(".cm-content");
  await page.keyboard.insertText(markdown);
  await page.waitForTimeout(2500);
  step("typed-markdown", {
    chars: await page.evaluate(
      () => document.querySelector(".cm-content")?.textContent?.length ?? 0,
    ),
  });

  // Preview.
  await page.click('button:has-text("Preview")');
  await page.waitForTimeout(4000);
  const preview = await page.evaluate(() => {
    const host = document.querySelector(".preview");
    if (!host) return { present: false };
    return {
      present: true,
      html: host.innerHTML.length,
      text: (host.textContent ?? "").slice(0, 120),
      katex: host.querySelectorAll(".katex").length,
      diagrams: host.querySelectorAll(".diagram-preview, .mermaid-diagram").length,
      highlighted: host.querySelectorAll("[class*='hljs-']").length,
      tables: host.querySelectorAll("table").length,
      checkboxes: host.querySelectorAll('input[type="checkbox"]').length,
      iframes: host.querySelectorAll("iframe").length,
      sandboxed: [...host.querySelectorAll("iframe")].map((f) => f.getAttribute("sandbox")),
      sandboxHasSameOrigin: [...host.querySelectorAll("iframe")].some((f) =>
        (f.getAttribute("sandbox") ?? "").includes("allow-same-origin"),
      ),
      scripts: host.querySelectorAll("script").length,
      images: host.querySelectorAll("img").length,
    };
  });
  step("preview", preview);
  await page.screenshot({ path: `${OUT}/02-preview.png`, fullPage: false });

  // Scroll through the preview so the diagrams and formulas are in view.
  await page.evaluate(() => {
    const host = document.querySelector(".preview");
    if (host) host.scrollTop = host.scrollHeight * 0.45;
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/03-preview-mid.png` });

  // WYSIWYG: switch back to editing, then into visual mode.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "WYSIWYG", exact: true }).click();
  await page.waitForTimeout(6000);
  const wysiwyg = await page.evaluate(() => {
    const host = document.querySelector(".wysiwyg-editor");
    return {
      present: Boolean(host),
      text: (host?.textContent ?? "").slice(0, 100),
      katex: host?.querySelectorAll(".katex").length ?? 0,
      diagrams: host?.querySelectorAll(".diagram-preview").length ?? 0,
      hiddenSources: host?.querySelectorAll(".render-source-hidden").length ?? 0,
      images: host?.querySelectorAll("img").length ?? 0,
      failureNotice: document.body.innerText.includes("could not be opened"),
    };
  });
  step("wysiwyg", wysiwyg);
  await page.screenshot({ path: `${OUT}/04-wysiwyg.png` });
} catch (error) {
  report.fatal = String(error);
  console.log("FATAL:", String(error));
  await page.screenshot({ path: `${OUT}/99-fatal.png` }).catch(() => undefined);
} finally {
  report.pageErrors = pageErrors;
  report.failedRequests = failedRequests.slice(0, 10);
  report.consoleErrors = consoleMessages.filter((m) => m.startsWith("[error]")).slice(0, 10);
  console.log("PAGE ERRORS:", JSON.stringify(pageErrors.slice(0, 5)));
  console.log("FAILED REQUESTS:", JSON.stringify(failedRequests.slice(0, 5)));
  console.log("CONSOLE ERRORS:", JSON.stringify(report.consoleErrors));
  await browser.close();
}
