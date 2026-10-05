/**
 * The icon set (§22).
 *
 * One module re-exports what the interface uses, so the library underneath is a single decision rather than one
 * spread across every component: swapping it, or replacing it with a handful of inline paths, is a change here and
 * nowhere else.
 *
 * The names are ours rather than the library's — `iconFor.newNote`, not `FilePlus` — because the interface asks for
 * meaning and the library supplies a drawing. It also means a rename in the library cannot ripple through the app.
 */

import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Cloud,
  CloudOff,
  Code,
  Command,
  Download,
  Eye,
  FilePlus,
  Folder,
  FolderPlus,
  KeyRound,
  Loader,
  Menu,
  Monitor,
  Moon,
  NotebookText,
  Paperclip,
  Maximize2,
  Minimize2,
  PanelLeft,
  Pencil,
  PenLine,
  Plus,
  Presentation,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Tag,
  TriangleAlert,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

/** Icons are drawn on a 24-unit grid; these are the sizes the interface uses. */
export const ICON_SIZES = { small: 14, default: 16, large: 20 } as const;

/**
 * The stroke width.
 *
 * Slightly below the library's default: the interface is dense and 13px type, where a heavier stroke reads as noise
 * rather than as emphasis.
 */
export const ICON_STROKE = 1.75;

export interface IconProps {
  size?: number;
  className?: string;
  /** Set when the icon is the only content of a control and its meaning is not already in the text. */
  label?: string;
}

export const icons = {
  newNote: FilePlus,
  allNotes: NotebookText,
  recycleBin: Trash2,
  folder: Folder,
  newFolder: FolderPlus,
  tag: Tag,
  rename: Pencil,
  remove: X,
  add: Plus,
  expand: ChevronRight,
  collapse: ChevronDown,
  search: Search,
  command: Command,
  sync: RefreshCw,
  online: Cloud,
  offline: CloudOff,
  conflict: CircleAlert,
  warning: TriangleAlert,
  check: Check,
  busy: Loader,
  export: Download,
  import: Upload,
  recovery: KeyRound,
  security: ShieldCheck,
  settings: Settings,
  appearance: Monitor,
  light: Sun,
  dark: Moon,
  sort: ArrowDownUp,
  source: Code,
  preview: Eye,
  wysiwyg: PenLine,
  save: Save,
  attachments: Paperclip,
  sidebar: PanelLeft,
  menu: Menu,
  help: CircleHelp,
  presentation: Presentation,
  maximize: Maximize2,
  minimize: Minimize2,
  prev: ChevronLeft,
  next: ChevronRight,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;
