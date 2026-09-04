import type { AppContext, ReaderJump } from "../main";
import {
  getDocument,
  getDocumentHtml,
  saveState,
  exportDocument,
  editSetRemovals,
  notebookExport,
  notebookPutSnapshot,
  notebookDeleteSnapshot,
} from "../api";
import {
  emptyState,
  ENTRY_COLORS,
  HIGHLIGHT_COLORS,
  type Bookmark,
  type DocState,
  type DocSummary,
  type Highlight,
  type HighlightColor,
  type NotebookEntry,
  type PagePosition,
} from "../types";
import { el, toast, debounce, uid, domainOf, clamp } from "../util";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { exportAnnotationsFlow, copyAnnotations } from "../annotations";
import { NotebookStore } from "../notebook/store";
import { NotebookPanel, type NotebookHost } from "../notebook/panel";
import { openUrl } from "@tauri-apps/plugin-opener";
import RUNTIME_SRC from "../reader/runtime.js?raw";

interface ProphetMessage {
  __prophet: true;
  type: string;
  [k: string]: unknown;
}

export function mountReader(
  root: HTMLElement,
  ctx: AppContext,
  id: string,
  jump?: ReaderJump,
): () => void {
  let disposed = false;
  let doc: DocSummary | null = null;
  let state: DocState = emptyState();
  let dirty = false;
  let sidebarOpen = false;
  let notebook: NotebookStore | null = null;
  let panel: NotebookPanel | null = null;
  let pendingSelection: { exact: string; prefix: string; suffix: string } | null = null;
  const pendingHighlights = new Map<string, Highlight>();
  let contextReqId = 0;
  const contextWaiters = new Map<number, (p: { snippet: string; y: number; ratio: number; docHeight: number }) => void>();
  /** Path of the page currently shown (multi-page documents). */
  let currentPage = "/";

  function pageState(path: string): PagePosition {
    state.pages = state.pages ?? {};
    return (state.pages[path] ??= { scrollY: 0, scrollRatio: 0, docHeight: 0 });
  }

  // Legacy snapshots are sandboxed srcdoc documents; archives are served by
  // the app's own URI scheme, where the page needs a real origin so its
  // scripts, modules and storage behave exactly as they did online. Network
  // access is blocked by the CSP the protocol handler serves.
  const iframe = el("iframe.reader-frame", { title: "Document" }) as HTMLIFrameElement;

  const progressLabel = el("span.reader-progress", null, "0%");
  const titleLabel = el("span.reader-title", null, "…");
  const subtitleLabel = el("span.reader-subtitle");
  const sidebar = el("aside.reader-sidebar");
  /** Set while the document is waiting for a region to be dragged. */
  let snapshotting = false;
  const popover = el("div.hl-popover", { hidden: true });
  let menuEl: HTMLElement | null = null;

  const persist = debounce(() => {
    if (!dirty || disposed) return;
    dirty = false;
    void saveState(id, state).catch((e) => console.error("save_state failed", e));
  }, 1200);

  const persistInterval = window.setInterval(() => {
    if (dirty) persist.flush();
  }, 15000);

  function markDirty(): void {
    dirty = true;
    persist();
  }

  function post(msg: Record<string, unknown>): void {
    iframe.contentWindow?.postMessage({ __prophet: true, ...msg }, "*");
  }

  // ---- toolbar -----------------------------------------------------------

  const bookmarkBtn = el(
    "button.icon-btn",
    { title: "Add bookmark", onclick: () => void addBookmark() },
    svgBookmark(),
  );
  const sidebarBtn = el(
    "button.icon-btn",
    {
      title: "Notebook",
      onclick: () => {
        sidebarOpen = !sidebarOpen;
        renderSidebar();
      },
    },
    svgNotebook(),
  );
  const menuBtn = el(
    "button.icon-btn",
    {
      title: "More",
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        toggleMenu();
      },
    },
    "⋯",
  );

  const toolbar = el(
    "header.reader-toolbar",
    null,
    el(
      "button.btn.btn-ghost",
      {
        onclick: () => ctx.navigate({ name: "library" }),
      },
      "← Library",
    ),
    el("div.reader-titles", null, titleLabel, subtitleLabel),
    el("div.reader-tools", null, progressLabel, bookmarkBtn, sidebarBtn, menuBtn),
  );

  const editBar = el("div.edit-bar", { hidden: true });
  const frameWrap = el("div.reader-frame-wrap", null, iframe, popover);
  const layout = el("div.reader-layout", null, frameWrap, sidebar);
  root.append(el("div.reader-view", null, toolbar, editBar, layout));

  // ---- edit mode ---------------------------------------------------------

  let editing = false;
  let editMode: "remove" | "add" = "remove";
  // Adding pages needs the capture webview, which Tauri only offers on
  // desktop; removing elements is local and works everywhere.
  const canAddPages = ctx.canCapture;
  let editCounts = { removed: 0, added: [] as Array<{ url: string; label: string }> };
  let editReqId = 0;
  const editWaiters = new Map<
    number,
    (r: { removed: string[]; added: Array<{ url: string; label: string }>; page: string }) => void
  >();

  function beginEdit(mode: "remove" | "add"): void {
    editing = true;
    editMode = mode;
    editCounts = { removed: 0, added: [] };
    post({ type: "edit-begin", mode });
    renderEditBar();
  }

  function endEdit(): void {
    editing = false;
    post({ type: "edit-end", clear: true });
    editBar.hidden = true;
    editBar.innerHTML = "";
  }

  function renderEditBar(): void {
    if (!editing) {
      editBar.hidden = true;
      return;
    }
    editBar.hidden = false;
    editBar.innerHTML = "";
    const tab = (mode: "remove" | "add", label: string) =>
      el(
        `button.btn.btn-small.edit-tab.${editMode === mode ? "btn-primary" : "btn-ghost"}`,
        {
          onclick: () => {
            editMode = mode;
            post({ type: "edit-begin", mode });
            renderEditBar();
          },
        },
        label,
      );
    const pending = editCounts.removed + editCounts.added.length;
    editBar.append(
      el(
        "div.edit-bar-row",
        null,
        tab("remove", "Remove elements"),
        canAddPages ? tab("add", "Add pages") : null,
      ),
      el(
        "p.edit-hint",
        null,
        editMode === "remove"
          ? "Click anything in the document to mark it for removal — marked parts turn red. Click again to unmark; ↑ selects the surrounding block."
          : "Click a link to add its page to this document. Marked links turn green.",
      ),
      el(
        "div.edit-bar-row",
        null,
        el(
          "span.edit-count",
          null,
          `${editCounts.removed} to remove · ${editCounts.added.length} page${
            editCounts.added.length === 1 ? "" : "s"
          } to add`,
        ),
        el("span.edit-spacer"),
        el("button.btn.btn-ghost.btn-small", { onclick: () => endEdit() }, "Cancel"),
        el(
          `button.btn.btn-primary.btn-small.edit-update${pending ? "" : ".is-busy"}`,
          { onclick: () => void applyEdit(), disabled: pending === 0 },
          "Update Document",
        ),
      ),
    );
  }

  function collectEdit(): Promise<{
    removed: string[];
    added: Array<{ url: string; label: string }>;
    page: string;
  }> {
    return new Promise((resolve, reject) => {
      const reqId = ++editReqId;
      editWaiters.set(reqId, resolve);
      post({ type: "edit-collect", reqId });
      setTimeout(() => {
        if (editWaiters.delete(reqId)) reject(new Error("the document did not respond"));
      }, 3000);
    });
  }

  async function applyEdit(): Promise<void> {
    let picked;
    try {
      picked = await collectEdit();
    } catch (e) {
      toast(String(e), "error");
      return;
    }
    const { removed, added, page } = picked;
    if (!removed.length && !added.length) {
      endEdit();
      return;
    }
    try {
      if (removed.length) {
        await editSetRemovals(id, page || currentPage, removed);
      }
    } catch (e) {
      toast(`Could not save changes: ${e}`, "error");
      return;
    }
    editing = false;
    editBar.hidden = true;

    if (added.length) {
      // Fetching new pages needs the network, so hand off to the capture
      // view, which opens the site with your session.
      toast(`Fetching ${added.length} page${added.length === 1 ? "" : "s"}…`);
      ctx.navigate({
        name: "capture",
        url: added[0].url,
        append: { docId: id, urls: added.map((a) => a.url) },
      });
      return;
    }
    toast(`Removed ${removed.length} element${removed.length === 1 ? "" : "s"}`);
    iframe.contentWindow?.location.reload();
  }

  function toggleMenu(): void {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
      return;
    }
    if (!doc) return;
    menuEl = el(
      "div.card-menu.reader-menu",
      { onclick: (e: MouseEvent) => e.stopPropagation() },
      el(
        "button.card-menu-item",
        {
          onclick: async () => {
            closeMenus();
            await exportFlow();
          },
        },
        "Export document…",
      ),
      el(
        "button.card-menu-item",
        {
          onclick: async () => {
            closeMenus();
            if (doc) await exportAnnotationsFlow(id, doc.meta.title);
          },
        },
        "Export highlights…",
      ),
      el(
        "button.card-menu-item",
        {
          onclick: () => {
            closeMenus();
            void copyAnnotations(id);
          },
        },
        "Copy highlights as Markdown",
      ),
      el(
        "button.card-menu-item",
        {
          onclick: async () => {
            closeMenus();
            await exportNotebookFlow();
          },
        },
        "Export notebook…",
      ),
      el(
        "button.card-menu-item",
        {
          onclick: () => {
            closeMenus();
            beginEdit("remove");
          },
        },
        "Edit document…",
      ),
      el(
        "button.card-menu-item",
        {
          onclick: () => {
            closeMenus();
            if (doc) void openUrl(doc.meta.sourceUrl).catch((e) => toast(String(e), "error"));
          },
        },
        "Open original page",
      ),
    );
    toolbar.append(menuEl);
  }
  function closeMenus(): void {
    menuEl?.remove();
    menuEl = null;
  }
  const onGlobalClick = () => {
    closeMenus();
    hidePopover();
  };
  window.addEventListener("click", onGlobalClick);

  async function exportFlow(): Promise<void> {
    if (!doc) return;
    persist.flush();
    const safe = doc.meta.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "document";
    const dest = await saveDialog({
      defaultPath: `${safe}.prophet`,
      filters: [{ name: "Daily Prophet Document", extensions: ["prophet"] }],
    });
    if (!dest) return;
    try {
      await exportDocument(id, dest);
      toast("Exported — share the .prophet file with any Daily Prophet reader");
    } catch (err) {
      toast(`Export failed: ${err}`, "error");
    }
  }

  async function exportNotebookFlow(): Promise<void> {
    notebook?.flush();
    const dest = await saveDialog({
      defaultPath: "Notebook.dailyprophet",
      filters: [{ name: "Daily Prophet Notebook", extensions: ["dailyprophet"] }],
    });
    if (!dest) return;
    try {
      await notebookExport(dest);
      toast("Notebook exported");
    } catch (err) {
      toast(`Export failed: ${err}`, "error");
    }
  }

  // ---- popovers ----------------------------------------------------------

  function showSelectionPopover(rect: { x: number; y: number; w: number; h: number }): void {
    popover.innerHTML = "";
    popover.append(
      ...(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((color) =>
        el("button.hl-dot", {
          title: `Highlight (${color})`,
          style: undefined,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            createHighlight(color);
          },
        }),
      ),
    );
    popover.querySelectorAll<HTMLElement>(".hl-dot").forEach((dot, i) => {
      const color = (Object.keys(HIGHLIGHT_COLORS) as HighlightColor[])[i];
      dot.style.backgroundColor = HIGHLIGHT_COLORS[color];
    });
    positionPopover(rect);
  }

  function showHighlightPopover(hlId: string, rect: { x: number; y: number; w: number; h: number }): void {
    popover.innerHTML = "";
    popover.append(
      ...(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((color) => {
        const dot = el("button.hl-dot", {
          title: color,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            const hl = state.highlights.find((h) => h.id === hlId);
            if (hl) {
              hl.color = color;
              post({ type: "recolor-highlight", id: hlId, color });
              notebook?.update(id, hlId, { highlightColor: color });
              markDirty();
              renderSidebar();
            }
            hidePopover();
          },
        });
        dot.style.backgroundColor = HIGHLIGHT_COLORS[color];
        return dot;
      }),
      el(
        "button.hl-remove",
        {
          title: "Remove highlight",
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            removeHighlight(hlId);
            hidePopover();
          },
        },
        svgTrash(),
      ),
    );
    positionPopover(rect);
  }

  function positionPopover(rect: { x: number; y: number; w: number; h: number }): void {
    const frameRect = iframe.getBoundingClientRect();
    const wrapRect = frameWrap.getBoundingClientRect();
    popover.hidden = false;
    const pw = popover.offsetWidth || 160;
    const x = clamp(
      frameRect.left - wrapRect.left + rect.x + rect.w / 2 - pw / 2,
      8,
      wrapRect.width - pw - 8,
    );
    let y = frameRect.top - wrapRect.top + rect.y - popover.offsetHeight - 10;
    if (y < 4) y = frameRect.top - wrapRect.top + rect.y + rect.h + 10;
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
  }

  function hidePopover(): void {
    popover.hidden = true;
  }

  // ---- highlights --------------------------------------------------------

  function createHighlight(color: HighlightColor): void {
    if (!pendingSelection) return;
    const hl: Highlight = {
      id: uid(),
      color,
      exact: pendingSelection.exact,
      prefix: pendingSelection.prefix,
      suffix: pendingSelection.suffix,
      createdAt: Date.now(),
      page: currentPage,
    };
    pendingSelection = null;
    hidePopover();
    pendingHighlights.set(hl.id, hl);
    post({ type: "apply-highlight", hl });
    // Confirmation (highlight-result) adds it to state.
  }

  function removeHighlight(hlId: string): void {
    post({ type: "remove-highlight", id: hlId });
    state.highlights = state.highlights.filter((h) => h.id !== hlId);
    notebook?.remove(id, hlId);
    markDirty();
    renderSidebar();
  }

  // ---- bookmarks ---------------------------------------------------------

  function getFrameContext(): Promise<{ snippet: string; y: number; ratio: number; docHeight: number }> {
    return new Promise((resolve, reject) => {
      const reqId = ++contextReqId;
      contextWaiters.set(reqId, resolve);
      post({ type: "get-context", reqId });
      setTimeout(() => {
        if (contextWaiters.delete(reqId)) reject(new Error("snapshot did not respond"));
      }, 3000);
    });
  }

  async function addBookmark(): Promise<void> {
    try {
      const cx = await getFrameContext();
      const pct = Math.round(cx.ratio * 100);
      const now = Date.now();
      const bm: Bookmark = {
        id: uid(),
        label: cx.snippet || `At ${pct}%`,
        y: cx.y,
        ratio: cx.ratio,
        docHeight: cx.docHeight,
        createdAt: now,
        updatedAt: now,
        page: currentPage,
      };
      state.bookmarks.push(bm);
      notebook?.add(id, {
        kind: "bookmark",
        id: bm.id,
        page: currentPage,
        ratio: bm.ratio,
        y: bm.y,
        docHeight: bm.docHeight,
        label: bm.label,
        createdAt: now,
        updatedAt: now,
      });
      markDirty();
      pushMarkers();
      renderSidebar();
      toast("Bookmark added");
    } catch (e) {
      toast(`Could not add bookmark: ${e}`, "error");
    }
  }

  /** Where to scroll (or what to flash) once a page finishes loading. */
  let pendingJump: { page: string; ratio?: number; highlightId?: string } | null = null;

  function jumpTo(page: string, target: { ratio?: number; highlightId?: string }): void {
    if (page === currentPage) {
      if (target.highlightId) post({ type: "scroll-to-highlight", id: target.highlightId });
      else if (target.ratio !== undefined) post({ type: "scroll-to", ratio: target.ratio, smooth: true });
      return;
    }
    if (!doc || (doc.meta.format ?? 1) < 2) return;
    pendingJump = { page, ...target };
    iframe.src = `prophet://${id}${page}`;
  }

  // ---- the notebook ------------------------------------------------------

  const notebookHost: NotebookHost = {
    docId: id,
    title: "",
    sourceUrl: "",
    jump: jumpToEntry,
    onDelete: deleteEntryAnchor,
    recolor: () => pushMarkers(),
    highlightColor: (hlId) => state.highlights.find((h) => h.id === hlId)?.color ?? null,
    setHighlightColor: (hlId, color) => {
      const hl = state.highlights.find((h) => h.id === hlId);
      if (!hl) return;
      hl.color = color;
      post({ type: "recolor-highlight", id: hlId, color });
      notebook?.update(id, hlId, { highlightColor: color });
      markDirty();
    },
    rename: (entry, docId, label) => {
      notebook?.update(docId, entry.id, { label, renamed: true });
      if (docId !== id) return;
      const bm = state.bookmarks.find((b) => b.id === entry.id);
      if (!bm) return;
      bm.label = label;
      bm.updatedAt = Date.now();
      markDirty();
      pushMarkers();
    },
    addBookmark: () => void addBookmark(),
    startSnapshot: () => beginSnapshot(),
    addNote: () => addNote(),
  };

  function renderSidebar(): void {
    sidebar.classList.toggle("open", sidebarOpen);
    if (!sidebarOpen || !panel) return;
    if (!panel.root.parentNode) sidebar.append(panel.root);
    panel.render();
  }

  function openSidebar(): void {
    sidebarOpen = true;
    renderSidebar();
  }

  /** Scrolls to an entry, opening its document first when it is another one. */
  function jumpToEntry(entry: NotebookEntry, docId: string): void {
    if (docId !== id) {
      persist.flush();
      notebook?.flush();
      ctx.navigate({
        name: "reader",
        id: docId,
        jump: {
          page: entry.page,
          ratio: entry.ratio,
          highlightId: entry.kind === "highlight" ? entry.id : undefined,
        },
      });
      return;
    }
    if (entry.kind === "highlight") jumpTo(entry.page, { highlightId: entry.id });
    else jumpTo(entry.page, { ratio: entry.ratio });
  }

  /**
   * Deleting a card takes the thing it stands for with it: a highlight's mark
   * and a bookmark's anchor live in reading state, a snapshot's PNG on disk.
   */
  function deleteEntryAnchor(entry: NotebookEntry, docId: string): void {
    if (entry.kind === "snapshot") {
      void notebookDeleteSnapshot(entry.id).catch(() => {});
      return;
    }
    if (docId !== id) return; // only the open document has live anchors
    if (entry.kind === "highlight") {
      post({ type: "remove-highlight", id: entry.id });
      state.highlights = state.highlights.filter((h) => h.id !== entry.id);
      markDirty();
    } else if (entry.kind === "bookmark") {
      state.bookmarks = state.bookmarks.filter((b) => b.id !== entry.id);
      markDirty();
      pushMarkers();
    }
  }

  /** Draws this page's bookmarks as arrows in the document's left margin. */
  function pushMarkers(): void {
    const items = state.bookmarks
      .filter((bm) => (bm.page ?? currentPage) === currentPage)
      .map((bm) => ({
        id: bm.id,
        y: bm.y,
        ratio: bm.ratio,
        docHeight: bm.docHeight,
        label: bm.label,
        color: ENTRY_COLORS[notebook?.entry(id, bm.id)?.color ?? "crimson"],
      }));
    post({ type: "bookmarks", items });
  }

  function addNote(): void {
    if (!notebook || !panel) return;
    const entry = notebook.add(id, {
      kind: "note",
      page: currentPage,
      ratio: state.scrollRatio || 0,
    });
    panel.pendingFocus = entry.id;
    openSidebar();
  }

  function beginSnapshot(): void {
    if (snapshotting) return;
    snapshotting = true;
    post({ type: "snapshot-begin" });
  }

  async function saveSnapshot(shot: {
    png: string;
    width: number;
    height: number;
    y: number;
    ratio: number;
    docHeight: number;
    label: string;
  }): Promise<void> {
    if (!notebook) return;
    const entry = notebook.add(id, {
      kind: "snapshot",
      page: currentPage,
      ratio: shot.ratio,
      y: shot.y,
      docHeight: shot.docHeight,
      label: shot.label,
      imageW: shot.width,
      imageH: shot.height,
    });
    try {
      await notebookPutSnapshot(entry.id, shot.png);
    } catch (e) {
      // Without its image the card would be an empty frame, so it goes too.
      notebook.remove(id, entry.id);
      renderSidebar();
      toast(`Could not save that snapshot: ${e}`, "error");
      return;
    }
    notebook.flush();
    openSidebar();
    toast("Snapshot added to the notebook");
  }

  /**
   * Lines the notebook up with reading state. Highlights and bookmarks are
   * anchored there — that is what survives a re-render and what annotation
   * export reads — so anything the notebook has not seen gets a card, and
   * anything it has buried is removed for good. That last part is what makes
   * a deletion stick: reading state is unioned across devices, so without a
   * tombstone the annotation would simply come back.
   */
  function reconcileNotebook(): void {
    if (!notebook || !doc) return;
    notebook.page(id, { title: doc.meta.title, sourceUrl: doc.meta.sourceUrl });

    state.highlights = state.highlights.filter((hl) => {
      if (notebook!.isDeleted(id, hl.id)) {
        markDirty();
        return false;
      }
      const entry = notebook!.entry(id, hl.id);
      if (!entry) {
        notebook!.add(id, {
          kind: "highlight",
          id: hl.id,
          page: hl.page ?? currentPage,
          ratio: 0,
          quote: hl.exact,
          highlightColor: hl.color,
          createdAt: hl.createdAt,
          updatedAt: hl.createdAt,
        });
      } else {
        notebook!.update(id, hl.id, {
          quote: hl.exact,
          highlightColor: hl.color,
          page: hl.page ?? entry.page,
        });
      }
      return true;
    });

    state.bookmarks = state.bookmarks.filter((bm) => {
      if (notebook!.isDeleted(id, bm.id)) {
        markDirty();
        return false;
      }
      const entry = notebook!.entry(id, bm.id);
      if (!entry) {
        notebook!.add(id, {
          kind: "bookmark",
          id: bm.id,
          page: bm.page ?? currentPage,
          ratio: bm.ratio,
          y: bm.y,
          docHeight: bm.docHeight,
          label: bm.label,
          createdAt: bm.createdAt,
          updatedAt: bm.updatedAt ?? bm.createdAt,
        });
      } else if (entry.updatedAt > (bm.updatedAt ?? bm.createdAt)) {
        // The bookmark was dragged on another device: the notebook carries
        // that edit, reading state only unions by id, so the notebook wins.
        bm.y = entry.y ?? bm.y;
        bm.ratio = entry.ratio;
        bm.docHeight = entry.docHeight ?? bm.docHeight;
        bm.label = entry.label ?? bm.label;
        bm.updatedAt = entry.updatedAt;
        markDirty();
      } else {
        notebook!.update(id, bm.id, {
          page: bm.page ?? entry.page,
          ratio: bm.ratio,
          y: bm.y,
          docHeight: bm.docHeight,
          label: bm.label,
        });
      }
      return true;
    });
  }

  /** Keeps the notebook's ordering honest as highlights re-anchor. */
  function updateHighlightPositions(
    positions: Record<string, { y: number; ratio: number; docHeight: number }>,
  ): void {
    if (!notebook) return;
    let moved = false;
    for (const [hlId, at] of Object.entries(positions ?? {})) {
      const entry = notebook.entry(id, hlId);
      if (!entry || Math.abs(entry.ratio - at.ratio) < 0.0005) continue;
      notebook.update(id, hlId, { ratio: at.ratio, y: at.y, docHeight: at.docHeight });
      moved = true;
    }
    if (moved) renderSidebar();
  }

  // ---- iframe messages ---------------------------------------------------

  function onMessage(e: MessageEvent): void {
    if (e.source !== iframe.contentWindow) return;
    const d = e.data as ProphetMessage;
    if (!d || d.__prophet !== true) return;
    switch (d.type) {
      case "ready": {
        currentPage = (d.page as string) || "/";
        state.lastOpenedAt = Date.now();
        state.lastPage = currentPage;
        markDirty();
        // A page change tears down the overlay along with the page.
        snapshotting = false;
        reconcileNotebook();
        const pos = pageState(currentPage);
        const mine = state.highlights.filter((h) => (h.page ?? currentPage) === currentPage);
        post({
          type: "init",
          state: { scrollY: pos.scrollY, scrollRatio: pos.scrollRatio, docHeight: pos.docHeight },
          highlights: mine.filter((h) => !h.orphaned).concat(mine.filter((h) => h.orphaned)),
        });
        pushMarkers();
        renderSidebar();
        if (pendingJump && pendingJump.page === currentPage) {
          const jump = pendingJump;
          pendingJump = null;
          setTimeout(() => {
            if (jump.highlightId) post({ type: "scroll-to-highlight", id: jump.highlightId });
            else if (jump.ratio !== undefined) post({ type: "scroll-to", ratio: jump.ratio, smooth: false });
          }, 250);
        }
        break;
      }
      case "scroll": {
        const y = d.y as number;
        const ratio = d.ratio as number;
        const docHeight = d.docHeight as number;
        const page = (d.page as string) || currentPage;
        const pos = pageState(page);
        pos.scrollY = y;
        pos.scrollRatio = ratio;
        pos.docHeight = docHeight;
        if (page === currentPage) {
          state.scrollY = y;
          state.scrollRatio = ratio;
          state.docHeight = docHeight;
          state.progress = ratio;
        }
        progressLabel.textContent = `${Math.round(ratio * 100)}%`;
        markDirty();
        hidePopover();
        break;
      }
      case "doc-height":
        state.docHeight = d.docHeight as number;
        break;
      case "selection":
        pendingSelection = {
          exact: d.exact as string,
          prefix: d.prefix as string,
          suffix: d.suffix as string,
        };
        showSelectionPopover(d.rect as { x: number; y: number; w: number; h: number });
        break;
      case "selection-cleared":
        pendingSelection = null;
        if (!popover.querySelector(".hl-remove")) hidePopover();
        break;
      case "highlight-clicked":
        showHighlightPopover(d.id as string, d.rect as { x: number; y: number; w: number; h: number });
        break;
      case "highlight-result": {
        const hl = pendingHighlights.get(d.id as string);
        pendingHighlights.delete(d.id as string);
        if (!(d.ok as boolean)) {
          toast("Couldn't anchor that highlight — try a slightly longer selection", "error");
          break;
        }
        if (hl) {
          state.highlights.push(hl);
          const at = d.position as { y: number; ratio: number; docHeight: number } | null;
          notebook?.add(id, {
            kind: "highlight",
            id: hl.id,
            page: hl.page ?? currentPage,
            ratio: at?.ratio ?? state.scrollRatio ?? 0,
            y: at?.y,
            docHeight: at?.docHeight,
            quote: hl.exact,
            highlightColor: hl.color,
            createdAt: hl.createdAt,
          });
          markDirty();
          renderSidebar();
        }
        break;
      }
      case "highlights-applied": {
        const orphaned = new Set(d.orphaned as string[]);
        const applied = new Set(d.applied as string[]);
        let changed = false;
        for (const hl of state.highlights) {
          if ((hl.page ?? currentPage) !== currentPage) continue;
          if (!orphaned.has(hl.id) && !applied.has(hl.id)) continue;
          const is = orphaned.has(hl.id);
          if (!!hl.orphaned !== is) {
            hl.orphaned = is;
            changed = true;
          }
        }
        if (changed) {
          markDirty();
          renderSidebar();
        }
        updateHighlightPositions(
          d.positions as Record<string, { y: number; ratio: number; docHeight: number }>,
        );
        break;
      }
      case "edit-selection":
        editCounts = {
          removed: (d.removed as number) ?? 0,
          added: (d.added as Array<{ url: string; label: string }>) ?? [],
        };
        renderEditBar();
        break;
      case "edit-result": {
        const w = editWaiters.get(d.reqId as number);
        if (w) {
          editWaiters.delete(d.reqId as number);
          w(d as unknown as {
            removed: string[];
            added: Array<{ url: string; label: string }>;
            page: string;
          });
        }
        break;
      }
      case "bookmark-moved": {
        const bm = state.bookmarks.find((b) => b.id === d.id);
        if (!bm) break;
        bm.y = d.y as number;
        bm.ratio = d.ratio as number;
        bm.docHeight = d.docHeight as number;
        // The label follows the heading the arrow lands under — unless it
        // was named by hand, in which case the name is the point of it.
        if (!notebook?.entry(id, bm.id)?.renamed) bm.label = (d.label as string) || bm.label;
        bm.updatedAt = Date.now();
        markDirty();
        notebook?.update(id, bm.id, {
          y: bm.y,
          ratio: bm.ratio,
          docHeight: bm.docHeight,
          label: bm.label,
        });
        renderSidebar();
        break;
      }
      case "bookmark-activated":
        openSidebar();
        panel?.reveal(d.id as string);
        break;
      case "snapshot-armed":
        toast("Drag over the page to snapshot it — Esc to cancel");
        break;
      case "snapshot-cancelled":
        snapshotting = false;
        break;
      case "snapshot-result":
        snapshotting = false;
        void saveSnapshot(
          d as unknown as {
            png: string;
            width: number;
            height: number;
            y: number;
            ratio: number;
            docHeight: number;
            label: string;
          },
        );
        break;
      case "snapshot-error":
        snapshotting = false;
        toast(`Snapshot failed: ${d.message as string}`, "error");
        break;
      case "external-link":
        void openUrl(d.href as string).catch(() => toast("Could not open link", "error"));
        break;
      case "context": {
        const waiter = contextWaiters.get(d.reqId as number);
        if (waiter) {
          contextWaiters.delete(d.reqId as number);
          waiter(d as unknown as { snippet: string; y: number; ratio: number; docHeight: number });
        }
        break;
      }
    }
  }
  window.addEventListener("message", onMessage);

  // ---- boot --------------------------------------------------------------

  async function boot(): Promise<void> {
    try {
      doc = await getDocument(id);
    } catch (e) {
      toast(`Could not open document: ${e}`, "error");
      ctx.navigate({ name: "library" });
      return;
    }
    if (disposed || !doc) return;
    state = { ...emptyState(), ...(doc.state ?? {}) };
    titleLabel.textContent = doc.meta.title;
    subtitleLabel.textContent = domainOf(doc.meta.sourceUrl);
    progressLabel.textContent = `${Math.round((state.progress || 0) * 100)}%`;

    notebook = await NotebookStore.open();
    if (disposed) return;
    notebookHost.title = doc.meta.title;
    notebookHost.sourceUrl = doc.meta.sourceUrl;
    panel = new NotebookPanel(notebook, notebookHost);
    renderSidebar();

    // Arriving from a card in another document's section.
    if (jump) pendingJump = { page: jump.page, ratio: jump.ratio, highlightId: jump.highlightId };

    if ((doc.meta.format ?? 1) >= 2) {
      // Resource-map archive: let the browser load it natively.
      let path = "/";
      try {
        const u = new URL(doc.meta.sourceUrl);
        path = u.pathname + u.search;
      } catch {
        /* keep root */
      }
      // Resume on the page that was last being read. This is what lets
      // another device pick up a multi-page document where you left off.
      if (state.lastPage && state.lastPage !== path && state.pages?.[state.lastPage]) {
        path = state.lastPage;
      }
      iframe.src = `prophet://${id}${path}`;
      return;
    }

    let html: string;
    try {
      html = await getDocumentHtml(id);
    } catch (e) {
      toast(`Could not load snapshot: ${e}`, "error");
      return;
    }
    if (disposed) return;
    iframe.sandbox.value = "allow-scripts allow-forms";
    iframe.srcdoc = injectRuntime(html);
  }

  function injectRuntime(html: string): string {
    const safeRuntime = RUNTIME_SRC.replace(/<\/(script)/gi, "<\\/$1");
    const tag = `<script data-prophet-runtime>${safeRuntime}</${"script"}>`;
    const headMatch = html.match(/<head[^>]*>/i);
    if (headMatch && headMatch.index !== undefined) {
      const at = headMatch.index + headMatch[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
    return tag + html;
  }

  void boot();

  return () => {
    disposed = true;
    window.clearInterval(persistInterval);
    window.removeEventListener("message", onMessage);
    window.removeEventListener("click", onGlobalClick);
    if (dirty) {
      dirty = false;
      void saveState(id, state).catch(() => {});
    }
    persist.cancel();
    panel?.dispose();
    notebook?.dispose();
  };
}

// ---- inline SVG icons ----------------------------------------------------

function svg(paths: string, viewBox = "0 0 24 24"): HTMLElement {
  const span = document.createElement("span");
  span.className = "svg-icon";
  span.innerHTML = `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return span;
}

function svgBookmark(): HTMLElement {
  return svg('<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>');
}

function svgNotebook(): HTMLElement {
  return svg(
    '<path d="M7 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
      '<path d="M5 7h3"/><path d="M5 12h3"/><path d="M5 17h3"/><path d="M11 8h5"/><path d="M11 12h5"/>',
  );
}

function svgTrash(): HTMLElement {
  return svg('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>');
}

