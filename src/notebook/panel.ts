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
  type NotebookKind,
} from "../types";
import { debounce, el } from "../util";
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
  /** Names a bookmark, in the notebook and in reading state alike. */
  rename: (entry: NotebookEntry, docId: string, label: string) => void;
  addBookmark: () => void;
  startSnapshot: () => void;
  addNote: () => void;
  /** Searches the open document for a phrase. */
  findInDocument: (query: string) => Promise<DocumentHit[]>;
  /** Scrolls to one of those hits and lights it up. */
  gotoDocumentHit: (index: number) => void;
}

/** One occurrence of the search text in the document being read. */
export interface DocumentHit {
  i: number;
  before: string;
  match: string;
  after: string;
  ratio: number;
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
  /**
   * What the panel is showing. Empty sets mean everything; a colour is keyed
   * by palette, since a highlight's sky and a note's sky are different inks.
   */
  private readonly filter = { kinds: new Set<NotebookKind>(), colors: new Set<string>() };
  private readonly filterBar = el("div.nb-filter");
  /** What the search field holds, and what the document made of it. */
  private query = "";
  private hits: DocumentHit[] = [];
  private readonly searchField = el("input.nb-search", {
    type: "search",
    placeholder: "Search the notebook and the page…",
    spellcheck: false,
  }) as HTMLInputElement;
  private readonly found = el("section.nb-section.nb-found");
  private readonly foundList = el("div.nb-entries");
  private readonly foundCount = el("span.nb-section-count");
  private readonly noMatches = el("p.muted.nb-section-empty");

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
      // Outside the scroller, so they stay put however far down you are.
      el("div.nb-search-row", null, this.searchField),
      this.filterBar,
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

    const run = debounce(() => void this.search(this.searchField.value), 220);
    this.searchField.addEventListener("input", run);
    this.searchField.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this.searchField.value = "";
      run.cancel();
      void this.search("");
    });
    this.found.append(
      el("div.nb-section-head.nb-found-head", null, el("span.nb-section-name", null, "In this page"), this.foundCount),
      this.foundList,
    );
  }

  /** Runs a query against the notebook and the document at the same time. */
  private async search(raw: string): Promise<void> {
    const query = raw.trim();
    if (query === this.query) return;
    this.query = query;
    this.hits = [];
    this.render();
    if (query.length < 2) {
      this.host.gotoDocumentHit(-1);
      return;
    }
    let hits: DocumentHit[] = [];
    try {
      hits = await this.host.findInDocument(query);
    } catch {
      hits = []; // the page did not answer; the notebook results still stand
    }
    if (query !== this.query) return; // a later keystroke won the race
    this.hits = hits;
    this.render();
  }

  render(): void {
    const order = this.sectionOrder();
    let total = 0;
    let shown = 0;
    for (const docId of order) {
      const entries = this.store.entries(docId);
      total += entries.length;
      shown += entries.filter((e) => this.matches(e)).length;
    }
    this.countLabel.textContent = !total
      ? "empty"
      : this.filtering()
        ? `${shown} of ${total}`
        : `${total} entr${total === 1 ? "y" : "ies"}`;
    this.renderFilter(order);

    const live = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const docId of order) {
      const section = this.section(docId);
      // A section with nothing left to show is out of the way, not empty.
      if (this.filtering() && !this.store.entries(docId).some((e) => this.matches(e))) {
        section.root.remove();
        continue;
      }
      this.renderSection(docId, section, live);
      nodes.push(section.root);
    }
    if (this.filtering() && !nodes.length) {
      this.noMatches.textContent = this.query
        ? "Nothing in the notebook matches that search."
        : "Nothing in the notebook matches that filter.";
      nodes.push(this.noMatches);
    }
    if (this.query) nodes.unshift(this.renderFound());
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

  // ---- filtering ---------------------------------------------------------

  private filtering(): boolean {
    return this.filter.kinds.size > 0 || this.filter.colors.size > 0 || this.query.length > 0;
  }

  private matches(entry: NotebookEntry): boolean {
    if (this.filter.kinds.size && !this.filter.kinds.has(entry.kind)) return false;
    if (this.filter.colors.size && !this.filter.colors.has(colorKey(entry, this.host))) {
      return false;
    }
    if (this.query) {
      const needle = this.query.toLowerCase();
      const hay = `${entry.quote ?? ""}\n${entry.label ?? ""}\n${entry.note}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }

  /**
   * Only the kinds and colours actually in the notebook get a control — a
   * filter for something you have never used is just clutter.
   */
  private renderFilter(order: string[]): void {
    const kinds = new Set<NotebookKind>();
    const inUse = new Set<string>();
    for (const docId of order) {
      for (const entry of this.store.entries(docId)) {
        kinds.add(entry.kind);
        inUse.add(colorKey(entry, this.host));
      }
    }
    // Walk the palettes, not the entries, so the dots keep their places as
    // the notebook fills up.
    const swatches: Array<{ key: string; ink: string; name: string; highlight: boolean }> = [];
    for (const name of Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]) {
      if (inUse.has(`hl:${name}`)) {
        swatches.push({ key: `hl:${name}`, ink: HIGHLIGHT_COLORS[name], name, highlight: true });
      }
    }
    for (const name of Object.keys(ENTRY_COLORS) as EntryColor[]) {
      if (inUse.has(name)) {
        swatches.push({ key: name, ink: ENTRY_COLORS[name], name, highlight: false });
      }
    }

    // A selection whose last entry has gone would hide everything.
    for (const kind of this.filter.kinds) if (!kinds.has(kind)) this.filter.kinds.delete(kind);
    for (const key of this.filter.colors) if (!inUse.has(key)) this.filter.colors.delete(key);

    this.filterBar.hidden = kinds.size < 2 && swatches.length < 2;
    this.filterBar.innerHTML = "";
    if (this.filterBar.hidden) return;

    // One kind is not a choice, so it gets no chip.
    for (const kind of kinds.size > 1 ? KIND_ORDER : []) {
      if (!kinds.has(kind)) continue;
      const on = this.filter.kinds.has(kind);
      this.filterBar.append(
        el(
          `button.nb-chip${on ? ".is-on" : ""}`,
          {
            title: `Show only ${KIND_PLURAL[kind].toLowerCase()}`,
            onclick: () => this.toggle(this.filter.kinds, kind),
          },
          KIND_PLURAL[kind],
        ),
      );
    }
    if (kinds.size > 1 && swatches.length) this.filterBar.append(el("span.nb-filter-rule"));
    for (const swatch of swatches) {
      const on = this.filter.colors.has(swatch.key);
      const dot = el(`button.nb-swatch.nb-filter-dot${on ? ".is-on" : ""}`, {
        title: `Show only ${swatch.name}${swatch.highlight ? " highlights" : ""}`,
        onclick: () => this.toggle(this.filter.colors, swatch.key),
      });
      dot.style.backgroundColor = swatch.ink;
      this.filterBar.append(dot);
    }
    if (this.filtering()) {
      this.filterBar.append(
        el("span.nb-filter-spacer"),
        el(
          "button.nb-chip.nb-filter-clear",
          {
            onclick: () => {
              this.filter.kinds.clear();
              this.filter.colors.clear();
              this.render();
            },
          },
          "Clear",
        ),
      );
    }
  }

  private toggle<T>(set: Set<T>, value: T): void {
    if (!set.delete(value)) set.add(value);
    this.render();
  }

  /** What the open document itself has to say about the query. */
  private renderFound(): HTMLElement {
    this.foundCount.textContent = String(this.hits.length);
    this.foundList.innerHTML = "";
    if (!this.hits.length) {
      this.foundList.append(
        el("p.muted.nb-section-empty", null, "Nothing on this page matches."),
      );
      return this.found;
    }
    for (const hit of this.hits) {
      this.foundList.append(
        el(
          "button.nb-hit",
          { onclick: () => this.host.gotoDocumentHit(hit.i) },
          el("span.nb-hit-at", null, `${Math.round(hit.ratio * 100)}%`),
          el(
            "span.nb-hit-text",
            null,
            hit.before,
            el("mark.nb-hit-mark", null, hit.match),
            hit.after,
          ),
        ),
      );
    }
    return this.found;
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
    const caret = caretIcon();
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
    const entries = this.store.entries(docId).filter((e) => this.matches(e));
    const collapsed = page.collapsed;

    section.root.classList.toggle("is-current", isCurrent);
    section.root.classList.toggle("is-collapsed", collapsed);
    section.caret.classList.toggle("is-open", !collapsed);
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

    // Renaming a bookmark: the label swaps for a field in place, so the
    // card keeps its position in the list while you type.
    let renaming = false;
    const nameField = el("input.nb-rename", { hidden: true, spellcheck: false }) as HTMLInputElement;
    const stopRenaming = (commit: boolean): void => {
      if (!renaming) return;
      renaming = false;
      nameField.hidden = true;
      title.hidden = !title.textContent;
      const value = nameField.value.trim();
      if (commit && entry && value && value !== entry.label) {
        this.host.rename(entry, docId, value);
        this.render();
      }
    };
    const startRenaming = (): void => {
      if (!entry) return;
      renaming = true;
      nameField.value = entry.label ?? "";
      nameField.hidden = false;
      title.hidden = true;
      nameField.focus();
      nameField.select();
    };
    nameField.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stopRenaming(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        stopRenaming(false);
      }
    });
    nameField.addEventListener("blur", () => stopRenaming(true));

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
    const renameBtn = el(
      "button.nb-tool",
      { title: "Give this bookmark a name", onclick: () => startRenaming() },
      "Rename",
    );
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
    const tools = el(
      "div.nb-card-tools",
      null,
      swatches,
      el("span.nb-tool-spacer"),
      renameBtn,
      noteBtn,
      del,
    );
    const root = el(
      "article.nb-card",
      null,
      spine,
      el("div.nb-card-body", null, jump, nameField, noteHost, tools),
      grip,
    );

    const update = (next: NotebookEntry, nextDoc: string, where: string | null): void => {
      entry = next;
      docId = nextDoc;
      root.dataset.kind = next.kind;
      root.dataset.id = next.id;
      const accent = colorInk(next, this.host);
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
      title.hidden = !title.textContent || renaming;
      renameBtn.hidden = next.kind !== "bookmark";
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
    const current = isHighlight ? highlightInkOf(entry, this.host) : entry.color;
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

const KIND_LABEL: Record<NotebookKind, string> = {
  highlight: "Highlight",
  bookmark: "Bookmark",
  snapshot: "Snapshot",
  note: "Note",
};

const KIND_PLURAL: Record<NotebookKind, string> = {
  highlight: "Highlights",
  bookmark: "Bookmarks",
  snapshot: "Snapshots",
  note: "Notes",
};

/** Reading order, so the filter chips do not shuffle about. */
const KIND_ORDER: NotebookKind[] = ["highlight", "bookmark", "snapshot", "note"];

/** A highlight's colour comes from the document; the rest carry their own. */
function highlightInkOf(entry: NotebookEntry, host: NotebookHost): HighlightColor {
  return entry.highlightColor ?? host.highlightColor(entry.id) ?? "sun";
}

/**
 * What a colour filter is keyed on. Highlights use the document's palette and
 * everything else the notebook's, and the two share a name or two, so the
 * palette is part of the key.
 */
function colorKey(entry: NotebookEntry, host: NotebookHost): string {
  return entry.kind === "highlight" ? `hl:${highlightInkOf(entry, host)}` : entry.color;
}

function colorInk(entry: NotebookEntry, host: NotebookHost): string {
  return entry.kind === "highlight"
    ? HIGHLIGHT_COLORS[highlightInkOf(entry, host)]
    : (ENTRY_COLORS[entry.color] ?? ENTRY_COLORS.ink);
}

/** The section twirl. An icon rather than a glyph, so it can be sized. */
function caretIcon(): HTMLElement {
  const span = el("span.nb-caret");
  span.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
  return span;
}

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
