import type { IconName } from "./icons";

/**
 * The side panel's views (§22).
 *
 * Kept beside the component rather than inside it because a module that exports both a component and values cannot
 * be hot-reloaded, and because this list is data: it is what the tests and the shell both read.
 */

export type PanelView = "notes" | "folders" | "tags" | "sync";

export interface ActivityBarItem {
  view: PanelView;
  icon: IconName;
  label: string;
}

export const ACTIVITY_ITEMS: readonly ActivityBarItem[] = [
  { view: "notes", icon: "allNotes", label: "Notes" },
  { view: "folders", icon: "folder", label: "Folders" },
  { view: "tags", icon: "tag", label: "Tags" },
  { view: "sync", icon: "sync", label: "Sync and backup" },
];

/** What the panel calls each of its views. */
export const VIEW_LABELS: Record<PanelView, string> = {
  notes: "Notes",
  folders: "Folders",
  tags: "Tags",
  sync: "Sync and backup",
};
