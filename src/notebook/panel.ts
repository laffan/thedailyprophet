/**
 * The notebook sidebar.
 *
 * One panel for the whole library, divided into a collapsible section per
 * document. Highlights, bookmarks and snapshots sit in the order they occur
 * in the text and scroll the document when clicked; notes carry their own
 * position, so they can be dragged anywhere — including into another
 * document's section.
 *
 * Cards are reused across renders rather than rebuilt, because each one owns
 * a live markdown editor that a rebuild would throw away mid-sentence.
 */
import {
  ENTRY_COLORS,
  HIGHLIGHT_COLORS,
  type EntryColor,
  type HighlightColor,
  type NotebookEntry,
} from "../types";
import { el } from "../util";
import { notebookSnapshot } from "../api";
import type { NoteEditor } from "./editor";

/**
 * CodeMirror is most of this app's JavaScript, and the shelf never needs it.
 * It arrives the first time a note is shown.
 */
let editorModule: typeof import("./editor") | null = null;
async function loadEditor(): Promise<typeof import("./editor")> {
  editorModule ??= await import("./editor");
  return editorModule;
}
import type { NotebookStore } from "./store";

export interface NotebookHost {
  /** The document being read; its section leads the panel. */
  docId: string;
  title: string;
  sourceUrl: string;
  /** Scrolls to an entry, opening its document first when it is another one. */
  jump: (entry: NotebookEntry, docId: string) => void;
  /** Lets go of whatever the entry stood for: a mark, an anchor, a PNG. */
  onDelete: (entry: NotebookEntry, docId: string) => void;
  /** Repaints a bookmark's arrow in the document. */
  recolor: (entry: NotebookEntry, color: EntryColor, docId: string) => void;
  highlightColor: (id: string) => HighlightColor | null;
  setHighlightColor: (id: string, color: HighlightColor) => void;
  addBookmark: () => void;
  startSnapshot: () => void;
  addNote: () => void;
}

interface Card {
  root: HTMLElement;
  update: (entry: NotebookEntry, docId: string, where: string | null) => void;
  destroy: () => void;
}

interface Section {
  root: HTMLElement;
  head: HTMLElement;
  caret: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
}

/** Snapshot PNGs are read once and kept for the life of the panel. */
const snapshotCache = new Map<string, string | null>();

export class NotebookPanel {
  readonly root = el("aside.notebook");
  private readonly body = el("div.nb-body");
  private readonly countLabel = el("span.nb-count");
  private readonly cards = new Map<string, Card>();
  private readonly sections = new Map<string, Section>();
  private readonly insertLine = el("div.nb-insert", { hidden: true });
  /** The note being dragged, and where it came from. */
  private dragging: { docId: string; id: string } | null = null;
  private dropAt: { docId: string; index: number } | null = null;
  /** A freshly made note asks for the cursor as soon as its card exists. */
  pendingFocus: string | null = null;

  constructor(
    private readonly store: NotebookStore,
    private readonly host: NotebookHost,
  ) {
    this.root.append(
      el(
        "header.nb-head",
        null,
        el("span.nb-heading", null, "Notebook"),
        this.countLabel,
      ),
      this.body,
      el(
        "footer.nb-actions",
        null,
        el(
          "button.btn.btn-ghost.btn-small",
          { title: "Mark this place", onclick: () => this.host.addBookmark() },
          "Bookmark",
        ),
        el(
          "button.btn.btn-ghost.btn-small",
          { title: "Drag a region of the page", onclick: () => this.host.startSnapshot() },
          "Snapshot",
        ),
        el(
          "button.btn.btn-ghost.btn-small",
          { title: "A markdown note", onclick: () => this.host.addNote() },
          "Note",
        ),
      ),
    );
    this.body.append(this.insertLine);
  }

  render(): void {
    const order = this.sectionOrder();
    const total = order.reduce((n, docId) => n + this.store.entries(docId).length, 0);
    this.countLabel.textContent = total ? `${total} entr${total === 1 ? "y" : "ies"}` : "empty";

    const live = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const docId of order) {
      const section = this.section(docId);
      this.renderSection(docId, section, live);
      nodes.push(section.root);
    }
    reconcile(this.body, [...nodes, this.insertLine]);

    for (const [docId, section] of this.sections) {
      if (!order.includes(docId)) {
        section.root.remove();
        this.sections.delete(docId);
      }
    }
    for (const [id, card] of this.cards) {
      if (!live.has(id)) {
        card.destroy();
        card.root.remove();
        this.cards.delete(id);
      }
    }
  }

  /** Brings an entry into view and flashes it — used when its marker is clicked. */
  reveal(id: string): void {
    const docId = this.host.docId;
    if (this.store.entry(docId, id)) this.store.setCollapsed(docId, false);
    this.render();
    const card = this.cards.get(id);
    if (!card) return;
    card.root.scrollIntoView({ block: "center", behavior: "smooth" });
    card.root.classList.add("is-flashing");
    setTimeout(() => card.root.classList.remove("is-flashing"), 1200);
  }

  dispose(): void {
    for (const card of this.cards.values()) card.destroy();
    this.cards.clear();
  }

  // ---- sections ----------------------------------------------------------

  /** The document being read leads; the rest follow by recent activity. */
  private sectionOrder(): string[] {
    const rest = this.store
      .sections()
      .map((s) => s.docId)
      .filter((docId) => docId !== this.host.docId);
    return [this.host.docId, ...rest];
  }

  private section(docId: string): Section {
    const existing = this.sections.get(docId);
    if (existing) return existing;
    const caret = el("span.nb-caret", null, "▸");
    const name = el("span.nb-section-name");
    const count = el("span.nb-section-count");
    const head = el(
      "button.nb-section-head",
      {
        onclick: () => {
          const page = this.store.page(docId);
          this.store.setCollapsed(docId, !page.collapsed);
          this.render();
        },
      },
      caret,
      name,
      count,
    );
    const list = el("div.nb-entries");
    const empty = el("p.muted.nb-section-empty");
    const root = el("section.nb-section", { dataset: { docId } }, head, list);
    const section: Section = { root, head, caret, name, count, list, empty };
    this.sections.set(docId, section);
    return section;
  }

  private renderSection(docId: string, section: Section, live: Set<string>): void {
    const isCurrent = docId === this.host.docId;
    const page = isCurrent
      ? this.store.page(docId, { title: this.host.title, sourceUrl: this.host.sourceUrl })
      : this.store.page(docId);
    const entries = this.store.entries(docId);
    const collapsed = page.collapsed;

    section.root.classList.toggle("is-current", isCurrent);
    section.root.classList.toggle("is-collapsed", collapsed);
    section.caret.textContent = collapsed ? "▸" : "▾";
    section.name.textContent = page.title || "Untitled document";
    section.count.textContent = String(entries.length);
    section.head.title = page.sourceUrl;

    if (collapsed) {
      section.list.remove();
      return;
    }
    if (!section.list.parentNode) section.root.append(section.list);

    // Which page an entry is on is only worth saying when there is more
    // than one — and a legacy snapshot has no real path to name.
    const mainPath = pathOf(page.sourceUrl);
    const multiPage = new Set(entries.map((e) => e.page)).size > 1;
    const nodes: HTMLElement[] = [];
    for (const entry of entries) {
      live.add(entry.id);
      const card = this.card(entry.id);
      card.update(entry, docId, multiPage ? pageLabel(entry.page, mainPath) : null);
      nodes.push(card.root);
    }
    if (!entries.length) {
      section.empty.textContent = isCurrent
        ? "Nothing yet. Highlight some text, or use the buttons below."
        : "Nothing left in this section.";
      nodes.push(section.empty);
    } else {
      section.empty.remove();
    }
    reconcile(section.list, nodes);
  }

  // ---- cards -------------------------------------------------------------

  private card(id: string): Card {
    const existing = this.cards.get(id);
    if (existing) return existing;
    const card = this.buildCard();
    this.cards.set(id, card);
    return card;
  }

  private buildCard(): Card {
    let entry: NotebookEntry | null = null;
    let docId = "";
    let editor: NoteEditor | null = null;
    /** Set by "＋ note": an empty editor the reader asked for stays open. */
    let noteWanted = false;

    const spine = el("span.nb-spine");
    const kindIcon = el("span.nb-kind");
    const title = el("span.nb-card-title");
    const meta = el("span.nb-card-meta");
    const figure = el("img.nb-shot", { hidden: true, alt: "Snapshot" }) as HTMLImageElement;
    const jump = el(
      "button.nb-card-jump",
      {
        onclick: () => {
          if (entry) this.host.jump(entry, docId);
        },
      },
      el("span.nb-card-head", null, kindIcon, meta),
      title,
      figure,
    ) as HTMLButtonElement;

    const grip = el("span.nb-grip", { title: "Drag to move this note" }, "⠿");
    grip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (entry) this.beginDrag(e, entry.id, docId, root);
    });

    const noteHost = el("div.nb-note", { hidden: true });

    let mounting = false;
    const mountEditor = (focus: boolean): void => {
      noteHost.hidden = false;
      noteBtn.hidden = true;
      if (editor) {
        if (focus) editor.focus();
        return;
      }
      if (mounting || !entry) return;
      mounting = true;
      const kind = entry.kind;
      const initial = entry.note;
      void loadEditor().then(({ noteEditor }) => {
        mounting = false;
        if (editor || !entry) return;
        editor = noteEditor({
          value: initial,
          hint: kind === "note" ? "Write a note in markdown…" : "Add a note…",
          onChange: (value) => {
            if (entry) this.store.update(docId, entry.id, { note: value });
          },
          onBlur: () => {
            // A note nobody wrote leaves no card behind.
            if (kind !== "note" && !editor?.value().trim()) {
              noteWanted = false;
              noteHost.hidden = true;
              noteBtn.hidden = false;
            }
          },
        });
        noteHost.append(editor.dom);
        if (focus) editor.focus();
      });
    };

    const swatches = el("span.nb-swatches");
    const noteBtn = el(
      "button.nb-tool",
      {
        title: "Add a note",
        onclick: () => {
          noteWanted = true;
          mountEditor(true);
        },
      },
      "＋ note",
    );
    const del = el(
      "button.nb-tool.nb-delete",
      {
        title: "Delete",
        onclick: () => {
          if (!entry) return;
          this.host.onDelete(entry, docId);
          this.store.remove(docId, entry.id);
          this.render();
        },
      },
      "Delete",
    );
    const tools = el("div.nb-card-tools", null, swatches, el("span.nb-tool-spacer"), noteBtn, del);
    const root = el(
      "article.nb-card",
      null,
      spine,
      el("div.nb-card-body", null, jump, noteHost, tools),
      grip,
    );

    const update = (next: NotebookEntry, nextDoc: string, where: string | null): void => {
      entry = next;
      docId = nextDoc;
      root.dataset.kind = next.kind;
      root.dataset.id = next.id;
      const accent =
        next.kind === "highlight"
          ? HIGHLIGHT_COLORS[this.host.highlightColor(next.id) ?? "sun"]
          : (ENTRY_COLORS[next.color] ?? ENTRY_COLORS.ink);
      spine.style.backgroundColor = accent;
      root.style.setProperty("--entry-color", accent);

      kindIcon.textContent = KIND_LABEL[next.kind];
      meta.textContent = `${where ? `${where} · ` : ""}${Math.round(next.ratio * 100)}%`;
      meta.hidden = next.kind === "note";
      title.textContent =
        next.kind === "highlight"
          ? clip(next.quote ?? "", 220)
          : next.kind === "bookmark"
            ? next.label || `At ${Math.round(next.ratio * 100)}%`
            : "";
      title.hidden = !title.textContent;
      jump.disabled = next.kind === "note";
      grip.hidden = next.kind !== "note";

      if (next.kind === "snapshot") this.showSnapshot(next, figure);
      else figure.hidden = true;

      this.renderSwatches(swatches, next, nextDoc);

      // A note is nothing but its markdown, so its editor is always there.
      // The others earn one once they have something to say.
      if (next.kind === "note" || next.note.trim() || noteWanted) {
        // Only the card that was asked for takes the cursor; the others
        // must not swallow the request on their way past.
        const focus = this.pendingFocus === next.id;
        if (focus) this.pendingFocus = null;
        mountEditor(focus);
      } else {
        noteHost.hidden = true;
        noteBtn.hidden = false;
      }
    };

    return {
      root,
      update,
      destroy: () => editor?.destroy(),
    };
  }

  private renderSwatches(host: HTMLElement, entry: NotebookEntry, docId: string): void {
    const isHighlight = entry.kind === "highlight";
    const palette: Record<string, string> = isHighlight ? HIGHLIGHT_COLORS : ENTRY_COLORS;
    const current = isHighlight
      ? (this.host.highlightColor(entry.id) ?? "sun")
      : entry.color;
    const names = Object.keys(palette);
    if (host.childElementCount !== names.length) {
      host.innerHTML = "";
      for (const name of names) {
        const dot = el("button.nb-swatch", {
          dataset: { color: name },
          title: name,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            const target = host.dataset.entryId;
            const doc = host.dataset.docId ?? "";
            if (!target) return;
            if (isHighlight) {
              this.host.setHighlightColor(target, name as HighlightColor);
            } else {
              this.store.update(doc, target, { color: name as EntryColor });
              const updated = this.store.entry(doc, target);
              if (updated) this.host.recolor(updated, name as EntryColor, doc);
            }
            this.render();
          },
        });
        dot.style.backgroundColor = palette[name];
        host.append(dot);
      }
    }
    host.dataset.entryId = entry.id;
    host.dataset.docId = docId;
    host.querySelectorAll<HTMLElement>(".nb-swatch").forEach((dot) => {
      dot.classList.toggle("is-current", dot.dataset.color === current);
    });
  }

  private showSnapshot(entry: NotebookEntry, img: HTMLImageElement): void {
    if (img.dataset.entryId === entry.id && img.src) {
      img.hidden = false;
      return;
    }
    img.dataset.entryId = entry.id;
    if (entry.imageW && entry.imageH) {
      img.width = entry.imageW;
      img.height = entry.imageH;
    }
    const cached = snapshotCache.get(entry.id);
    if (cached !== undefined) {
      if (cached) {
        img.src = cached;
        img.hidden = false;
      }
      return;
    }
    void notebookSnapshot(entry.id)
      .then((uri) => {
        snapshotCache.set(entry.id, uri);
        if (uri && img.dataset.entryId === entry.id) {
          img.src = uri;
          img.hidden = false;
        }
      })
      .catch(() => snapshotCache.set(entry.id, null));
  }

  // ---- dragging notes ----------------------------------------------------
  //
  // Pointer events rather than HTML5 drag and drop: this app reads on an
  // iPad too, and a touch never produces a dragstart.

  private beginDrag(e: PointerEvent, id: string, docId: string, card: HTMLElement): void {
    e.preventDefault();
    this.dragging = { docId, id };
    card.classList.add("is-dragging");
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is a convenience, not a requirement */
    }

    const onMove = (ev: PointerEvent) => {
      ev.preventDefault();
      this.trackDrag(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      card.classList.remove("is-dragging");
      this.trackDrag(ev.clientX, ev.clientY);
      this.commitDrag();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  /** Works out where the note would land, and shows the line that says so. */
  private trackDrag(x: number, y: number): void {
    if (!this.dragging) return;
    this.autoScroll(y);
    const under = document.elementFromPoint(x, y);
    const sectionEl = under?.closest<HTMLElement>(".nb-section");
    const docId = sectionEl?.dataset.docId;
    const list = docId ? this.sections.get(docId)?.list : null;
    if (!docId || !list || !list.isConnected) {
      this.hideInsertLine();
      return;
    }
    const cards = [...list.querySelectorAll<HTMLElement>(".nb-card")];
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    this.dropAt = { docId, index };
    const bodyRect = this.body.getBoundingClientRect();
    const at = cards[index];
    const edge = at
      ? at.getBoundingClientRect().top
      : (cards[cards.length - 1]?.getBoundingClientRect().bottom ??
        list.getBoundingClientRect().top);
    this.insertLine.hidden = false;
    this.insertLine.style.top = `${edge - bodyRect.top + this.body.scrollTop}px`;
  }

  /** Dragging past either end of the panel scrolls it. */
  private autoScroll(y: number): void {
    const rect = this.body.getBoundingClientRect();
    const margin = 48;
    if (y < rect.top + margin) this.body.scrollTop -= 12;
    else if (y > rect.bottom - margin) this.body.scrollTop += 12;
  }

  private commitDrag(): void {
    const drag = this.dragging;
    const target = this.dropAt;
    this.dragging = null;
    this.hideInsertLine();
    if (!drag || !target) return;

    const siblings = this.store
      .entries(target.docId)
      .filter((entry) => !(drag.docId === target.docId && entry.id === drag.id));
    const index = Math.min(target.index, siblings.length);
    const before = siblings[index - 1];
    const after = siblings[index];
    const page = after?.page ?? before?.page ?? "/";
    let ratio: number;
    if (before && after && before.page === after.page) ratio = (before.ratio + after.ratio) / 2;
    else if (after) ratio = after.ratio - 0.001;
    else if (before) ratio = before.ratio + 0.001;
    else ratio = 0;

    this.store.move(drag.docId, drag.id, target.docId, page, ratio);
    this.render();
  }

  private hideInsertLine(): void {
    this.insertLine.hidden = true;
    this.dropAt = null;
  }
}

const KIND_LABEL: Record<NotebookEntry["kind"], string> = {
  highlight: "Highlight",
  bookmark: "Bookmark",
  snapshot: "Snapshot",
  note: "Note",
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function pathOf(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl);
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

/** Which page of a multi-page document an entry sits on, if not the first. */
function pageLabel(page: string, mainPath: string): string | null {
  if (!page || page === mainPath || page === "/") return null;
  const tail = page.split("?")[0].split("/").filter(Boolean).pop();
  return tail ? decodeURIComponent(tail).replace(/[-_]+/g, " ").slice(0, 22) : null;
}

/**
 * Puts `nodes` in order inside `container`, moving only what is out of place.
 * Re-appending everything would work, but moving a node that holds a focused
 * editor loses the cursor mid-keystroke.
 */
function reconcile(container: HTMLElement, nodes: HTMLElement[]): void {
  let cursor: ChildNode | null = container.firstChild;
  for (const node of nodes) {
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    container.insertBefore(node, cursor);
  }
  while (cursor) {
    const next: ChildNode | null = cursor.nextSibling;
    container.removeChild(cursor);
    cursor = next;
  }
}
