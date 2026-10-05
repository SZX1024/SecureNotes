/**
 * Single note export functions: Markdown, HTML, and Print.
 */

function sanitizeFilename(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|]/g, "_").trim();
  return clean.length > 0 ? clean : "untitled";
}

function triggerDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Exports note as a standalone .md file */
export function exportNoteAsMarkdown(title: string, body: string): void {
  const content =
    title.trim().length > 0 && !body.startsWith(`# ${title}`) ? `# ${title}\n\n${body}` : body;
  triggerDownload(content, `${sanitizeFilename(title)}.md`, "text/markdown;charset=utf-8");
}

/** Exports note as a self-contained, beautifully styled HTML document */
export function exportNoteAsHtml(title: string, renderedHtml: string): void {
  const safeTitle = title.trim().length > 0 ? title : "Untitled";
  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #1a1a1a;
      --border: #e0e0e0;
      --muted: #666666;
      --code-bg: #f4f4f4;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #181818;
        --text: #ececec;
        --border: #333333;
        --muted: #999999;
        --code-bg: #242424;
      }
    }
    body {
      max-width: 48rem;
      margin: 2rem auto;
      padding: 0 1.5rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.7;
      color: var(--text);
      background: var(--bg);
    }
    h1, h2, h3, h4 { line-height: 1.3; }
    pre {
      background: var(--code-bg);
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9em;
    }
    blockquote {
      border-left: 4px solid var(--border);
      margin: 1rem 0;
      padding-left: 1rem;
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 0.5rem 0.75rem;
      text-align: left;
    }
    img { max-width: 100%; height: auto; border-radius: 4px; }
  </style>
</head>
<body>
  <article>
    ${title.trim().length > 0 ? `<h1>${safeTitle}</h1>` : ""}
    ${renderedHtml}
  </article>
</body>
</html>`;

  triggerDownload(htmlDoc, `${sanitizeFilename(title)}.html`, "text/html;charset=utf-8");
}

/** Triggers system print dialogue with print-optimised layout in an isolated print frame */
export function printNote(title: string, renderedHtml: string): void {
  const safeTitle = title.trim().length > 0 ? title : "Untitled";
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    window.print();
    return;
  }

  doc.open();
  doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      padding: 15mm 20mm;
      line-height: 1.6;
      color: #000;
      background: #fff;
    }
    h1 {
      font-size: 22pt;
      font-weight: 700;
      border-bottom: 2pt solid #000;
      padding-bottom: 8pt;
      margin-bottom: 16pt;
    }
    h2, h3, h4, h5, h6 { page-break-after: avoid; break-after: avoid; }
    pre, blockquote, table, img { page-break-inside: avoid; break-inside: avoid; }
    pre { background: #f4f4f4; padding: 10pt; border-radius: 4pt; font-size: 9.5pt; }
    table { width: 100%; border-collapse: collapse; margin: 12pt 0; }
    th, td { border: 1px solid #ccc; padding: 6pt 8pt; text-align: left; }
    th { background: #f8f8f8; font-weight: 600; }
    blockquote { border-left: 3pt solid #888; padding-left: 8pt; color: #444; }
    img { max-width: 100%; height: auto; }
    @page { margin: 15mm 20mm; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  ${renderedHtml}
</body>
</html>`);
  doc.close();

  iframe.contentWindow?.focus();
  try {
    iframe.contentWindow?.print();
  } catch {
    window.print();
  }
  setTimeout(() => iframe.remove(), 1000);
}
