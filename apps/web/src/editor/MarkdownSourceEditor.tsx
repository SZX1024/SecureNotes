import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

/**
 * Markdown source mode (§12).
 *
 * The canonical storage format is Markdown, so this editor is the one that shows
 * exactly what is stored — which is also what makes it the place to verify that an
 * unknown construct survived the WYSIWYG round trip.
 *
 * Changes are reported on every keystroke and never written straight to storage: the
 * note document stays the single source of truth (see `App`), so a keystroke cannot
 * skip the encrypt-and-queue path.
 */

export interface MarkdownSourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
}

export function MarkdownSourceEditor({ value, onChange, ariaLabel }: MarkdownSourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Held in a ref so a re-render cannot tear down and rebuild the editor, which
  // would lose the cursor. Assigned in an effect because writing a ref during render
  // is what React forbids.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!host.current) {
      return;
    }

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
    // Mounted once per note: the document is passed in through `value` at creation
    // and afterwards the editor is the authority for its own text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An external change (switching notes, a reload from storage) replaces the whole
  // document, which has no cursor to preserve.
  useEffect(() => {
    const editor = view.current;
    if (!editor) {
      return;
    }
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      className="source-editor"
      ref={host}
      aria-label={ariaLabel ?? "Markdown source"}
      role="textbox"
    />
  );
}
