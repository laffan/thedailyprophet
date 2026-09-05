/** Metadata stored alongside every snapshot in the library (meta.json). */
export interface DocMeta {
  id: string;
  title: string;
  sourceUrl: string;
  author: string | null;
  excerpt: string | null;
  createdAt: number; // unix ms
  sizeBytes: number;
  cover: string | null; // cover file name inside the document dir
  scripts: boolean; // whether page scripts were kept in the snapshot
  /** 1 = legacy single-file snapshot; 2 = resource-map archive (prophet://). */
  format: number;
}

/** Reading state (state.json). Owned entirely by the frontend; Rust treats it as opaque JSON. */
export interface PagePosition {
  scrollY: number;
  scrollRatio: number;
  docHeight: number;
}

export interface DocState {
  scrollY: number;
  scrollRatio: number;
  docHeight: number;
  progress: number; // 0..1, current position
  lastOpenedAt: number;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  /** Per-page positions for multi-page documents, keyed by path. */
  pages?: Record<string, PagePosition>;
  /** Path of the page last being read. */
  lastPage?: string;
  /** Held at the top of the shelf. Lives here so it follows a device sync. */
  pinned?: boolean;
}

export interface Bookmark {
  id: string;
  label: string;
  y: number;
  ratio: number;
  docHeight: number;
  createdAt: number;
  /** Last moved at. A bookmark can be dragged, and sync needs to know when. */
  updatedAt?: number;
  /** Page path for multi-page documents. */
  page?: string;
}

export type HighlightColor = "sun" | "rose" | "mint" | "sky";

/**
 * Highlights are anchored by text quote (exact match plus surrounding
 * context), which survives DOM re-renders inside interactive snapshots.
 */
export interface Highlight {
  id: string;
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  createdAt: number;
  orphaned?: boolean; // set when the quote could not be re-anchored
  /** Page path for multi-page documents. */
  page?: string;
}

export interface DocSummary {
  meta: DocMeta;
  state: DocState | null;
  coverDataUri: string | null;
}

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  sun: "#f5d663",
  rose: "#f4a9b8",
  mint: "#a8dcc4",
  sky: "#a9cbee",
};

export function emptyState(): DocState {
  return {
    scrollY: 0,
    scrollRatio: 0,
    docHeight: 0,
    progress: 0,
    lastOpenedAt: 0,
    bookmarks: [],
    highlights: [],
  };
}

// ---- the reading notebook -------------------------------------------------

export type NotebookKind = "highlight" | "bookmark" | "snapshot" | "note";

/** One palette for bookmark arrows, snapshot frames and note cards. */
export type EntryColor = "crimson" | "amber" | "olive" | "sky" | "violet" | "ink";

export const ENTRY_COLORS: Record<EntryColor, string> = {
  crimson: "#b8362a",
  amber: "#c3892c",
  olive: "#5f7a3a",
  sky: "#35719c",
  violet: "#74508f",
  ink: "#6b6152",
};

/**
 * A single thing in the notebook.
 *
 * Highlights and bookmarks stay anchored in the document's reading state —
 * that is what survives re-renders and what annotation export reads — and the
 * notebook carries their note, their colour and a copy of their text, so a
 * notebook file makes sense on its own. Snapshots and notes live here only.
 */
export interface NotebookEntry {
  id: string;
  kind: NotebookKind;
  createdAt: number;
  updatedAt: number;
  /** A tombstone, kept so that a deletion survives folder sync. */
  deleted?: boolean;
  /** Markdown: the card's body for a note, the attached note for the rest. */
  note: string;
  color: EntryColor;
  /** Page path inside a multi-page document. */
  page: string;
  /**
   * Where the entry sits, as a fraction of the scrollable height. Highlights,
   * bookmarks and snapshots take it from the text; a note takes it from
   * wherever it was dragged, which is what keeps one ordering for all four.
   */
  ratio: number;
  /** Absolute offset and the height it was measured against (as bookmarks). */
  y?: number;
  docHeight?: number;
  /** The highlighted text, for a highlight. */
  quote?: string;
  /**
   * A highlight's colour in the document. Mirrored here (like the quote)
   * so that a notebook — and the colour filter — makes sense for documents
   * whose reading state is not loaded.
   */
  highlightColor?: HighlightColor;
  /** The heading a bookmark was dropped under, or the name given to it. */
  label?: string;
  /** Set once a bookmark is named by hand, so moving it keeps that name. */
  renamed?: boolean;
  /** Pixel size of a snapshot's PNG, so the card can reserve its space. */
  imageW?: number;
  imageH?: number;
}
