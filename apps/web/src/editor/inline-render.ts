import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorState } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

import { sanitizeHtml, sanitizeSvg } from "../render/sanitize";

/**
 * In-place rendering of formulas and diagrams inside the WYSIWYG editor (§12).
 *
 * Decoration-based on purpose: the rendered result is **not** part of the document, so the
 * Markdown stays canonical and what is saved is unaffected. Milkdown 7's kit ships no math
 * or diagram plugin (its exports were checked), so this is the mechanism available.
 *
 * Two rules shape the behaviour:
 * - the source text is hidden only while the selection is elsewhere; putting the cursor in a
 *   formula shows the TeX again, because otherwise it could never be edited;
 * - nothing is inserted into the DOM without going through the same sanitizer the preview
 *   uses — a formula is not more trustworthy than the note it sits in.
 */

/** Display math first, so the inline pattern cannot match inside `$$ … $$`. */
const MATH = /\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g;

export const inlineRenderKey = new PluginKey("securenotes-inline-render");

/** Rendered diagrams by source, so a re-render is not a re-render of the same diagram. */
const diagramCache = new Map<string, string>();

/** Renders in progress, so a decoration rebuilt mid-flight joins the existing render. */
const inFlight = new Map<string, Promise<string>>();

function renderOnce(source: string): Promise<string> {
  const existing = inFlight.get(source);
  if (existing) {
    return existing;
  }
  const pending = renderDiagram(source).then((svg) => {
    diagramCache.set(source, svg);
    inFlight.delete(source);
    return svg;
  });
  inFlight.set(source, pending);
  return pending;
}

function mathElement(tex: string, display: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = display ? "math-preview math-preview-block" : "math-preview";

  try {
    // `trust: false` is KaTeX's own default and is set explicitly: a formula must not be able
    // to emit markup or links (§12). The output is sanitised like any other markup.
    span.innerHTML = sanitizeHtml(
      // Loaded lazily so the math renderer is not in the editor's own import graph.
      renderToString(tex, display),
    );
  } catch {
    span.textContent = tex;
  }
  return span;
}

// `katex` is imported statically here rather than dynamically: this module is already inside
// the lazily loaded editor chunk, and a synchronous decoration needs the renderer available.
import katex from "katex";
// The stylesheet is not optional. KaTeX's output is a tree of spans whose meaning — fractions, radicals, sub- and
// superscripts, spacing, and the whole of display mode — lives in its CSS; without it the formula renders as a
// readable-looking jumble of symbols, which is exactly what "it renders but incorrectly" was. Imported here rather
// than in the entry so its cost lands in the editor's own chunk.
import "katex/dist/katex.min.css";

function renderToString(tex: string, display: boolean): string {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false });
}

/** Whether the selection touches a range, which is when its source must stay visible. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    // `SelectionRange` exposes resolved positions, not plain ones.
    if (range.$from.pos <= to && range.$to.pos >= from) {
      return true;
    }
  }
  return false;
}

function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];

  state.doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text ?? "";
      for (const match of text.matchAll(MATH)) {
        const display = match[1] !== undefined;
        const tex = (display ? match[1] : match[2]) ?? "";
        const start = pos + (match.index ?? 0);
        const end = start + match[0].length;
        const editing = selectionTouches(state, start, end);
        if (!editing) {
          // The source is hidden and the rendered formula takes its place.
          decorations.push(Decoration.inline(start, end, { class: "render-source-hidden" }));
        }
        decorations.push(Decoration.widget(start, () => mathElement(tex, display), { side: -2 }));
      }
      return;
    }

    if (node.type.name === "code_block") {
      const language = String(node.attrs["language"] ?? "").toLowerCase();
      if (language !== "mermaid") {
        return;
      }
      const source = node.textContent;

      decorations.push(
        Decoration.widget(
          pos + node.nodeSize,
          () => {
            // The rendered DOM persists once created, so the *widget fills itself* when the async
            // render finishes. Creating the decoration only after the cache was warm meant nothing
            // ever repainted and every diagram stayed a code block.
            const cached = diagramCache.get(source);
            if (cached !== undefined) {
              return cached.length === 0 ? document.createElement("span") : diagramElement(cached);
            }

            const placeholder = document.createElement("div");
            placeholder.className = "diagram-preview";
            placeholder.textContent = "Rendering diagram…";

            void renderOnce(source).then((svg) => {
              if (svg.length === 0) {
                // Left unrendered rather than replaced by an error: the code block is still there.
                placeholder.remove();
                return;
              }
              placeholder.textContent = "";
              placeholder.innerHTML = svg;
            });

            return placeholder;
          },
          { side: 1 },
        ),
      );
    }
    return;
  });

  return DecorationSet.create(state.doc, decorations);
}

function diagramElement(svg: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "diagram-preview";
  wrapper.innerHTML = svg;
  return wrapper;
}

/** Renders a diagram and returns sanitised SVG, or an empty string when it cannot render. */
async function renderDiagram(source: string): Promise<string> {
  try {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // `<foreignObject>` labels are removed by the SVG sanitizer (it can embed HTML), so the
      // default would render diagrams without labels.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    const { svg } = await mermaid.render(`inline-${Math.random().toString(36).slice(2)}`, source);
    // §12: Mermaid output passes through the SVG sanitizer before it reaches the DOM.
    return sanitizeSvg(svg);
  } catch {
    // Left unrendered rather than replaced by an error: the code block is still there.
    return "";
  }
}

/** The Milkdown plugin that renders formulas and diagrams in place. */
export const inlineRenderPlugin = $prose(
  () =>
    new Plugin({
      key: inlineRenderKey,
      props: {
        decorations(state) {
          return buildDecorations(state);
        },
      },
    }),
);

/** Test seam: the diagram cache is process-wide, so tests must be able to clear it. */
export function clearDiagramCache(): void {
  diagramCache.clear();
  inFlight.clear();
}
