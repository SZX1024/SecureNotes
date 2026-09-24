import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { useEffect, useRef } from "react";

import { inlineRenderPlugin } from "./inline-render";

/**
 * WYSIWYG mode (§12).
 *
 * Markdown remains the storage format: the editor is created from the note's
 * Markdown and reports Markdown back, so what is saved is never the editor's own
 * document model. That is what keeps the format stable if the editor is replaced,
 * and it is why an unknown construct survives even though no plugin understands it.
 *
 * The `gfm` preset supplies the tables and task lists §12 requires; code blocks,
 * links and images come from `commonmark`.
 *
 * This module is loaded with a dynamic `import()`: Milkdown and ProseMirror are large
 * and are not needed to show a locked note list.
 */

export interface WysiwygEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  ariaLabel?: string;
}

export function WysiwygEditor({ value, onChange, ariaLabel }: WysiwygEditorProps) {
  const host = useRef<HTMLDivElement>(null);
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
      const created = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, element);
          ctx.set(defaultValueCtx, value);
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            // `markdownUpdated` also fires for the initial document, so the guard is
            // about cancellation rather than about echoing the value back.
            if (!cancelled) {
              onChangeRef.current(markdown);
            }
          });
        })
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
    })();

    return () => {
      cancelled = true;
      void editor?.destroy();
      editor = null;
    };
    // Created once per note; later external changes are not pushed into the editor
    // (the user is typing there). Switching notes remounts the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="wysiwyg-editor"
      ref={host}
      aria-label={ariaLabel ?? "WYSIWYG editor"}
      role="textbox"
    />
  );
}
