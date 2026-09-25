/**
 * Captures the interface as it currently looks.
 *
 * Exists so a change to the visual language can be reviewed as an image rather than described: light and dark, wide
 * and narrow. It signs in on the running development server with a generated authenticator code, so it needs the
 * worker and the web server up (see the README) — the same assumption the other browser scripts make.
 *
 * Nothing here is asserted. The end-to-end suite is where behaviour is checked; this is for looking at.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const CHROME = "/usr/bin/google-chrome";
const ROOT = "/home/SZX10246/Projects/software/SecureNotes";
const OUT = process.env.SHOT_DIR ?? `${ROOT}/.sandbox-home/ui`;
const BASE = process.env.WEB_URL ?? "http://localhost:5173/";

mkdirSync(OUT, { recursive: true });

const { username, code } = JSON.parse(
  execFileSync("node", [`${ROOT}/scripts/dev-totp.mjs`], { encoding: "utf8" }),
);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('input[aria-label="Username"]', { timeout: 20_000 });
  await page.fill('input[aria-label="Username"]', username);
  await page.fill('input[aria-label="Authenticator code"]', code);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".shell, main.pane-single", { timeout: 25_000 });
  await page.waitForTimeout(2500);
  return page;
}

/** Picks a theme the way a person would, so what is captured is what the setting actually produces. */
async function chooseTheme(page, label) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: label }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.waitForSelector(".overlay", { state: "detached", timeout: 10_000 });
  await page.waitForTimeout(400);
}

/** What the frame looks like from inside the page, so a puzzling screenshot is answered with facts. */
async function frameState(page) {
  return page.evaluate(() => ({
    menuBar: Boolean(document.querySelector(".menu-bar")),
    statusBar: Boolean(document.querySelector(".status-bar")),
    overlay: Boolean(document.querySelector(".overlay")),
    scrollY: window.scrollY,
    app: Math.round(document.querySelector(".app")?.getBoundingClientRect().height ?? -1),
    viewport: window.innerHeight,
    // Laid out where it should be, and actually painted there: a bar that is present but not hit-testable at its
    // own coordinates is a stacking problem rather than a missing element.
    menuRect: (() => {
      const box = document.querySelector(".menu-bar")?.getBoundingClientRect();
      return box ? [Math.round(box.top), Math.round(box.height)] : null;
    })(),
    statusRect: (() => {
      const box = document.querySelector(".status-bar")?.getBoundingClientRect();
      return box ? [Math.round(box.top), Math.round(box.height)] : null;
    })(),
    appScroll: (() => {
      const app = document.querySelector(".app");
      return app ? [app.scrollTop, app.scrollHeight, app.clientHeight] : null;
    })(),
    shell: (() => {
      const shell = document.querySelector(".shell");
      return shell
        ? {
            rect: [
              Math.round(shell.getBoundingClientRect().top),
              Math.round(shell.getBoundingClientRect().height),
            ],
            scrollHeight: shell.scrollHeight,
            children: [...shell.children].map((child) => [
              child.className.split(" ")[0],
              Math.round(child.getBoundingClientRect().height),
              child.scrollHeight,
            ]),
          }
        : null;
    })(),
    menuHits: document.elementFromPoint(300, 17)?.closest(".menu-bar") !== null,
    statusHits: document.elementFromPoint(300, innerHeight - 12)?.closest(".status-bar") !== null,
  }));
}

const wide = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const desktop = await signIn(wide);
await chooseTheme(desktop, "Light");
console.log("frame (light):", JSON.stringify(await frameState(desktop)));
await desktop.screenshot({ path: `${OUT}/desktop-light.png` });
await chooseTheme(desktop, "Dark");
console.log("frame (dark):", JSON.stringify(await frameState(desktop)));
await desktop.screenshot({ path: `${OUT}/desktop-dark.png` });

// An open File menu, because the file operations are what the top bar is for.
await desktop.getByRole("button", { name: "File", exact: true }).click();
await desktop.waitForTimeout(400);
await desktop.screenshot({ path: `${OUT}/desktop-dark-file-menu.png` });

// The phone layout from the same session. A separate context would have to sign in again, and the mobile sign-in
// screen is not what this is for: the question is what the application looks like on a phone.
await desktop.getByRole("button", { name: "File", exact: true }).press("Escape");
await desktop.setViewportSize({ width: 390, height: 844 });
await desktop.waitForTimeout(1500);
await desktop.screenshot({ path: `${OUT}/mobile.png` });

console.log(`captured into ${OUT}`);
await browser.close();
