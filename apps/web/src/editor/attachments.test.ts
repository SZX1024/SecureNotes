import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_URL_PREFIX,
  attachmentMarkdown,
  attachmentRefsIn,
  diffAttachmentRefs,
  isImageFilename,
} from "./attachments";

/**
 * Attachment references (§12).
 *
 * The diff decides which attachments gain or lose a reference, and losing the last
 * one schedules the object for deletion — so an error here either destroys an image
 * still in use or keeps one alive forever.
 */

const A = "01a0d408-aa64-78e4-8f51-df73b8b0747f";
const B = "01a0d409-df28-7000-8000-000000000001";

const ref = (id: string) => `![shot](${ATTACHMENT_URL_PREFIX}${id}/content)`;

describe("reading references", () => {
  it("finds the ids referenced by a note", () => {
    expect(attachmentRefsIn(`text\n\n${ref(A)}\n\nmore\n\n${ref(B)}`)).toEqual([A, B]);
  });

  it("reports an id once however often it appears", () => {
    expect(attachmentRefsIn(`${ref(A)} and again ${ref(A)}`)).toEqual([A]);
  });

  it("finds nothing in a note without attachments", () => {
    expect(attachmentRefsIn("# Title\n\nJust text.")).toEqual([]);
    // An external image is not an attachment and must not be counted as one.
    expect(attachmentRefsIn("![x](https://example.com/i.png)")).toEqual([]);
  });

  it("requires the internal path, not just an id", () => {
    // A bare id in prose is not a reference; deleting on the strength of it would be
    // destroying an attachment the note never used.
    expect(attachmentRefsIn(`the id ${A} appears in text`)).toEqual([]);
  });
});

describe("building a reference", () => {
  it("uses the internal id, not the filename", () => {
    const markdown = attachmentMarkdown(A, "holiday photo.png");

    expect(markdown).toContain(`${ATTACHMENT_URL_PREFIX}${A}/content`);
    expect(markdown).toContain("holiday photo.png");
    // The filename is the alt text only: it never becomes the reference.
    expect(markdown).not.toContain("](holiday");
  });

  it("cannot break out of the alt text", () => {
    // Brackets are removed rather than escaped, so the alt text cannot close early.
    expect(attachmentMarkdown(A, "a]b[c.png", "image/png")).toContain("![abc.png]");
    expect(attachmentMarkdown(A, "a]b[c.zip", "application/zip")).toContain("[abc.zip]");
  });

  it("embeds a picture and links to anything else", () => {
    // A document inside an <img> is a broken picture in the note; the reference has to be the syntax that fits.
    expect(attachmentMarkdown(A, "shot.png", "image/png")).toContain("![shot.png]");
    expect(attachmentMarkdown(A, "archive.zip", "application/zip")).toContain("[archive.zip]");
    expect(attachmentMarkdown(A, "archive.zip", "application/zip")).not.toContain("![");
    // An unknown type is not an image, so it is a link.
    expect(attachmentMarkdown(A, "mystery", "")).toContain("[mystery]");
  });
});

describe("diffing references (§12 reference counting)", () => {
  it("reports added and removed ids", () => {
    expect(diffAttachmentRefs([A], [B])).toEqual({ added: [B], removed: [A] });
  });

  it("reports nothing when a reference was only moved", () => {
    expect(diffAttachmentRefs([A, B], [B, A])).toEqual({ added: [], removed: [] });
  });

  it("reports a removal when the last reference goes", () => {
    expect(diffAttachmentRefs([A], [])).toEqual({ added: [], removed: [A] });
  });

  it("reports nothing when an image is inserted twice", () => {
    // Adding the same attachment twice must not count as two new references.
    expect(diffAttachmentRefs([A], [A, A])).toEqual({ added: [], removed: [] });
  });
});

describe("image filenames", () => {
  it("recognises the formats the product accepts", () => {
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.svg"]) {
      expect(isImageFilename(name), name).toBe(true);
    }
    expect(isImageFilename("a.pdf")).toBe(false);
    expect(isImageFilename("noextension")).toBe(false);
  });
});
