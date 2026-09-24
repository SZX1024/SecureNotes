import { $remark } from "@milkdown/kit/utils";

/**
 * Markdown nodes whose optional attributes Milkdown's schema requires.
 *
 * `![alt](url)` written without a title parses to an mdast node with `title: null`, but the
 * image node in Milkdown's schema declares `title` as a string — so the conversion throws
 * `Expected value of type string for attribute title on type image, got null` and the whole
 * editor fails to render. A note with any image was therefore unopenable in WYSIWYG, and a
 * missing `alt` fails the same way.
 *
 * The fix normalises the tree before the conversion instead of rewriting the note's
 * Markdown: the stored text keeps whatever the author wrote, and `""` is what an absent
 * title means.
 */

interface MdastNode {
  type?: string;
  title?: unknown;
  alt?: unknown;
  children?: MdastNode[];
}

function walk(node: MdastNode, visit: (candidate: MdastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

export const missingTitleFix = $remark(
  "securenotes-missing-titles",
  () => () => (tree: MdastNode) => {
    walk(tree, (node) => {
      if (node.type !== "image" && node.type !== "link") {
        return;
      }
      if (node.title === null || node.title === undefined) {
        node.title = "";
      }
      if (node.type === "image" && (node.alt === null || node.alt === undefined)) {
        node.alt = "";
      }
    });
  },
);
