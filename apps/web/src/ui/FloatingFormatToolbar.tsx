import { useEffect, useState, useRef } from "react";

export interface FloatingFormatToolbarProps {
  editorHostRef: React.RefObject<HTMLElement | null>;
  onApplyFormat: (prefix: string, suffix?: string) => void;
}

export function FloatingFormatToolbar({
  editorHostRef,
  onApplyFormat,
}: FloatingFormatToolbarProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updatePosition = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setVisible(false);
        return;
      }

      const host = editorHostRef.current;
      if (!host) {
        setVisible(false);
        return;
      }

      const range = selection.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) {
        setVisible(false);
        return;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setVisible(false);
        return;
      }

      const top = Math.max(10, rect.top - 46);
      const left = Math.max(10, rect.left + rect.width / 2);
      setPosition({ top, left });
      setVisible(true);
    };

    document.addEventListener("selectionchange", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("selectionchange", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [editorHostRef]);

  if (!visible) return null;

  const handleAction = (e: React.MouseEvent, prefix: string, suffix = prefix) => {
    e.preventDefault();
    e.stopPropagation();
    onApplyFormat(prefix, suffix);
  };

  return (
    <div
      ref={toolbarRef}
      className="floating-format-toolbar"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
      role="toolbar"
      aria-label="Format selection"
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="format-btn"
        title="Bold (**)"
        onClick={(e) => handleAction(e, "**")}
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        className="format-btn"
        title="Italic (*)"
        onClick={(e) => handleAction(e, "*")}
      >
        <em>I</em>
      </button>
      <button
        type="button"
        className="format-btn"
        title="Inline Code (`)"
        onClick={(e) => handleAction(e, "`")}
      >
        &lt;/&gt;
      </button>
      <button
        type="button"
        className="format-btn"
        title="Strikethrough (~~)"
        onClick={(e) => handleAction(e, "~~")}
      >
        <s>S</s>
      </button>
      <button
        type="button"
        className="format-btn"
        title="Highlight (==)"
        onClick={(e) => handleAction(e, "==")}
      >
        <span style={{ background: "yellow", color: "#000", padding: "0 2px" }}>H</span>
      </button>
    </div>
  );
}
