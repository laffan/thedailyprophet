import type { AppContext } from "../main";
import {
  listDocuments,
  deleteDocument,
  renameDocument,
  exportDocument,
  importDocument,
  appPlatform,
} from "../api";
import type { DocSummary } from "../types";
import { el, toast, fmtDate, fmtBytes, domainOf } from "../util";
import { coverEl } from "../covers";
import { promptModal, confirmModal } from "../modal";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { exportAnnotationsFlow } from "../annotations";

export function mountLibrary(root: HTMLElement, ctx: AppContext): () => void {
  let disposed = false;
  let openMenu: HTMLElement | null = null;

  const closeMenu = () => {
    openMenu?.remove();
    openMenu = null;
  };
  const onGlobalClick = () => closeMenu();
  window.addEventListener("click", onGlobalClick);

  const urlInput = el("input.capture-input", {
    type: "text",
    placeholder: "Paste the address of a story to capture…",
    spellcheck: false,
    autocapitalize: "off",
    autocorrect: "off",
  }) as HTMLInputElement;

  const startCapture = () => {
    const raw = urlInput.value.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        toast("Only http(s) pages can be captured", "error");
        return;
      }
    } catch {
      toast("That doesn't look like a valid address", "error");
      return;
    }
    ctx.navigate({ name: "capture", url });
  };
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startCapture();
  });

  const settingsBtn = el(
    "button.icon-btn",
    { title: "Settings", onclick: () => ctx.navigate({ name: "settings" }) },
    gearIcon(),
  );

  const shelf = el("div.shelf", null, el("p.muted", null, "Loading library…"));

  const importBtn = el(
    "button.icon-btn",
    {
      title: "Import a .prophet or .webarchive file",
      onclick: async () => {
        const picked = await openDialog({
          multiple: true,
          filters: [
            { name: "Readable documents", extensions: ["prophet", "webarchive"] },
            { name: "Daily Prophet Document", extensions: ["prophet"] },
            { name: "Safari Web Archive", extensions: ["webarchive"] },
          ],
        });
        if (!picked) return;
        const paths = Array.isArray(picked) ? picked : [picked];
        for (const p of paths) {
          try {
            const doc = await importDocument(p);
            toast(`Imported “${doc.meta.title}”`);
          } catch (err) {
            toast(`Import failed: ${err}`, "error");
          }
        }
        void refresh();
      },
    },
    importIcon(),
  );

  root.append(
    el(
      "header.masthead",
      null,
      el(
        "div.capture-bar",
        null,
        urlInput,
        el("button.btn.btn-primary", { onclick: startCapture }, "Capture"),
        el("div.masthead-actions", null, importBtn, settingsBtn),
      ),
      el("div.masthead-rule"),
    ),
    shelf,
  );

  async function refresh(): Promise<void> {
    let docs: DocSummary[];
    try {
      docs = await listDocuments();
    } catch (err) {
      if (!disposed) {
        shelf.innerHTML = "";
        shelf.append(el("p.muted", null, `Could not load the library: ${err}`));
      }
      return;
    }
    if (disposed) return;

    docs.sort((a, b) => {
      const ka = a.state?.lastOpenedAt || a.meta.createdAt;
      const kb = b.state?.lastOpenedAt || b.meta.createdAt;
      return kb - ka;
    });

    shelf.innerHTML = "";
    if (!docs.length) {
      shelf.append(
        el(
          "div.empty-state",
          null,
          el("h2", null, "Your shelf is empty"),
          el(
            "p",
            null,
            "Paste a link above to capture your first story, or drop a .prophet file anywhere in this window.",
          ),
        ),
      );
      return;
    }

    const grid = el("div.shelf-grid");
    for (const doc of docs) grid.append(card(doc));
    shelf.append(grid);
  }

  function card(doc: DocSummary): HTMLElement {
    const progress = doc.state?.progress ?? 0;
    const pct = Math.round(progress * 100);

    const menuBtn = el(
      "button.card-menu-btn",
      {
        title: "More",
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          if (openMenu) {
            closeMenu();
            return;
          }
          const menu = el(
            "div.card-menu",
            { onclick: (ev: MouseEvent) => ev.stopPropagation() },
            menuItem("Continue reading", () => ctx.navigate({ name: "reader", id: doc.meta.id })),
            menuItem("Rename…", async () => {
              closeMenu();
              const title = await promptModal({
                title: "Rename document",
                value: doc.meta.title,
                confirmText: "Rename",
              });
              if (title && title !== doc.meta.title) {
                await renameDocument(doc.meta.id, title);
                void refresh();
              }
            }),
            menuItem("Export document…", async () => {
              closeMenu();
              await exportFlow(doc);
            }),
            menuItem(
              `Export highlights${hlCount(doc) ? ` (${hlCount(doc)})` : ""}…`,
              async () => {
                closeMenu();
                await exportAnnotationsFlow(doc.meta.id, doc.meta.title);
              },
            ),
            menuItem("Delete", async () => {
              closeMenu();
              const ok = await confirmModal({
                title: `Delete “${doc.meta.title}”?`,
                body: "The snapshot, bookmarks and highlights will be removed. This cannot be undone.",
                confirmText: "Delete",
                danger: true,
              });
              if (ok) {
                await deleteDocument(doc.meta.id);
                toast("Deleted");
                void refresh();
              }
            }, true),
          );
          (menuBtn.parentElement as HTMLElement).append(menu);
          openMenu = menu;
        },
      },
      "⋯",
    );

    const coverWrap = el(
      "div.cover-wrap",
      { onclick: () => ctx.navigate({ name: "reader", id: doc.meta.id }) },
      coverEl(doc),
      menuBtn,
      pct > 0 ? el("div.cover-progress", null, el("div.cover-progress-fill", { style: undefined })) : null,
    );
    const fill = coverWrap.querySelector(".cover-progress-fill") as HTMLElement | null;
    if (fill) fill.style.width = `${Math.max(3, pct)}%`;

    return el(
      "article.book-card",
      null,
      coverWrap,
      el("h3.book-title", { title: doc.meta.title, onclick: () => ctx.navigate({ name: "reader", id: doc.meta.id }) }, doc.meta.title),
      el(
        "p.book-sub",
        null,
        `${domainOf(doc.meta.sourceUrl)} · ${pct > 0 ? `${pct}%` : "new"} · ${fmtDate(doc.meta.createdAt)} · ${fmtBytes(doc.meta.sizeBytes)}`,
      ),
    );
  }

  function hlCount(doc: DocSummary): number {
    return doc.state?.highlights?.length ?? 0;
  }

  function importIcon(): HTMLElement {
    return iconEl(
      '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/>' +
        '<path d="M5 21h14a1 1 0 0 0 1-1v-4"/><path d="M4 16v4a1 1 0 0 0 1 1"/>',
    );
  }

  function iconEl(paths: string): HTMLElement {
    const span = document.createElement("span");
    span.className = "svg-icon";
    span.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths +
      "</svg>";
    return span;
  }

  function gearIcon(): HTMLElement {
    return iconEl(
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    );
  }

  function menuItem(label: string, action: () => void, danger = false): HTMLElement {
    return el(
      `button.card-menu-item${danger ? ".danger" : ""}`,
      { onclick: action },
      label,
    );
  }

  async function exportFlow(doc: DocSummary): Promise<void> {
    const safe = doc.meta.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "document";
    const dest = await saveDialog({
      defaultPath: `${safe}.prophet`,
      filters: [{ name: "Daily Prophet Document", extensions: ["prophet"] }],
    });
    if (!dest) return;
    try {
      await exportDocument(doc.meta.id, dest);
      toast("Exported — share the .prophet file with any Daily Prophet reader");
    } catch (err) {
      toast(`Export failed: ${err}`, "error");
    }
  }

  void refresh();
  // On iPadOS the capture flow (separate browse window) is not available in v1.
  void appPlatform().then((p) => {
    if (p === "ios" && !disposed) {
      urlInput.disabled = true;
      urlInput.placeholder = "Capture is desktop-only for now — import .prophet files here";
    }
  });

  return () => {
    disposed = true;
    closeMenu();
    window.removeEventListener("click", onGlobalClick);
  };
}
