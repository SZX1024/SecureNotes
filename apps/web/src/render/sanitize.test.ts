import { describe, expect, it } from "vitest";

import {
  EMBED_SANDBOX,
  containsActiveContent,
  isSafeEmbedUrl,
  isSafeImageUrl,
  isSafeLinkUrl,
  sanitizeCss,
  sanitizeEmbedAttributes,
  sanitizeHtml,
  sanitizeSvg,
} from "./sanitize";

/**
 * Rendering security (§12, §13, §31).
 *
 * These tests are attack attempts, not usage examples. A note is attacker-reachable
 * in the sense that matters: whatever is inside it becomes DOM next to the DEK, so
 * every vector below is one that has been used against real editors.
 */

describe("HTML sanitisation (§12)", () => {
  it("removes script tags entirely, including their content", () => {
    const clean = sanitizeHtml("<p>ok</p><script>alert(1)</script>");

    expect(clean).toContain("ok");
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("alert");
  });

  it("strips inline event handlers in every casing and spacing", () => {
    const clean = sanitizeHtml(
      '<img src="https://example.com/a.png" onerror="alert(1)" ONLOAD="alert(2)" onmouseover = "alert(3)">' +
        '<div onclick="alert(4)">x</div>',
    );

    expect(clean).not.toMatch(/onerror|onload|onmouseover|onclick/i);
    // The safe attribute survives; only the handlers are dropped.
    expect(clean).toContain("https://example.com/a.png");
  });

  it("refuses javascript: and data: URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:image/svg+xml,<svg onload=alert(1)>",
    ]) {
      const clean = sanitizeHtml(`<a href="${url}">x</a><img src="${url}">`);
      expect(clean, url).not.toMatch(/javascript:|vbscript:|data:/i);
    }
  });

  it("rejects protocol-relative and other sneaky hrefs", () => {
    const clean = sanitizeHtml('<a href="//evil.example/x">x</a>');

    // `//host` is not a same-origin path, so the href is dropped.
    expect(clean).not.toContain("//evil.example");
  });

  it("adds noopener noreferrer to external links only (§12)", () => {
    const clean = sanitizeHtml('<a href="https://example.com">out</a><a href="#anchor">in</a>');

    expect(clean).toMatch(/rel="noopener noreferrer"/);
    expect(clean).toContain('target="_blank"');
    // An in-page anchor must not open a new tab.
    const container = document.createElement("div");
    container.innerHTML = clean;
    const links = [...container.querySelectorAll("a")];
    expect(links[1]?.getAttribute("target")).toBeNull();
  });

  it("keeps the markup the product actually needs", () => {
    const clean = sanitizeHtml(
      "<h1>Title</h1><p><strong>bold</strong> <em>italic</em> <code>x</code></p>" +
        "<ul><li>one</li></ul><blockquote>q</blockquote>" +
        "<table><tr><th>h</th><td>d</td></tr></table>" +
        '<input type="checkbox" checked><img src="https://example.com/i.png" alt="a">',
    );

    for (const tag of [
      "<h1>",
      "<strong>",
      "<em>",
      "<code>",
      "<ul>",
      "<li>",
      "<blockquote>",
      "<table>",
      "<th>",
      "<td>",
    ]) {
      expect(clean, tag).toContain(tag);
    }
    expect(clean).toContain('type="checkbox"');
    expect(clean).toContain("https://example.com/i.png");
  });

  it("removes form controls that are not task-list checkboxes", () => {
    const clean = sanitizeHtml(
      '<input type="text" name="x"><input type="submit"><button>go</button><form action="https://evil.example"><input type="checkbox"></form>',
    );

    expect(clean).not.toMatch(/type="text"|type="submit"|<button|<form/);
    expect(clean).toContain('type="checkbox"');
  });

  it("keeps an HTTPS embed but isolates it (§12)", () => {
    const clean = sanitizeHtml('<iframe src="https://player.example/v/abc"></iframe>');

    const container = document.createElement("div");
    container.innerHTML = clean;
    const frame = container.querySelector("iframe");

    expect(frame).not.toBeNull();
    // The protection is the sandbox, not the hostname: without same-origin the embed sits in
    // an opaque origin and cannot reach this origin's DOM, storage or keys.
    expect(frame!.getAttribute("sandbox")).toBe(EMBED_SANDBOX);
    expect(frame!.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(containsActiveContent(clean)).toBe(false);
  });

  it("discards permissions a note tries to grant an embed", () => {
    const clean = sanitizeHtml(
      '<iframe src="https://player.example/v" sandbox="allow-same-origin allow-scripts" allow="camera; microphone" referrerpolicy="unsafe-url"></iframe>',
    );

    const container = document.createElement("div");
    container.innerHTML = clean;
    const frame = container.querySelector("iframe")!;

    expect(frame.getAttribute("sandbox")).toBe(EMBED_SANDBOX);
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("removes an embed that is not HTTPS", () => {
    for (const url of [
      "http://player.example/v",
      "javascript:alert(1)",
      "data:text/html,x",
      "//player.example/v",
    ]) {
      expect(sanitizeHtml(`<iframe src="${url}"></iframe>`), url).not.toContain("<iframe");
    }
  });

  it("keeps an HTTPS video and forbids its children", () => {
    const clean = sanitizeHtml(
      '<video src="https://media.example/v.mp4" autoplay controls><source src="https://evil.example/x.mp4"></video>',
    );

    const container = document.createElement("div");
    container.innerHTML = clean;
    const video = container.querySelector("video")!;

    expect(video.getAttribute("src")).toBe("https://media.example/v.mp4");
    expect(video.hasAttribute("controls")).toBe(true);
    // No autoplay, and no child that could name another URL.
    expect(video.hasAttribute("autoplay")).toBe(false);
    expect(container.querySelector("source")).toBeNull();
    expect(clean).not.toContain("evil.example");
  });

  it("removes a video that is not HTTPS", () => {
    expect(sanitizeHtml('<video src="http://media.example/v.mp4"></video>')).not.toContain(
      "<video",
    );
  });

  it("still drops objects and other active containers", () => {
    expect(sanitizeHtml('<object data="x"></object><embed src="y"><applet></applet>')).not.toMatch(
      /object|embed|applet/i,
    );
  });

  it("survives the classic mutation and namespace bypasses", () => {
    const vectors = [
      "<scr<script>ipt>alert(1)</scr</script>ipt>",
      "<svg><script>alert(1)</script></svg>",
      "<math><mtext><script>alert(1)</script></mtext></math>",
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      "<template><script>alert(1)</script></template>",
      '<a href="jav&#x09;ascript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
    ];

    for (const vector of vectors) {
      const clean = sanitizeHtml(vector);
      expect(containsActiveContent(clean), vector).toBe(false);
      expect(clean, vector).not.toMatch(/<script/i);
    }
  });

  it("is idempotent, so re-rendering a sanitised note cannot drift", () => {
    const once = sanitizeHtml('<p>a</p><script>b</script><a href="https://x.example">c</a>');
    expect(sanitizeHtml(once)).toBe(once);
  });
});

describe("CSS filtering (§12)", () => {
  it("keeps a small allowlist of safe declarations", () => {
    expect(sanitizeCss("color: red; font-weight: bold; text-align: center")).toBe(
      "color: red; font-weight: bold; text-align: center",
    );
  });

  it("drops anything that can fetch or execute", () => {
    const filtered = sanitizeCss(
      "background: url(https://evil.example/track.png); width: expression(alert(1)); behavior: url(x.htc); -moz-binding: url(y.xml)",
    );

    expect(filtered).toBe("");
  });

  it("drops unknown properties and malformed values", () => {
    expect(sanitizeCss("position: fixed; z-index: 9999; color: not a color at all")).toBe("");
    // A property name that is not on the list is dropped even with a tame value.
    expect(sanitizeCss("cursor: pointer")).toBe("");
  });

  it("rejects comments and escapes used to smuggle declarations", () => {
    expect(sanitizeCss("color: red/*;background:url(x)*/")).toBe("");
    expect(sanitizeCss("color: red\\3b background: url(x)")).toBe("");
    expect(sanitizeCss("color: red; @import url(https://evil.example)")).toBe("color: red");
  });

  it("filters style attributes inside sanitised HTML", () => {
    const clean = sanitizeHtml(
      '<p style="color: red; background: url(https://evil.example/x.png)">t</p>',
    );

    expect(clean).toContain("color: red");
    expect(clean).not.toContain("url(");
  });
});

describe("SVG sanitisation (§12, §31)", () => {
  it("keeps an ordinary diagram", () => {
    const clean = sanitizeSvg(
      '<svg viewBox="0 0 10 10"><rect x="1" y="1" width="5" height="5" fill="#333"/></svg>',
    );

    expect(clean).toContain("<svg");
    expect(clean).toContain("<rect");
  });

  it("removes script, event handlers and foreignObject", () => {
    const clean = sanitizeSvg(
      '<svg onload="alert(1)"><script>alert(2)</script><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(3)></body></foreignObject><circle cx="1" cy="1" r="1"/></svg>',
    );

    expect(clean).not.toMatch(/script|onload|foreignObject|onerror/i);
    expect(clean).toContain("<circle");
  });

  it("allows internal references but blocks external ones", () => {
    const clean = sanitizeSvg(
      '<svg><defs><path id="s" d="M0 0"/></defs><use href="#s"/><image href="https://evil.example/track.png"/><use xlink:href="https://evil.example/x"/></svg>',
    );

    expect(clean).toContain('href="#s"');
    expect(clean).not.toContain("evil.example");
  });

  it("handles an SVG hidden inside sanitised HTML", () => {
    const clean = sanitizeHtml(
      '<p>x</p><svg><script>alert(1)</script><use href="https://evil.example"/></svg>',
    );

    expect(clean).not.toMatch(/script|evil\.example/);
  });

  it("renders mermaid output through the same sanitizer (§12)", () => {
    // Mermaid output is inserted after this pass, so an injection that survived
    // would run with full privileges.
    const mermaidish =
      '<svg id="mermaid"><g class="node"><text>flow</text></g><script>fetch("https://evil.example")</script><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>';

    const clean = sanitizeSvg(mermaidish);

    expect(clean).toContain("flow");
    expect(containsActiveContent(clean)).toBe(false);
  });
});

describe("URL policy (§12)", () => {
  it("allows http(s) and same-origin paths for links", () => {
    expect(isSafeLinkUrl("https://example.com")).toBe(true);
    expect(isSafeLinkUrl("http://example.com")).toBe(true);
    expect(isSafeLinkUrl("/notes/1")).toBe(true);
    expect(isSafeLinkUrl("#section")).toBe(true);

    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("//evil.example")).toBe(false);
    expect(isSafeLinkUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeLinkUrl("")).toBe(false);
  });

  it("requires HTTPS for external images", () => {
    expect(isSafeImageUrl("https://example.com/i.png")).toBe(true);
    expect(isSafeImageUrl("/api/v1/attachments/abc/content")).toBe(true);

    // Plain HTTP would leak the note's existence to a network observer.
    expect(isSafeImageUrl("http://example.com/i.png")).toBe(false);
    expect(isSafeImageUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeImageUrl("/etc/passwd")).toBe(false);
  });

  it("requires HTTPS for embeds", () => {
    expect(isSafeEmbedUrl("https://player.example/video")).toBe(true);
    expect(isSafeEmbedUrl("http://player.example/video")).toBe(false);
    expect(isSafeEmbedUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("embed isolation (§12, §31)", () => {
  it("never grants allow-same-origin", () => {
    const attributes = sanitizeEmbedAttributes("https://player.example/v");

    expect(attributes).not.toBeNull();
    expect(attributes!["sandbox"]).toBe(EMBED_SANDBOX);
    // With same-origin the embed could reach this origin's DOM and the DEK.
    expect(attributes!["sandbox"]).not.toContain("allow-same-origin");
    expect(attributes!["referrerpolicy"]).toBe("no-referrer");
    expect(attributes!["allow"]).toBe("");
  });

  it("refuses an embed URL that is not HTTPS", () => {
    expect(sanitizeEmbedAttributes("http://player.example/v")).toBeNull();
    expect(sanitizeEmbedAttributes("javascript:alert(1)")).toBeNull();
  });

  it("treats active content in an embed as absent", () => {
    expect(containsActiveContent('<iframe src="https://x.example"></iframe>')).toBe(true);
    expect(containsActiveContent('<p onclick="x()">t</p>')).toBe(true);
    expect(containsActiveContent('<img src="data:text/html,x">')).toBe(true);
    expect(containsActiveContent("<p>clean</p>")).toBe(false);
  });
});
