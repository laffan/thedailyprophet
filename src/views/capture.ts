import type { AppContext } from "../main";
import { captureStart, captureControl, captureSnapshot } from "../api";
import type { DocSummary } from "../types";
import { el, toast, domainOf } from "../util";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Step = "browse" | "cleanup" | "save" | "working";

export function mountCapture(root: HTMLElement, ctx: AppContext, url: string): () => void {
  let step: Step = "browse";
  let finished = false;
  let removedCount = 0;
  let pageTitle = "";
  let pageUrl = url;
  const unlisteners: UnlistenFn[] = [];

  const stepper = el("ol.stepper");
  const panel = el("div.capture-panel");
  const pageInfo = el("p.capture-pageinfo", null, `Opening ${domainOf(url)}…`);
  const progressLog = el("ul.progress-log");

  const titleInput = el("input.text-input", {
    type: "text",
    placeholder: "Title for your library",
    spellcheck: false,
  }) as HTMLInputElement;

  const scriptsToggle = el("input", { type: "checkbox", checked: true, id: "opt-scripts" }) as HTMLInputElement;

  root.append(
    el(
      "div.capture-view",
      null,
      el(
        "header.capture-header",
        null,
        el("button.btn.btn-ghost", { onclick: () => cancel() }, "← Cancel"),
        el("h2", null, "Capture a story"),
        el("span.capture-header-spacer"),
      ),
      pageInfo,
      stepper,
      panel,
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
    panel.innerHTML = "";
    if (step === "browse") {
      panel.append(
        el("h3.panel-title", null, "Prepare the page"),
        el(
          "p.panel-body",
          null,
          "A capture window has opened next to this one. Use it like a normal browser: log in if the story is behind a paywall, dismiss cookie banners, expand collapsed sections, and scroll to the end so lazy-loaded images appear.",
        ),
        el(
          "p.panel-body.muted",
          null,
          "When the page looks the way you want to keep it, continue to clean-up.",
        ),
        el(
          "div.panel-actions",
          null,
          el("button.btn.btn-primary", { onclick: () => beginCleanup() }, "Continue to clean-up →"),
        ),
      );
    } else if (step === "cleanup") {
      panel.append(
        el("h3.panel-title", null, "Remove the clutter"),
        el(
          "p.panel-body",
          null,
          "In the capture window, hover over any element to outline it, then click to remove it. Sidebars, banners, newsletter boxes — anything you don't want in the snapshot.",
        ),
        el(
          "ul.panel-hints",
          null,
          el("li", null, "↑ / ↓ arrows grow or shrink the selection (child ↔ parent)"),
          el("li", null, "Z undoes the last removal"),
        ),
        el("p.panel-count", null, countText()),
        el(
          "div.panel-actions",
          null,
          el("button.btn.btn-ghost", { onclick: () => void captureControl("undo").then(bumpCountDown) }, "Undo"),
          el(
            "button.btn.btn-ghost",
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
      panel.append(
        el("h3.panel-title", null, "Create the snapshot"),
        el("label.field-label", { for: "cap-title" }, "Title"),
        titleInput,
        el(
          "label.check-row",
          null,
          scriptsToggle,
          el(
            "span",
            null,
            "Keep page scripts (interactive charts and scrollytelling keep working; occasionally a script that needs the network will misbehave offline)",
          ),
        ),
        el(
          "div.panel-actions",
          null,
          el("button.btn.btn-ghost", { onclick: () => backToCleanup() }, "← Back"),
          el("button.btn.btn-primary", { onclick: () => void snapshot() }, "Create snapshot"),
        ),
      );
    } else {
      panel.append(
        el("h3.panel-title", null, "Building your snapshot…"),
        el(
          "p.panel-body.muted",
          null,
          "Inlining styles, images and fonts so the story reads perfectly offline. Big pages can take a minute.",
        ),
        el("div.spinner"),
        progressLog,
      );
    }
  }

  function countText(): string {
    return removedCount === 0
      ? "Nothing removed yet."
      : `${removedCount} element${removedCount === 1 ? "" : "s"} removed.`;
  }

  function updateCount(): void {
    const n = panel.querySelector(".panel-count");
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
    finished = true;
    void captureControl("cancel").catch(() => {});
    ctx.navigate({ name: "library" });
  }

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
      await listen("capture://closed", () => {
        if (!finished) {
          toast("Capture window closed — capture cancelled");
          ctx.navigate({ name: "library" });
        }
      }),
    );

    try {
      await captureStart(url);
    } catch (e) {
      toast(`Could not open capture window: ${e}`, "error");
      ctx.navigate({ name: "library" });
      return;
    }
  }

  render();
  void wire();

  return () => {
    finished = true;
    for (const u of unlisteners) u();
  };
}
