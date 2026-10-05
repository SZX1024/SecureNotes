import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { useEffect, useRef, useState } from "react";

import { inlineRenderPlugin } from "./inline-render";
import { missingTitleFix } from "./missing-titles";
import { attachmentIdFromUrl } from "../data/attachment-content";
import { ATTACHMENT_URL_PREFIX } from "./attachments";

/**
 * WYSIWYG mode (§12).
 *
 * Markdown remains the storage format: the editor is created from the note's Markdown and
 * reports Markdown back, so what is saved is never the editor's own document model. That keeps
 * the format stable if the editor is replaced, and it is why an unknown construct survives even
 * though no plugin understands it.
 *
 * The `gfm` preset supplies the tables and task lists §12 requires; code blocks, links and
 * images come from `commonmark`. Formulas and diagrams are rendered in place by a decoration
 * plugin, because Milkdown 7's kit ships no math or diagram plugin.
 *
 * This module is loaded with a dynamic `import()`: Milkdown and ProseMirror are large and are not
 * needed to show a locked note list.
 */

export interface WysiwygEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  ariaLabel?: string;
  /**
   * A displayable URL for an attachment, or null while it is being read.
   *
   * The editor renders `<img>` nodes straight from the Markdown, and the address in the Markdown points at the
   * content endpoint, which serves ciphertext — so without this every image in the visual editor is a broken
   * picture. Only the *view* is rewritten: the document keeps the canonical address, which is what makes
   * saving and syncing unaffected.
   */
  urlForAttachment?: (attachmentId: string) => string | null;
  /** Changes when a new URL becomes available, so the view can be refreshed. */
  attachmentVersion?: number;
}

export function WysiwygEditor({
  value,
  onChange,
  ariaLabel,
  urlForAttachment,
  attachmentVersion,
}: WysiwygEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Held in a ref so a re-render cannot tear down and rebuild the editor, which would lose the
  // cursor. Assigned in an effect because writing a ref during render is what React forbids.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /**
   * Shows attachments as the pictures they are.
   *
   * ProseMirror renders the image node from the Markdown, and the Markdown points at the content endpoint,
   * which answers with ciphertext: the image cannot load, so it shows as a broken picture. The fix is at the
   * view level — the `<img>` in the DOM gets the decrypted blob URL while the document keeps the canonical
   * address — because the document is what gets saved and synced, and rewriting it would put blob URLs into
   * the note's text, where they mean nothing to any other device.
   *
   * A mutation observer is used rather than a one-off pass: ProseMirror replaces nodes as it re-renders, so a
   * rewritten image becomes a fresh, un-rewritten one the next time the paragraph is touched.
   */
  useEffect(() => {
    const element = host.current;
    if (!element || !urlForAttachment) {
      return;
    }

    let frame = 0;
    const apply = () => {
      for (const image of element.querySelectorAll<HTMLImageElement>("img[src]")) {
        const currentSrc = image.getAttribute("src") ?? "";
        const id = attachmentIdFromUrl(image.getAttribute("data-attachment-src") ?? currentSrc);
        if (id === null) {
          continue;
        }
        const resolved = urlForAttachment(id);
        if (resolved !== null && currentSrc !== resolved) {
          image.setAttribute("src", resolved);
        } else if (resolved === null && currentSrc.startsWith(ATTACHMENT_URL_PREFIX)) {
          image.setAttribute("data-attachment-src", currentSrc);
          image.setAttribute(
            "src",
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          );
        }
      }
      // A file that is not a picture is referenced as a link, and its target is the same ciphertext endpoint. It is
      // rewritten the same way, and given the name it was uploaded under so clicking it saves it as that rather than as
      // the identifier it is stored by.
      for (const link of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const id = attachmentIdFromUrl(link.getAttribute("href") ?? "");
        if (id === null) {
          continue;
        }
        const resolved = urlForAttachment(id);
        if (resolved === null) {
          continue;
        }
        if (link.getAttribute("href") !== resolved) {
          link.setAttribute("href", resolved);
        }
        const name = link.textContent?.trim() ?? "";
        if (name.length > 0 && link.getAttribute("download") !== name) {
          link.setAttribute("download", name);
        }
      }
    };

    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    apply();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [urlForAttachment, attachmentVersion]);

  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }

    let editor: Editor | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const created = await Editor.make()
          .config((ctx) => {
            ctx.set(rootCtx, element);
            ctx.set(defaultValueCtx, value);
            ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
              // `markdownUpdated` also fires for the initial document, so the guard is about
              // cancellation rather than about echoing the value back.
              if (!cancelled) {
                onChangeRef.current(markdown);
              }
            });
          })
          // Registered first: a note with an image and no title would otherwise fail to convert
          // and take the whole editor down.
          .use(missingTitleFix)
          .use(commonmark)
          .use(gfm)
          .use(listener)
          .use(inlineRenderPlugin)
          .create();

        if (cancelled) {
          await created.destroy();
          return;
        }
        editor = created;
      } catch (error) {
        // A blank pane gives the reader nothing to act on, and source mode still works.
        setFailure(error instanceof Error ? error.message : "This note could not be opened.");
      }
    })();

    return () => {
      cancelled = true;
      void editor?.destroy();
      editor = null;
    };
    // Created once per note; later external changes are not pushed into the editor (the user is
    // typing there). Switching notes remounts the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failure) {
    return (
      <p className="muted" role="status">
        This note could not be opened in the visual editor ({failure}). Switch to Markdown source to
        edit it.
      </p>
    );
  }

  return (
    <div
      className="wysiwyg-editor"
      ref={host}
      aria-label={ariaLabel ?? "WYSIWYG editor"}
      role="textbox"
    />
  );
}
