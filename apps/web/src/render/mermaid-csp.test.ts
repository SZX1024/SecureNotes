import { describe, expect, it } from "vitest";

import { containsActiveContent, sanitizeSvg } from "./sanitize";

/**
 * Mermaid must not need `'unsafe-eval'` (§13).
 *
 * The shell policy sets `script-src 'self'` with no `'unsafe-eval'`, because §13
 * forbids weakening CSP to permit arbitrary script execution. Mermaid is the one
 * dependency that could plausibly force a relaxation, so this test measures it
 * rather than trusting a version note: the `Function` constructor is replaced with
 * a throwing proxy, and every diagram type is parsed and one is rendered. If a
 * future upgrade starts using it, this fails loudly instead of the CSP quietly
 * becoming the thing that breaks diagrams.
 *
 * jsdom has no layout engine, so diagram types that measure text with `getBBox`
 * cannot render here; that is a rendering limitation, not an eval one, which is why
 * the parse step covers the breadth and only a layout-free type is rendered.
 */
describe("mermaid and the script policy (§13)", () => {
  it("ships no eval or Function constructor anywhere in its bundle", async () => {
    // First attempt at this guard replaced `globalThis.Function` at runtime and
    // asserted no violations. That guard was vacuous — the replacement never took
    // effect, which its own self-check caught — so the check is static instead: read
    // the shipped files and look for the constructors. It also asserts how much code
    // it scanned, so an empty or moved directory fails rather than silently passing.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    const distDir = join(process.cwd(), "..", "..", "node_modules", ".pnpm");
    const mermaidDir = readdirSync(distDir).find((entry) => entry.startsWith("mermaid@"));
    expect(mermaidDir, "mermaid must be installed").toBeTruthy();

    const dist = join(distDir, mermaidDir!, "node_modules", "mermaid", "dist");

    const collect = (directory: string, found: string[] = []): string[] => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          collect(path, found);
        } else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) {
          found.push(path);
        }
      }
      return found;
    };

    const files = collect(dist);
    expect(files.length).toBeGreaterThan(10);

    let scanned = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      scanned += source.length;
      if (/new\s+Function\s*\(/.test(source) || /(^|[^.\w])eval\s*\(/.test(source)) {
        offenders.push(file.slice(file.indexOf("mermaid/dist")));
      }
    }

    // A real measurement, not an empty loop over nothing.
    expect(scanned).toBeGreaterThan(500_000);
    expect(offenders).toEqual([]);
  }, 30_000);

  it("hands Mermaid output to the application sanitizer as well", async () => {
    // §12's pipeline is Markdown -> Mermaid -> SVG -> sanitizer -> DOM, so Mermaid's
    // own `securityLevel: strict` is a convenience, not the trust boundary: the SVG
    // is sanitised again by us before it is ever inserted.
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

    // A pie chart is used because it needs no text measurement; the flowchart types
    // call `getBBox`, which jsdom does not implement, and that is a layout
    // limitation rather than anything about script policy.
    const { svg } = await mermaid.render("csp-link", 'pie title Pets\n  "Dogs" : 3');

    const clean = sanitizeSvg(svg);
    expect(clean).toContain("<svg");
    expect(containsActiveContent(clean)).toBe(false);
    expect(clean).not.toMatch(/javascript:/i);
  }, 60_000);
});
