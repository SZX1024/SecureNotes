/**
 * Captures the interface as it currently looks.
 *
 * One command, and nothing to have running first: it starts a Worker and a dev server on its own ports against its own
 * database, enrols an account through the interface, writes a note worth photographing, and captures light and dark,
 * wide and narrow. It then stops everything it started.
 *
 * That self-containment is the point rather than a nicety. The earlier version borrowed whatever was on port 5173, so
 * a stale bundle, an account that was already enrolled or a rate limit tripped an hour earlier each looked like a
 * product bug — and looking at the interface is exactly when that mistake is most expensive.
 *
 * Nothing here is asserted. The end-to-end suite is where behaviour is checked; this is for looking at.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

import { enrol, signIn, startStack } from "./lib/dev-stack.mjs";

const CHROME = "/usr/bin/google-chrome";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = process.env.SHOT_DIR ?? `${ROOT}/.sandbox-home/ui`;

/** A note that shows what the application can do, so a screenshot is about the interface rather than about emptiness. */
const DEMO_NOTE = `# Demonstrating SecureNotes

Text with **bold**, _italic_, \`inline code\` and a link to [the docs](https://example.com).

Inline maths $E = mc^2$ and a display formula:

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

- [x] something done
- [ ] something else

| Column | Value |
| --- | --- |
| one | 1 |
| two | 2 |

\`\`\`js
const answer = 42;
\`\`\`
`;

/**
 * Clicks a button in the editor pane.
 *
 * With a fallback, for the same reason the end-to-end suite has one: these buttons resolve to exactly one element and
 * are visible, enabled and stable across samples, and Playwright's actionability check still never settles once the
 * workspace is a fixed-height frame. Recorded here rather than worked around quietly — it reproduces in a fresh
 * environment on fresh ports, so it is not a cache artefact, and it is the one thing about this interface that no test
 * can currently do the way a person does.
 */
async function clickEditor(target, label) {
  const button = target.locator(`.pane.editor button:text-is("${label}")`);
  try {
    await button.click({ timeout: 8000 });
  } catch {
    await button.evaluate((element) => element.click());
  }
  await target.waitForTimeout(900);
}

mkdirSync(OUT, { recursive: true });

const stack = await startStack();
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  const secret = await enrol(page, { baseUrl: stack.baseUrl });

  // A folder and a tag, so the metadata bar has something in it.
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByLabel("New folder name").fill("Reading");
  await page.getByRole("button", { name: "Add folder" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByLabel("New tag name").fill("notes");
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.waitForTimeout(800);

  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "New note", exact: true }).first().click();
  await page.waitForTimeout(3000);
  await page.getByLabel("Note title").fill("Demonstrating SecureNotes");
  await page.click(".cm-content, .ProseMirror");
  await page.keyboard.insertText(DEMO_NOTE);
  await page.waitForTimeout(1500);
  await clickEditor(page, "Save (Ctrl+S)");
  await page.waitForTimeout(2500);
  await page.getByLabel("Note folder").selectOption({ label: "Reading" });
  await page.waitForTimeout(2000);
  await page.getByRole("checkbox", { name: "notes" }).check();
  await page.waitForTimeout(2000);

  const chooseTheme = async (label) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: label }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.waitForSelector(".overlay", { state: "detached", timeout: 10_000 });
    await page.waitForTimeout(700);
  };

  await chooseTheme("Light");
  await page.screenshot({ path: `${OUT}/desktop-light.png` });

  await chooseTheme("Dark");
  await page.screenshot({ path: `${OUT}/desktop-dark.png` });

  await clickEditor(page, "Preview");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/preview-dark.png` });
  await clickEditor(page, "Edit");
  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/settings-dark.png` });
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.waitForSelector(".overlay", { state: "detached", timeout: 10_000 });

  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/file-menu-dark.png` });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/mobile.png` });
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/mobile-drawer.png` });

  // Signing in again on the same database, which is what a device that already has the key looks like.
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page, { baseUrl: stack.baseUrl, secret });
  await page.screenshot({ path: `${OUT}/restored.png` });

  console.log(`captured into ${OUT}`);
} catch (error) {
  console.error("shots: failed:", error.message);
  console.error(stack.output());
  process.exitCode = 1;
} finally {
  await browser.close();
  stack.stop();
}
