import DOMPurify from "dompurify";

/**
 * Rendering security (§12, §13).
 *
 * Every string that reaches the DOM as markup goes through here. The threat model
 * is not "a malicious website" but "a note": notes are encrypted and signed, but a
 * note can still contain a `<script>` tag, an `onerror` attribute, an SVG with an
 * external reference, or CSS that fetches a URL — and if any of that became active
 * it would run with full application privileges, next to the DEK.
 *
 * So this module is an allowlist, not a blocklist: anything not named here is
 * dropped, and the tests exercise the classic bypasses rather than the happy path.
 */

/** Tags that may appear in sanitised note HTML. */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "sub",
  "sup",
  "small",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "kbd",
  "samp",
  "var",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "a",
  "img",
  "figure",
  "figcaption",
  "picture",
  "source",
  "dl",
  "dt",
  "dd",
  "abbr",
  "cite",
  "q",
  "time",
  "ruby",
  "rt",
  "rp",
  // §12 permits arbitrary HTTPS embeds. They pass through a narrow policy enforced by the
  // hooks below: HTTPS only, a sandbox without `allow-same-origin`, no permissions — so an
  // embed cannot reach this origin's DOM, storage or keys.
  "iframe",
  "video",
  "input", // task lists: type=checkbox only, enforced by a hook
  // SVG. The children have to be named too: DOMPurify's allowlist is the gate, and
  // a hook can only restrict what passed it — an unlisted `<rect>` is dropped
  // before any hook runs.
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "defs",
  "use",
  "symbol",
  "marker",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "title",
  "desc",
  "image",
  "filter",
  "feGaussianBlur",
  "feOffset",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feFuncR",
  "feFuncG",
  "feFuncB",
  "feFuncA",
  "feMerge",
  "feMergeNode",
  "switch",
];

/**
 * Attributes that may survive.
 *
 * `style` is present so that the hook below can filter it: DOMPurify removes any
 * attribute that is not named here *before* a hook sees it, so a filtered-but-
 * unlisted attribute would simply vanish (and take legitimate formatting with it).
 * The value is only ever the output of `sanitizeCss`.
 */
const ALLOWED_ATTR = [
  "style",
  "href",
  "title",
  "alt",
  "src",
  "srcset",
  "sizes",
  "width",
  "height",
  "class",
  "id",
  "lang",
  "dir",
  "datetime",
  "cite",
  "colspan",
  "rowspan",
  "scope",
  "type",
  "checked",
  "disabled",
  "start",
  "reversed",
  "value",
  "viewBox",
  "xmlns",
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "points",
  "transform",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "offset",
  "stop-color",
  "data-attachment-id",
];

/**
 * Elements that are never acceptable in note content, whatever they contain.
 * `iframe` and `video` are handled by `sanitizeEmbed` instead, so a note cannot
 * smuggle one past the default path.
 */
const FORBIDDEN_TAGS = [
  "script",
  "style",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "button",
  "select",
  "textarea",
  "option",
  "optgroup",
  "label",
  "fieldset",
  "legend",
  "link",
  "meta",
  "base",
  "title",
  "head",
  "html",
  "body",
  "template",
  "slot",
  "noscript",
  "portal",
  "math",
  "foreignObject",
  "audio",
  "track",
  "source",
  "marquee",
  "blink",
];

/** CSS properties a note may set, each with a value check. */
const ALLOWED_CSS: Readonly<Record<string, (value: string) => boolean>> = {
  color: isSimpleColor,
  "background-color": isSimpleColor,
  "font-weight": (value) => /^(normal|bold|bolder|lighter|[1-9]00)$/.test(value),
  "font-style": (value) => /^(normal|italic|oblique)$/.test(value),
  "font-size": (value) => /^\d{1,3}(\.\d+)?(px|em|rem|%)$/.test(value),
  "text-align": (value) => /^(left|right|center|justify|start|end)$/.test(value),
  "text-decoration": (value) => /^(none|underline|line-through|overline)$/.test(value),
  width: isSimpleLength,
  height: isSimpleLength,
  "max-width": isSimpleLength,
  margin: isSimpleLength,
  "margin-top": isSimpleLength,
  "margin-bottom": isSimpleLength,
  "margin-left": isSimpleLength,
  "margin-right": isSimpleLength,
  padding: isSimpleLength,
  "padding-top": isSimpleLength,
  "padding-bottom": isSimpleLength,
  "padding-left": isSimpleLength,
  "padding-right": isSimpleLength,
  "border-radius": isSimpleLength,
  display: (value) => /^(block|inline|inline-block|none|flex|grid|table)$/.test(value),
  "white-space": (value) => /^(normal|pre|pre-wrap|pre-line|nowrap)$/.test(value),
  "vertical-align": (value) =>
    /^(baseline|top|middle|bottom|sub|super|text-top|text-bottom)$/.test(value),
  opacity: (value) => /^(0|1|0?\.\d+)$/.test(value),
  "fill-opacity": (value) => /^(0|1|0?\.\d+)$/.test(value),
  "stroke-opacity": (value) => /^(0|1|0?\.\d+)$/.test(value),
  // Presentational SVG properties. Mermaid colours and positions its output with inline
  // styles, and stripping these left diagrams rendered but visibly broken. None of them
  // can fetch anything: `url(` is rejected before any property's value is inspected.
  fill: isSimpleColor,
  stroke: isSimpleColor,
  "stroke-width": (value) => /^\d{1,3}(\.\d+)?(px)?$/.test(value),
  "stroke-dasharray": (value) => /^[\d\s,.]+$/.test(value),
  "font-family": (value) => /^[\w\s,"'-]{1,80}$/.test(value),
  "text-anchor": (value) => /^(start|middle|end)$/.test(value),
  "dominant-baseline": (value) =>
    /^(auto|middle|central|hanging|text-top|text-bottom)$/.test(value),
};

function isSimpleColor(value: string): boolean {
  return (
    /^#[0-9a-f]{3,8}$/i.test(value) ||
    /^(rgb|rgba|hsl|hsla)\([0-9,.%\s/]+\)$/i.test(value) ||
    /^[a-z]{3,20}$/i.test(value)
  );
}

function isSimpleLength(value: string): boolean {
  return /^-?\d{1,4}(\.\d+)?(px|em|rem|%|ch|ex|vh|vw)?$/.test(value);
}

/**
 * Filters a `style` attribute, keeping only allowlisted properties with
 * allowlisted values.
 *
 * A property that is not named here is dropped, which is what stops the classic
 * escapes: `background: url(...)` leaks the note's identity to a third party,
 * `expression()` and `-moz-binding` execute, and `@import` pulls in more CSS.
 */
export function sanitizeCss(style: string): string {
  const kept: string[] = [];

  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();

    if (value.length === 0 || value.length > 200) {
      continue;
    }
    // Reject anything that could fetch, execute or escape the declaration.
    if (/url\s*\(|expression\s*\(|@|\\|\/\*|\*\/|javascript:|vbscript:|data:/i.test(value)) {
      continue;
    }
    const check = ALLOWED_CSS[property];
    if (check?.(value)) {
      kept.push(`${property}: ${value}`);
    }
  }

  return kept.join("; ");
}

/**
 * Filters the stylesheet a diagram carries inside its own SVG.
 *
 * Mermaid does not style its output inline: it emits a `<style>` element inside the SVG. Removing
 * that element — which the HTML policy does, and should — left every flowchart node filled black
 * with unreadable labels, because all the colour and text styling lived there. So the CSS is
 * filtered rule by rule instead: only simple selectors survive, and only the presentational
 * properties `sanitizeCss` already allows. `url()`, at-rules, expressions and escapes are rejected
 * there before any value is looked at, so a diagram still cannot fetch anything.
 */
export function sanitizeSvgStyleSheet(css: string): string {
  const rules: string[] = [];

  for (const chunk of css.split("}")) {
    const brace = chunk.indexOf("{");
    if (brace === -1) {
      continue;
    }
    const selector = chunk.slice(0, brace).trim();
    const declarations = chunk.slice(brace + 1);

    // No at-rules, no fetching, and nothing exotic in the selector.
    if (!/^[.#a-zA-Z0-9_\s>,:()[\]="'*-]{1,300}$/.test(selector)) {
      continue;
    }
    const filtered = sanitizeCss(declarations);
    if (filtered.length > 0) {
      rules.push(`${selector} { ${filtered} }`);
    }
  }

  return rules.join("\n");
}

/** Whether a URL is acceptable for a link: absolute http(s) or a same-origin path. */
export function isSafeLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("#")) {
    return true;
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    // A protocol-relative "//host" is not a same-origin path.
    return true;
  }
  return /^https?:\/\//i.test(trimmed);
}

/** Whether a URL is acceptable for an image: HTTPS only, or an internal reference. */
export function isSafeImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith("/api/v1/attachments/")) {
    // The only internal image source: ciphertext fetched by the client.
    return true;
  }
  return /^https:\/\//i.test(trimmed);
}

/**
 * Whether a URL is acceptable for an embed (§12: arbitrary HTTPS iframes are a
 * product requirement, so they are allowed but isolated).
 */
export function isSafeEmbedUrl(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}

/**
 * The sandbox an embed must carry.
 *
 * `allow-same-origin` is deliberately absent and must never be added: an iframe
 * with it could reach this origin's DOM and storage, which is where the DEK and
 * the decrypted notes live. `allow-scripts` is kept because the product allows
 * arbitrary embeds, and without same-origin the script is confined to the
 * iframe's own opaque origin.
 */
export const EMBED_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-presentation";

let hooksInstalled = false;

/** Installs the DOMPurify hooks once; they enforce what an allowlist cannot. */
function installHooks(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName.toLowerCase();

    // No event handlers, ever (§12).
    if (name.startsWith("on")) {
      data.keepAttr = false;
      return;
    }

    if (name === "style") {
      const filtered = sanitizeCss(data.attrValue);
      if (filtered.length === 0) {
        data.keepAttr = false;
      } else {
        data.attrValue = filtered;
      }
      return;
    }

    if (name === "href" || name === "xlink:href") {
      if (!isSafeLinkUrl(data.attrValue)) {
        data.keepAttr = false;
      }
      return;
    }

    if (name === "src" || name === "srcset") {
      const candidate = data.attrValue.split(/\s+/)[0] ?? "";
      if (!isSafeImageUrl(candidate)) {
        data.keepAttr = false;
      }
      return;
    }

    if (name === "type" && node.nodeName.toLowerCase() === "input") {
      // Task lists only: any other input type is a form control.
      if (data.attrValue.toLowerCase() !== "checkbox") {
        data.keepAttr = false;
      }
    }
  });

  // The element hook only decides whether an embed may exist at all. Setting attributes
  // here would be wrong: DOMPurify filters attributes *after* this hook, so an attribute
  // added here that is not on the allowlist is removed — which silently produced a frame
  // with no sandbox.
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    const tag = (data.tagName ?? "").toLowerCase();
    if (tag !== "iframe" && tag !== "video") {
      return;
    }
    const url = (node as Element).getAttribute("src") ?? "";
    const policy = tag === "iframe" ? sanitizeEmbedAttributes(url) : sanitizeVideoAttributes(url);
    if (!policy) {
      // Not HTTPS: removed rather than emptied, because an empty frame is still a frame the
      // reader did not ask for.
      (node as Element).remove();
    }
  });

  // Applied after filtering, so the policy's attributes survive and everything the note
  // asked for is discarded rather than merged.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const tag = node.nodeName.toLowerCase();
    if (tag === "iframe" || tag === "video") {
      const element = node as Element;
      const policy =
        tag === "iframe"
          ? sanitizeEmbedAttributes(element.getAttribute("src") ?? "")
          : sanitizeVideoAttributes(element.getAttribute("src") ?? "");
      if (!policy) {
        element.remove();
        return;
      }
      for (const attribute of [...element.attributes]) {
        if (!EMBED_ATTRIBUTES.includes(attribute.name.toLowerCase())) {
          element.removeAttribute(attribute.name);
        }
      }
      for (const [name, value] of Object.entries(policy)) {
        element.setAttribute(name, value);
      }
    }
  });

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName.toLowerCase() !== "a") {
      return;
    }
    const element = node as Element;
    const href = element.getAttribute("href") ?? "";
    const isExternal = /^https?:\/\//i.test(href);
    if (isExternal) {
      // §12: external links open in a new tab and cannot reach back through
      // `window.opener`.
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    } else {
      element.removeAttribute("target");
      element.setAttribute("rel", "noreferrer");
    }
  });
}

const BASE_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // No custom ALLOWED_URI_REGEXP on purpose: DOMPurify applies it to every
  // attribute that is not in its URI-safe list, so a URI-shaped regexp silently
  // deletes ordinary enumerated values (`type="checkbox"` became an empty input).
  // URL policy is enforced per attribute in the hooks below, on top of
  // DOMPurify's own default URI handling.
  FORBID_TAGS: FORBIDDEN_TAGS,
  // Only names that must never survive at all. `style` and `href` are *not* here:
  // the hooks below filter them, and a blanket ban would strip the safe forms too.
  FORBID_ATTR: ["srcdoc", "formaction", "action", "ping", "poster", "background"],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
};

/** Elements removed after sanitising, whatever the allowlist said. */
const ALWAYS_REMOVED = [
  "script",
  "foreignobject",
  "object",
  "embed",
  "applet",
  "frameset",
  "frame",
];

/**
 * Structural hardening applied after DOMPurify.
 *
 * The library works on the serialised markup and an allowlist; these are the rules
 * that need to know an element's *position* — whether it sits inside an SVG, or
 * whether an input is a task-list checkbox — which a flat attribute filter cannot
 * express.
 */
function hardenFragment(container: Element): void {
  for (const element of [...container.querySelectorAll("*")]) {
    const tag = element.tagName.toLowerCase();

    if (ALWAYS_REMOVED.includes(tag)) {
      element.remove();
      continue;
    }

    if (tag === "style") {
      const filtered = sanitizeSvgStyleSheet(element.textContent ?? "");
      if (filtered.length === 0) {
        element.remove();
      } else {
        element.textContent = filtered;
      }
      continue;
    }

    // Task lists need checkboxes; any other input is a form control.
    if (tag === "input" && (element.getAttribute("type") ?? "").toLowerCase() !== "checkbox") {
      element.remove();
      continue;
    }

    const insideSvg = element.closest("svg") !== null;

    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        const filtered = sanitizeCss(attribute.value);
        if (filtered.length === 0) {
          element.removeAttribute(attribute.name);
        } else {
          element.setAttribute(attribute.name, filtered);
        }
        continue;
      }
      // Inside an SVG, a reference may only point within the document: `<use
      // href="#shape">` is legitimate, anything else could fetch or navigate.
      if (insideSvg && (name === "href" || name === "xlink:href")) {
        if (!attribute.value.startsWith("#")) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }
}

/**
 * Sanitises note HTML for insertion into the DOM.
 *
 * `RETURN_TRUSTED_TYPE` is false because the result is inserted through React,
 * which does not accept a `TrustedHTML`; the sanitised string is the only thing
 * that reaches the DOM.
 */
export function sanitizeHtml(html: string): string {
  installHooks();
  // `String(...)` rather than a cast: the return type widens to TrustedHTML when
  // the config mentions it, and React accepts only a plain string.
  const clean = String(DOMPurify.sanitize(html, BASE_CONFIG));

  const container = document.createElement("div");
  container.innerHTML = clean;
  hardenFragment(container);
  return container.innerHTML;
}

/**
 * Sanitises an SVG document (§12).
 *
 * SVG can carry script, event handlers and external references, so it gets a
 * second pass with its own rules: `<foreignObject>` can embed HTML, and `href` /
 * `xlink:href` pointing outside the document is how an SVG exfiltrates or pulls in
 * more content.
 */
export function sanitizeSvg(svg: string): string {
  installHooks();

  // `style` is allowed here only so its contents can be filtered: the HTML policy keeps it
  // forbidden, and `hardenFragment` removes it again when nothing survives the filter.
  const clean = String(
    DOMPurify.sanitize(svg, {
      ...BASE_CONFIG,
      FORBID_TAGS: FORBIDDEN_TAGS.filter((tag) => tag !== "style"),
      ADD_TAGS: ["style"],
    }),
  );

  const container = document.createElement("div");
  container.innerHTML = clean;
  hardenFragment(container);
  return container.innerHTML;
}

/**
 * Builds the attributes an embed may carry (§12).
 *
 * The product allows arbitrary HTTPS iframes, so the isolation is what protects
 * the application: a sandbox without `allow-same-origin`, `no-referrer`, and no
 * `allow` permissions means an embed cannot read this origin's DOM, storage or
 * session, and cannot see which note it sits in.
 */
/** The only attributes an embed may carry once the policy has been applied. */
const EMBED_ATTRIBUTES = [
  "src",
  "sandbox",
  "referrerpolicy",
  "allow",
  "loading",
  "width",
  "height",
  "title",
  "class",
];

/**
 * The attributes a `<video>` may carry (§12 names "iframe/video embeds").
 *
 * A video plays media rather than running a document, so it needs no sandbox; what protects
 * this origin is that the source must be HTTPS, that no children are allowed (so a
 * `<source>` element cannot name a URL the attribute check never saw), and that autoplay is
 * absent — a note must not start playing audio the reader did not ask for.
 */
export function sanitizeVideoAttributes(url: string): Record<string, string> | null {
  if (!isSafeEmbedUrl(url)) {
    return null;
  }
  return { src: url, controls: "", preload: "metadata" };
}

export function sanitizeEmbedAttributes(url: string): Record<string, string> | null {
  if (!isSafeEmbedUrl(url)) {
    return null;
  }
  return {
    src: url,
    sandbox: EMBED_SANDBOX,
    referrerpolicy: "no-referrer",
    allow: "",
    loading: "lazy",
    // No `allowfullscreen` unless a future requirement asks for it.
  };
}

/**
 * Sanitises an embed element from note HTML, returning the element to insert or
 * null when it must not be rendered.
 */
export function sanitizeEmbed(iframe: HTMLIFrameElement): HTMLIFrameElement | null {
  const attributes = sanitizeEmbedAttributes(iframe.getAttribute("src") ?? "");
  if (!attributes) {
    return null;
  }
  const element = document.createElement("iframe");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

/** Whether a sanitised fragment contains any active content (used by tests too). */
export function containsActiveContent(html: string): boolean {
  const container = document.createElement("div");
  container.innerHTML = html;
  return (
    // An embed is not active content by itself — §12 allows it — but one that escaped the
    // policy is: a missing sandbox, or `allow-same-origin`, would place it in this origin.
    [...container.querySelectorAll("iframe")].some(
      (frame) =>
        !(frame.getAttribute("sandbox") ?? "").includes("allow-scripts") ||
        (frame.getAttribute("sandbox") ?? "").includes("allow-same-origin"),
    ) ||
    container.querySelector("script, object, embed, foreignObject") !== null ||
    [...container.querySelectorAll("*")].some((element) =>
      [...element.attributes].some(
        (attribute) =>
          attribute.name.toLowerCase().startsWith("on") ||
          /javascript:|vbscript:|data:/i.test(attribute.value),
      ),
    )
  );
}
