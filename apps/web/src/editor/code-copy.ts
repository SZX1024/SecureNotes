/**
 * Attaches copy buttons to code blocks inside a rendered container.
 */

export function attachCodeCopyButtons(container: HTMLElement): () => void {
  const codeBlocks = container.querySelectorAll("pre > code");
  const cleanups: Array<() => void> = [];

  for (const code of codeBlocks) {
    const pre = code.parentElement;
    if (!pre || pre.querySelector(".code-copy-btn")) {
      continue;
    }

    // Skip mermaid blocks
    if ((code.getAttribute("class") ?? "").includes("language-mermaid")) {
      continue;
    }

    // Wrap or make pre relative
    pre.style.position = "relative";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy-btn";
    button.setAttribute("aria-label", "Copy code");
    button.textContent = "Copy";

    let resetTimer: number | null = null;

    const onClick = async (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = code.textContent ?? "";
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // Fallback
          const textarea = document.createElement("textarea");
          textarea.value = text;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
        }
        button.textContent = "Copied!";
        button.classList.add("copied");

        if (resetTimer !== null) clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          button.textContent = "Copy";
          button.classList.remove("copied");
          resetTimer = null;
        }, 2000);
      } catch {
        button.textContent = "Failed";
      }
    };

    button.addEventListener("click", onClick);
    pre.appendChild(button);

    cleanups.push(() => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      button.removeEventListener("click", onClick);
      button.remove();
    });
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
