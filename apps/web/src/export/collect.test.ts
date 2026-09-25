import { describe, expect, it } from "vitest";

import {
  EXPORT_REMINDER_DAYS,
  attachmentIdsForExport,
  daysSinceExport,
  exportFileName,
  shouldRemindExport,
} from "./collect";

/**
 * Export bookkeeping (§20).
 *
 * Small rules, but each has a failure the user would feel: a reminder that never appears means a backup that
 * never happens, and one that appears every day is noise that gets ignored.
 */

const DAY = 24 * 60 * 60 * 1000;
const ID = "018f0000-0000-7000-8000-00000000000d";

describe("the backup reminder (§20)", () => {
  it("reminds a device that has never exported", () => {
    expect(shouldRemindExport(null, 1_000)).toBe(true);
  });

  it("stays quiet until the interval has passed", () => {
    const now = 100 * DAY;
    expect(shouldRemindExport(now - (EXPORT_REMINDER_DAYS - 1) * DAY, now)).toBe(false);
    expect(shouldRemindExport(now - EXPORT_REMINDER_DAYS * DAY, now)).toBe(true);
  });

  it("counts whole days since the last export", () => {
    expect(daysSinceExport(null, 5 * DAY)).toBeNull();
    expect(daysSinceExport(2 * DAY, 5 * DAY + 3_600_000)).toBe(3);
  });
});

describe("the attachment set (§20)", () => {
  it("takes the attachments the notes refer to", () => {
    const notes = [
      { id: "n1", markdown: `![a](/api/v1/attachments/${ID}/content)` },
      { id: "n2", markdown: "no attachments here" },
    ];

    expect(attachmentIdsForExport(notes)).toEqual([ID]);
  });

  it("lists an attachment once even when several notes refer to it", () => {
    const notes = [
      { id: "n1", markdown: `![a](/api/v1/attachments/${ID}/content)` },
      { id: "n2", markdown: `![again](/api/v1/attachments/${ID}/content)` },
    ];

    expect(attachmentIdsForExport(notes)).toEqual([ID]);
  });

  it("carries nothing when a note only links to a page", () => {
    // A remote image is not an attachment, and fetching it would put someone else's content in the backup.
    expect(attachmentIdsForExport([{ markdown: "![x](https://example.com/a.png)" }])).toEqual([]);
  });
});

describe("the download name (§20)", () => {
  it("sorts by time and says what it is", () => {
    const earlier = exportFileName(Date.UTC(2026, 0, 2, 3, 4, 5));
    const later = exportFileName(Date.UTC(2026, 0, 3, 3, 4, 5));

    expect(earlier).toMatch(/^securenotes-export-2026-01-02T03-04-05\.zip$/);
    // Lexical order is chronological order, which is what makes a folder of backups readable.
    expect(earlier < later).toBe(true);
  });
});
