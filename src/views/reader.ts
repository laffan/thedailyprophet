import type { AppContext } from "../main";
import {
  getDocument,
  getDocumentHtml,
  saveState,
  exportDocument,
  editSetRemovals,
  appPlatform,
} from "../api";
import {
  emptyState,
  HIGHLIGHT_COLORS,
  type DocState,
  type DocSummary,
  type Highlight,
  type HighlightColor,
  type PagePosition,
} from "../types";
import { el, toast, debounce, uid, domainOf, clamp } from "../util";
import { promptModal } from "../modal";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { exportAnnotationsFlow, copyAnnotations } from "../annotations";
import { openUrl } from "@tauri-apps/plugin-opener";
import RUNTIME_SRC from "../reader/runtime.js?raw";

interface ProphetMessage {
  __prophet: true;
  type: string;
  [k: string]: unknown;
}

export function mountReader(root: HTMLElement, ctx: AppContext, id: string): () => void {
  let disposed = false;
  let doc: DocSummary | null = null;
  let state: DocState = emptyState();
  let dirty = false;
  let sidebarOpen = false;
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
      title: "Bookmarks & highlights",
      onclick: () => {
        sidebarOpen = !sidebarOpen;
        renderSidebar();
      },
    },
    svgList(),
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
  let canAddPages = true;
  void appPlatform().then((p) => {
    canAddPages = p !== "ios" && p !== "android";
    if (editing) renderEditBar();
  });
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
      const bm = {
        id: uid(),
        label: cx.snippet || `At ${pct}%`,
        y: cx.y,
        ratio: cx.ratio,
        docHeight: cx.docHeight,
        createdAt: Date.now(),
        page: currentPage,
      };
      state.bookmarks.push(bm);
      markDirty();
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

  function pageLabel(page: string | undefined): string | null {
    if (!page || !doc) return null;
    let mainPath = "/";
    try {
      const u = new URL(doc.meta.sourceUrl);
      mainPath = u.pathname + u.search;
    } catch {
      /* keep */
    }
    if (page === mainPath || page === "/") return null;
    const tail = page.split("?")[0].split("/").filter(Boolean).pop();
    return tail ? decodeURIComponent(tail).replace(/[-_]+/g, " ").slice(0, 28) : null;
  }

  // ---- sidebar -----------------------------------------------------------

  let sidebarTab: "bookmarks" | "highlights" = "bookmarks";

  function renderSidebar(): void {
    sidebar.classList.toggle("open", sidebarOpen);
    if (!sidebarOpen) {
      sidebar.innerHTML = "";
      return;
    }
    sidebar.innerHTML = "";
    const tabs = el(
      "div.sidebar-tabs",
      null,
      el(
        `button.sidebar-tab${sidebarTab === "bookmarks" ? ".active" : ""}`,
        {
          onclick: () => {
            sidebarTab = "bookmarks";
            renderSidebar();
          },
        },
        `Bookmarks (${state.bookmarks.length})`,
      ),
      el(
        `button.sidebar-tab${sidebarTab === "highlights" ? ".active" : ""}`,
        {
          onclick: () => {
            sidebarTab = "highlights";
            renderSidebar();
          },
        },
        `Highlights (${state.highlights.length})`,
      ),
    );
    const list = el("div.sidebar-list");
    const actions =
      sidebarTab === "highlights" && state.highlights.length
        ? el(
            "div.sidebar-actions",
            null,
            el(
              "button.btn.btn-ghost.btn-small",
              {
                onclick: () => {
                  if (doc) void exportAnnotationsFlow(id, doc.meta.title);
                },
              },
              "Export…",
            ),
            el(
              "button.btn.btn-ghost.btn-small",
              { onclick: () => void copyAnnotations(id) },
              "Copy as Markdown",
            ),
          )
        : null;

    if (sidebarTab === "bookmarks") {
      if (!state.bookmarks.length) {
        list.append(el("p.muted.sidebar-empty", null, "No bookmarks yet. Tap the ribbon icon to mark your place."));
      }
      const ordered = [...state.bookmarks].sort(
        (a, b) => (a.page ?? "").localeCompare(b.page ?? "") || a.ratio - b.ratio,
      );
      for (const bm of ordered) {
        list.append(
          el(
            "div.sidebar-item",
            null,
            el(
              "button.sidebar-item-main",
              {
                onclick: () => jumpTo(bm.page ?? currentPage, { ratio: bm.ratio }),
              },
              el("span.sidebar-item-label", null, bm.label),
              el(
                "span.sidebar-item-sub",
                null,
                `${pageLabel(bm.page) ? pageLabel(bm.page) + " · " : ""}${Math.round(bm.ratio * 100)}%`,
              ),
            ),
            el(
              "button.sidebar-item-action",
              {
                title: "Rename",
                onclick: async () => {
                  const label = await promptModal({ title: "Rename bookmark", value: bm.label, confirmText: "Rename" });
                  if (label) {
                    bm.label = label;
                    markDirty();
                    renderSidebar();
                  }
                },
              },
              svgPencil(),
            ),
            el(
              "button.sidebar-item-action",
              {
                title: "Delete bookmark",
                onclick: () => {
                  state.bookmarks = state.bookmarks.filter((b) => b.id !== bm.id);
                  markDirty();
                  renderSidebar();
                },
              },
              svgTrash(),
            ),
          ),
        );
      }
    } else {
      if (!state.highlights.length) {
        list.append(el("p.muted.sidebar-empty", null, "No highlights yet. Select some text in the story to highlight it."));
      }
      for (const hl of state.highlights) {
        const bar = el("span.sidebar-hl-bar");
        bar.style.backgroundColor = HIGHLIGHT_COLORS[hl.color] ?? HIGHLIGHT_COLORS.sun;
        list.append(
          el(
            `div.sidebar-item${hl.orphaned ? ".orphaned" : ""}`,
            null,
            el(
              "button.sidebar-item-main",
              {
                onclick: () => {
                  if (hl.orphaned && (hl.page ?? currentPage) === currentPage) {
                    toast("This highlight's text no longer appears in the document", "error");
                    return;
                  }
                  jumpTo(hl.page ?? currentPage, { highlightId: hl.id });
                },
              },
              bar,
              el("span.sidebar-item-label", null, hl.exact.length > 140 ? `${hl.exact.slice(0, 140)}…` : hl.exact),
            ),
            el(
              "button.sidebar-item-action",
              {
                title: "Delete highlight",
                onclick: () => removeHighlight(hl.id),
              },
              svgTrash(),
            ),
          ),
        );
      }
    }
    sidebar.append(tabs, list);
    if (actions) sidebar.append(actions);
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
        const pos = pageState(currentPage);
        const mine = state.highlights.filter((h) => (h.page ?? currentPage) === currentPage);
        post({
          type: "init",
          state: { scrollY: pos.scrollY, scrollRatio: pos.scrollRatio, docHeight: pos.docHeight },
          highlights: mine.filter((h) => !h.orphaned).concat(mine.filter((h) => h.orphaned)),
        });
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
    renderSidebar();

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

function svgList(): HTMLElement {
  return svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="18" r="1"/>');
}

function svgTrash(): HTMLElement {
  return svg('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>');
}

function svgPencil(): HTMLElement {
  return svg('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>');
}
