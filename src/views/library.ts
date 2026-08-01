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

  const captureBar = el(
    "div.capture-bar",
    null,
    urlInput,
    el("button.btn.btn-primary", { onclick: startCapture }, "Capture"),
  );

  const shelf = el("div.shelf", null, el("p.muted", null, "Loading library…"));

  const importBtn = el(
    "button.btn.btn-ghost",
    {
      onclick: async () => {
        const picked = await openDialog({
          multiple: true,
          filters: [{ name: "Daily Prophet Document", extensions: ["prophet"] }],
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
    "Import…",
  );

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  root.append(
    el(
      "header.masthead",
      null,
      el("div.masthead-row", null, el("div.masthead-spacer"), el("h1.masthead-title", null, "The Daily Prophet"), el("div.masthead-actions", null, importBtn)),
      el("p.masthead-sub", null, `${today} — captured stories, readable forever`),
      el("div.masthead-rule"),
    ),
    el("section.capture-section", null, captureBar),
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
            menuItem("Export…", async () => {
              closeMenu();
              await exportFlow(doc);
            }),
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
