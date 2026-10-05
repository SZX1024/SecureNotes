import { describe, expect, it } from "vitest";
import { extractOutline } from "./outline";

describe("extractOutline", () => {
  it("extracts markdown headings with correct levels", () => {
    const md = `
# Title

Some intro text

## Section 1
Content

### Subsection 1.1
Detail

## Section 2
Final thoughts
`;
    const outline = extractOutline(md);
    expect(outline).toHaveLength(4);
    expect(outline[0]?.level).toBe(1);
    expect(outline[0]?.text).toBe("Title");
    expect(outline[1]?.level).toBe(2);
    expect(outline[1]?.text).toBe("Section 1");
    expect(outline[2]?.level).toBe(3);
    expect(outline[2]?.text).toBe("Subsection 1.1");
    expect(outline[3]?.level).toBe(2);
    expect(outline[3]?.text).toBe("Section 2");
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = `
# Real Heading

\`\`\`markdown
# Fake Heading
## Another Fake
\`\`\`

## Another Real Heading
`;
    const outline = extractOutline(md);
    expect(outline).toHaveLength(2);
    expect(outline[0]?.text).toBe("Real Heading");
    expect(outline[1]?.text).toBe("Another Real Heading");
  });
});
