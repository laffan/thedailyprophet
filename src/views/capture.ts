import type { AppContext } from "../main";
import {
  captureStart,
  captureSetBounds,
  captureControl,
  captureSnapshot,
  type CaptureRect,
} from "../api";
import type { DocSummary } from "../types";
import { el, toast, domainOf } from "../util";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Step = "browse" | "cleanup" | "save" | "working";

/**
 * The capture flow is a modal sheet inside the main window: the page itself
 * renders in a native child webview positioned over `.capture-slot`, and all
 * tools live in the sheet header directly above it. (No separate OS window —
 * this is also the only shape that can work on iPad later.)
 */
export function mountCapture(
  root: HTMLElement,
  ctx: AppContext,
  url: string,
  append?: { docId: string; urls: string[] },
): () => void {
  let step: Step = append ? "working" : "browse";
  let finished = false;
  let started = false;
  let removedCount = 0;
  let includeMode = false;
  let included: Array<{ url: string; label: string }> = [];
  let pageTitle = "";
  let pageUrl = url;
  const unlisteners: UnlistenFn[] = [];

  const stepper = el("ol.stepper.stepper-compact");
  const controls = el("div.capture-controls");
  const pageInfo = el("span.capture-pageinfo", null, `Opening ${domainOf(url)}…`);
  const progressLog = el("ul.progress-log");
  const slot = el(
    "div.capture-slot",
    null,
    el("div.capture-slot-placeholder", null, "Loading page…"),
  );

  const titleInput = el("input.text-input.capture-title-input", {
    type: "text",
    placeholder: "Title for your library",
    spellcheck: false,
  }) as HTMLInputElement;

  const scriptsToggle = el("input", {
    type: "checkbox",
    checked: true,
    id: "opt-scripts",
  }) as HTMLInputElement;

  root.append(
    el(
      "div.capture-modal",
      null,
      el(
        "div.capture-sheet",
        null,
        el(
          "header.capture-sheet-head",
          null,
          el(
            "div.capture-head-row",
            null,
            el("button.btn.btn-ghost.btn-small", { onclick: () => cancel() }, "✕ Cancel"),
            stepper,
            pageInfo,
          ),
          controls,
        ),
        // Ornamental safety band: native webview coordinate drift (e.g. a
        // title-bar offset on some platforms) eats this strip, never the
        // controls above it.
        el("div.capture-divider", null, el("div.capture-divider-rule")),
        slot,
      ),
    ),
  );

  function renderStepper(): void {
    const steps: Array<[Step, string]> = [
      ["browse", "Browse"],
      ["cleanup", "Clean up"],
      ["save", "Save"],
    ];
    stepper.innerHTML = "";
    const activeIdx = step === "working" ? 2 : steps.findIndex(([s]) => s === step);
    steps.forEach(([, label], i) => {
      stepper.append(
        el(
          `li.step${i === activeIdx ? ".active" : ""}${i < activeIdx ? ".done" : ""}`,
          null,
          el("span.step-num", null, String(i + 1)),
          el("span.step-label", null, label),
        ),
      );
    });
  }

  function render(): void {
    renderStepper();
    requestAnimationFrame(() => void sendBounds());
    controls.innerHTML = "";
    if (step === "browse") {
      controls.append(
        el(
          "p.capture-hint",
          null,
          includeMode
            ? "Click any link below to add its page to this document — click again to remove it. Turn picking off to browse normally."
            : "Use the page below like a normal browser: log in, dismiss banners, expand sections, scroll to the end so lazy images load.",
        ),
        el(
          "div.capture-actions",
          null,
          el(
            `button.btn.${includeMode ? "btn-accent" : "btn-ghost"}.btn-small`,
            {
              onclick: () => {
                includeMode = !includeMode;
                render();
                void captureControl(includeMode ? "begin_include" : "end_cleanup").catch((e) =>
                  toast(String(e), "error"),
                );
              },
            },
            includeMode ? "✓ Picking links" : "Include pages…",
          ),
          el(
            "button.btn.btn-ghost.btn-small",
            {
              title: "Add the page currently shown below",
              onclick: () =>
                void captureControl("include_current").catch((e) => toast(String(e), "error")),
            },
            "Add this page",
          ),
          included.length
            ? el(
                "button.btn.btn-ghost.btn-small",
                { onclick: () => void captureControl("clear_included").catch(() => {}) },
                `Clear (${included.length})`,
              )
            : null,
          el("button.btn.btn-primary", { onclick: () => beginCleanup() }, "Continue to clean-up →"),
        ),
      );
      const list = includedList();
      if (list) controls.append(list);
    } else if (step === "cleanup") {
      controls.append(
        el(
          "p.capture-hint",
          null,
          "Hover an element below and click to remove it (sidebars, banners, popups). ",
          el("strong", null, "↑/↓"),
          " grows or shrinks the selection · ",
          el("strong", null, "Z"),
          " undoes.",
        ),
        el(
          "div.capture-actions",
          null,
          el("span.capture-count", null, countText()),
          el(
            "button.btn.btn-ghost.btn-small",
            { onclick: () => void captureControl("undo").then(bumpCountDown) },
            "Undo",
          ),
          el(
            "button.btn.btn-ghost.btn-small",
            {
              onclick: () =>
                void captureControl("restore_all").then(() => {
                  removedCount = 0;
                  updateCount();
                }),
            },
            "Restore all",
          ),
          el("button.btn.btn-primary", { onclick: () => gotoSave() }, "Continue →"),
        ),
      );
    } else if (step === "save") {
      titleInput.value = titleInput.value || pageTitle;
      controls.append(
        el(
          "div.capture-actions",
          null,
          titleInput,
          el(
            "label.check-row.check-row-inline",
            { title: "Keeps scripts and records the page's network data so interactive charts and scrollytelling replay offline exactly as they ran online" },
            scriptsToggle,
            el("span", null, "Keep interactivity"),
          ),
          el("button.btn.btn-ghost.btn-small", { onclick: () => backToCleanup() }, "← Back"),
          el("button.btn.btn-primary", { onclick: () => void snapshot() }, "Create snapshot"),
        ),
      );
    } else {
      controls.append(
        el(
          "div.capture-actions",
          null,
          el("div.spinner.spinner-small"),
          el(
            "span.capture-hint",
            null,
            append
              ? "Adding pages to your document — loading each one so its scripts and data come along…"
              : "Building your snapshot — inlining styles, images and fonts…",
          ),
        ),
        progressLog,
      );
    }
  }

  /** The pages queued to travel with this document. */
  function includedList(): HTMLElement | null {
    if (!included.length) return null;
    return el(
      "ul.included-list",
      null,
      ...included.map((p) =>
        el(
          "li.included-item",
          { title: p.url },
          el("span.included-dot"),
          el("span.included-label", null, p.label || p.url),
        ),
      ),
    );
  }

  function countText(): string {
    return removedCount === 0
      ? "Nothing removed yet."
      : `${removedCount} element${removedCount === 1 ? "" : "s"} removed.`;
  }

  function updateCount(): void {
    const n = controls.querySelector(".capture-count");
    if (n) n.textContent = countText();
  }

  function bumpCountDown(): void {
    removedCount = Math.max(0, removedCount - 1);
    updateCount();
  }

  function beginCleanup(): void {
    step = "cleanup";
    render();
    void captureControl("begin_cleanup").catch((e) => toast(String(e), "error"));
  }

  function backToCleanup(): void {
    step = "cleanup";
    render();
    void captureControl("begin_cleanup").catch((e) => toast(String(e), "error"));
  }

  function gotoSave(): void {
    step = "save";
    render();
    void captureControl("end_cleanup").catch((e) => toast(String(e), "error"));
  }

  async function snapshot(): Promise<void> {
    step = "working";
    progressLog.innerHTML = "";
    render();
    try {
      await captureSnapshot({
        includeScripts: scriptsToggle.checked,
        title: titleInput.value.trim() || pageTitle || domainOf(pageUrl),
      });
    } catch (e) {
      toast(`Snapshot failed to start: ${e}`, "error");
      step = "save";
      render();
    }
  }

  function cancel(): void {
    if (finished) return;
    finished = true;
    void captureControl("cancel").catch(() => {});
    ctx.navigate({ name: "library" });
  }

  // ---- child webview geometry ---------------------------------------------

  function slotRect(): CaptureRect {
    const r = slot.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  // If the native layer places the webview at an offset from what we asked
  // for (readback tells us), compensate on subsequent calls.
  const comp = { dx: 0, dy: 0, rounds: 0 };

  async function sendBounds(): Promise<void> {
    if (!started || finished) return;
    const r = slotRect();
    if (r.width < 2 || r.height < 2) return;
    const want = { x: r.x + comp.dx, y: r.y + comp.dy, width: r.width, height: r.height };
    try {
      const actual = await captureSetBounds(want);
      if (actual && comp.rounds < 3) {
        const dx = want.x - actual.x;
        const dy = want.y - actual.y;
        if ((Math.abs(dx) > 2 || Math.abs(dy) > 2) && Math.abs(dx) <= 150 && Math.abs(dy) <= 150) {
          comp.dx += dx;
          comp.dy += dy;
          comp.rounds++;
          await captureSetBounds({ x: r.x + comp.dx, y: r.y + comp.dy, width: r.width, height: r.height });
        }
      }
    } catch {
      // capture view not open (yet / anymore)
    }
  }

  const resizeObserver = new ResizeObserver(() => void sendBounds());
  resizeObserver.observe(slot);
  const onWindowResize = () => void sendBounds();
  window.addEventListener("resize", onWindowResize);

  // ---- events ---------------------------------------------------------------

  async function wire(): Promise<void> {
    unlisteners.push(
      await listen<{ title: string; url: string }>("capture://page", (e) => {
        const navigated = e.payload.url !== pageUrl;
        pageTitle = e.payload.title;
        pageUrl = e.payload.url;
        pageInfo.textContent = `${e.payload.title || "Untitled"} — ${domainOf(e.payload.url)}`;
        // The page reports on DOMContentLoaded *and* load; only a real
        // navigation resets the injected clean-up state.
        if (step === "cleanup" && navigated) {
          removedCount = 0;
          updateCount();
          void captureControl("begin_cleanup").catch(() => {});
        }
        if (step === "browse" && navigated && includeMode) {
          void captureControl("begin_include").catch(() => {});
        }
      }),
      await listen<Array<{ url: string; label: string }>>("capture://included", (e) => {
        included = e.payload || [];
        if (step === "browse") render();
      }),
      await listen<number>("capture://count", (e) => {
        removedCount = e.payload;
        updateCount();
      }),
      await listen<{ stage: string; detail?: string }>("capture://progress", (e) => {
        const line = e.payload.detail ? `${e.payload.stage} — ${e.payload.detail}` : e.payload.stage;
        progressLog.append(el("li", null, line));
        progressLog.scrollTop = progressLog.scrollHeight;
      }),
      await listen<DocSummary>("capture://done", (e) => {
        finished = true;
        toast(`“${e.payload.meta.title}” added to your library`);
        ctx.navigate({ name: "reader", id: e.payload.meta.id });
      }),
      await listen<string>("capture://error", (e) => {
        toast(`Capture failed: ${e.payload}`, "error");
        if (step === "working") {
          step = "save";
          render();
        }
      }),
      await listen<number>("capture://appended", () => {
        finished = true;
        toast("Document updated");
        if (append) ctx.navigate({ name: "reader", id: append.docId });
      }),
      await listen("capture://closed", () => {
        if (!finished) {
          finished = true;
          toast("Capture cancelled");
          ctx.navigate({ name: "library" });
        }
      }),
    );

    // Let the sheet lay out once so the slot has real dimensions.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    try {
      await captureStart(url, slotRect());
      started = true;
      if (append) {
        // Give the page a moment to establish its session before harvesting.
        window.setTimeout(() => {
          void captureControl("end_cleanup").catch(() => {});
          void import("../api").then((api) =>
            api.captureAppendPages(append.docId, append.urls).catch((e) => {
              toast(`Could not add pages: ${e}`, "error");
            }),
          );
        }, 2500);
      }
      // Re-broadcast a few times: layout can settle late (fonts, first
      // paint) and the initial native placement may need correcting.
      void sendBounds();
      for (const delay of [250, 750, 1500]) {
        window.setTimeout(() => void sendBounds(), delay);
      }
    } catch (e) {
      toast(`Could not open capture view: ${e}`, "error");
      finished = true;
      ctx.navigate({ name: "library" });
    }
  }

  render();
  void wire();

  return () => {
    resizeObserver.disconnect();
    window.removeEventListener("resize", onWindowResize);
    for (const u of unlisteners) u();
    if (!finished) {
      finished = true;
      void captureControl("cancel").catch(() => {});
    }
  };
}
