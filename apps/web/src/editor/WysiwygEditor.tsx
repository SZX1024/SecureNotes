import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { useEffect, useRef, useState } from "react";

import { inlineRenderPlugin } from "./inline-render";
import { missingTitleFix } from "./missing-titles";

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
}

export function WysiwygEditor({ value, onChange, ariaLabel }: WysiwygEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Held in a ref so a re-render cannot tear down and rebuild the editor, which would lose the
  // cursor. Assigned in an effect because writing a ref during render is what React forbids.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
