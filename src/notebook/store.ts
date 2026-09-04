/**
 * The notebook, in memory.
 *
 * One notebook covers the whole library, divided into a page per document.
 * Rust owns the files; this owns the shape of an entry and the rules for
 * ordering them. Writes are debounced per document, because typing a note is
 * a keystroke-per-write affair and only one document's page needs to move.
 */
import { notebookLoad, notebookSaveDoc, type NotebookDocFile } from "../api";
import type { EntryColor, NotebookEntry, NotebookKind } from "../types";
import { debounce, uid } from "../util";

export interface NewEntry {
  kind: NotebookKind;
  page: string;
  ratio: number;
  /** Highlights and bookmarks reuse the id they already have in reading state. */
  id?: string;
  note?: string;
  color?: EntryColor;
  y?: number;
  docHeight?: number;
  quote?: string;
  label?: string;
  imageW?: number;
  imageH?: number;
  createdAt?: number;
  /** Adopting an existing annotation keeps its own stamp, so that merely
      opening a document does not look like an edit to every other device. */
  updatedAt?: number;
}

const DEFAULT_COLOR: Record<NotebookKind, EntryColor> = {
  highlight: "amber",
  bookmark: "crimson",
  snapshot: "sky",
  note: "ink",
};

/** Document order: by page, then by where in the page the entry sits. */
export function compareEntries(a: NotebookEntry, b: NotebookEntry): number {
  return (
    a.page.localeCompare(b.page) || a.ratio - b.ratio || a.createdAt - b.createdAt
  );
}

export class NotebookStore {
  private pages = new Map<string, NotebookDocFile>();
  private pending = new Set<string>();
  private disposed = false;
  private readonly flushSoon = debounce(() => this.writePending(), 700);

  private constructor(pages: NotebookDocFile[]) {
    for (const page of pages) this.pages.set(page.docId, normalize(page));
  }

  static async open(): Promise<NotebookStore> {
    let pages: NotebookDocFile[] = [];
    try {
      pages = await notebookLoad();
    } catch (e) {
      console.error("could not read the notebook", e);
    }
    return new NotebookStore(pages);
  }

  /** Every document the notebook holds something for, newest activity first. */
  sections(): NotebookDocFile[] {
    return [...this.pages.values()]
      .filter((p) => p.entries.some((e) => !e.deleted))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The page for a document, created on demand. */
  page(docId: string, meta?: { title: string; sourceUrl: string }): NotebookDocFile {
    let page = this.pages.get(docId);
    if (!page) {
      page = {
        docId,
        title: meta?.title ?? "",
        sourceUrl: meta?.sourceUrl ?? "",
        collapsed: false,
        updatedAt: Date.now(),
        entries: [],
      };
      this.pages.set(docId, page);
    } else if (meta && (page.title !== meta.title || page.sourceUrl !== meta.sourceUrl)) {
      // A renamed document should read as itself in the notebook too.
      page.title = meta.title;
      page.sourceUrl = meta.sourceUrl;
      this.touch(docId);
    }
    return page;
  }

  /** A document's live entries, in document order. Tombstones are hidden. */
  entries(docId: string): NotebookEntry[] {
    const page = this.pages.get(docId);
    if (!page) return [];
    return page.entries.filter((e) => !e.deleted).sort(compareEntries);
  }

  entry(docId: string, id: string): NotebookEntry | undefined {
    return this.pages.get(docId)?.entries.find((e) => e.id === id && !e.deleted);
  }

  add(docId: string, spec: NewEntry): NotebookEntry {
    const now = Date.now();
    const entry: NotebookEntry = {
      id: spec.id ?? uid(),
      kind: spec.kind,
      createdAt: spec.createdAt ?? now,
      updatedAt: spec.updatedAt ?? now,
      note: spec.note ?? "",
      color: spec.color ?? DEFAULT_COLOR[spec.kind],
      page: spec.page,
      ratio: spec.ratio,
      y: spec.y,
      docHeight: spec.docHeight,
      quote: spec.quote,
      label: spec.label,
      imageW: spec.imageW,
      imageH: spec.imageH,
    };
    const page = this.page(docId);
    const at = page.entries.findIndex((e) => e.id === entry.id);
    if (at >= 0) page.entries[at] = entry;
    else page.entries.push(entry);
    this.touch(docId);
    return entry;
  }

  /**
   * Applies an edit to one entry. An edit that changes nothing is not an
   * edit: it would stamp the entry, dirty the page and give every other
   * device something to merge, all for opening a document.
   */
  update(docId: string, id: string, change: Partial<NotebookEntry>): boolean {
    const entry = this.entry(docId, id);
    if (!entry) return false;
    const keys = Object.keys(change) as Array<keyof NotebookEntry>;
    if (keys.every((key) => entry[key] === change[key])) return true;
    Object.assign(entry, change, { updatedAt: Date.now() });
    this.touch(docId);
    return true;
  }

  /**
   * Deletes an entry, leaving a tombstone. Without one the entry would come
   * straight back from another device on the next sync.
   */
  remove(docId: string, id: string): void {
    const page = this.pages.get(docId);
    if (!page) return;
    const at = page.entries.findIndex((e) => e.id === id);
    if (at < 0) return;
    page.entries[at] = {
      ...page.entries[at],
      deleted: true,
      note: "",
      quote: undefined,
      updatedAt: Date.now(),
    };
    this.touch(docId);
  }

  /** True when this entry was deleted here or on another device. */
  isDeleted(docId: string, id: string): boolean {
    return this.pages.get(docId)?.entries.some((e) => e.id === id && e.deleted) ?? false;
  }

  setCollapsed(docId: string, collapsed: boolean): void {
    const page = this.pages.get(docId);
    if (!page || page.collapsed === collapsed) return;
    page.collapsed = collapsed;
    this.touch(docId);
  }

  /** Moves a note to another point in the notebook — or to another document. */
  move(fromDoc: string, id: string, toDoc: string, page: string, ratio: number): void {
    const entry = this.entry(fromDoc, id);
    if (!entry) return;
    if (fromDoc === toDoc) {
      this.update(fromDoc, id, { page, ratio });
      return;
    }
    const moved: NotebookEntry = { ...entry, page, ratio, updatedAt: Date.now() };
    this.remove(fromDoc, id);
    const target = this.page(toDoc);
    target.entries.push(moved);
    this.touch(toDoc);
  }

  private touch(docId: string): void {
    const page = this.pages.get(docId);
    if (page) page.updatedAt = Date.now();
    this.pending.add(docId);
    this.flushSoon();
  }

  private writePending(): void {
    if (this.disposed) return;
    for (const docId of [...this.pending]) {
      const page = this.pages.get(docId);
      if (!page) continue;
      this.pending.delete(docId);
      void notebookSaveDoc(page).catch((e) => console.error("notebook save failed", e));
    }
  }

  /** Writes anything outstanding immediately. */
  flush(): void {
    this.flushSoon.cancel();
    this.writePending();
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }
}

/** Fills in anything an older or hand-edited notebook file left out. */
function normalize(page: NotebookDocFile): NotebookDocFile {
  return {
    ...page,
    collapsed: !!page.collapsed,
    updatedAt: page.updatedAt ?? 0,
    entries: (page.entries ?? []).map((e) => ({
      ...e,
      note: e.note ?? "",
      page: e.page ?? "/",
      ratio: typeof e.ratio === "number" ? e.ratio : 0,
      color: e.color ?? DEFAULT_COLOR[e.kind] ?? "ink",
      createdAt: e.createdAt ?? 0,
      updatedAt: e.updatedAt ?? e.createdAt ?? 0,
    })),
  };
}
