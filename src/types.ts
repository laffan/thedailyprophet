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
}

export interface Bookmark {
  id: string;
  label: string;
  y: number;
  ratio: number;
  docHeight: number;
  createdAt: number;
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
