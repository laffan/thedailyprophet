import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { appPlatform, importDocument, notebookImport } from "./api";
import { toast } from "./util";
import { mountLibrary } from "./views/library";
import { mountCapture } from "./views/capture";
import { mountReader } from "./views/reader";
import { mountSettings } from "./views/settings";

/** Where to land in a document — a notebook card in another section. */
export interface ReaderJump {
  page: string;
  ratio?: number;
  highlightId?: string;
}

export type Route =
  | { name: "library" }
  | { name: "capture"; url: string; append?: { docId: string; urls: string[] } }
  | { name: "reader"; id: string; jump?: ReaderJump }
  | { name: "settings" };

export interface AppContext {
  navigate: (route: Route) => void;
  /** `"macos"`, `"ios"`, … — resolved before the first view mounts. */
  platform: string;
  /** Capture needs a second webview, which Tauri only embeds on desktop. */
  canCapture: boolean;
}

const root = document.getElementById("app")!;
let cleanup: (() => void) | null = null;
let current: Route = { name: "library" };
let platform = "";

function navigate(route: Route): void {
  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      console.error("view cleanup failed", e);
    }
    cleanup = null;
  }
  current = route;
  root.innerHTML = "";
  root.dataset.view = route.name;
  const ctx: AppContext = {
    navigate,
    platform,
    canCapture: platform !== "ios" && platform !== "android",
  };
  if (route.name === "library") cleanup = mountLibrary(root, ctx);
  else if (route.name === "capture") cleanup = mountCapture(root, ctx, route.url, route.append);
  else if (route.name === "settings") cleanup = mountSettings(root, ctx);
  else cleanup = mountReader(root, ctx, route.id, route.jump);
}

async function init(): Promise<void> {
  // Settled before anything mounts: views that differ by platform (the whole
  // capture section is desktop-only) should render right the first time
  // rather than appear and then retract.
  platform = await appPlatform().catch(() => "");

  // Documents imported out-of-band (file association, dock drop handled by Rust).
  await listen<{ meta: { title: string } }>("library://imported", (e) => {
    toast(`Imported “${e.payload.meta.title}”`);
    if (current.name === "library") navigate({ name: "library" });
  });
  await listen<string>("library://import-error", (e) => {
    toast(`Import failed: ${e.payload}`, "error");
  });
  await listen<number>("notebook://imported", () => {
    toast("Notebook merged into yours");
  });

  // Drag a .prophet or .dailyprophet file anywhere onto the window.
  await getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const paths = event.payload.paths.filter((p) => {
      const lower = p.toLowerCase();
      return (
        lower.endsWith(".prophet") ||
        lower.endsWith(".webarchive") ||
        lower.endsWith(".dailyprophet")
      );
    });
    for (const p of paths) {
      try {
        if (p.toLowerCase().endsWith(".dailyprophet")) {
          // A notebook joins the one already here rather than the shelf.
          const pages = await notebookImport(p);
          toast(pages ? `Notebook merged (${pages} document${pages === 1 ? "" : "s"})` : "Notebook already up to date");
          continue;
        }
        const doc = await importDocument(p);
        toast(`Imported “${doc.meta.title}”`);
      } catch (err) {
        toast(`Import failed: ${err}`, "error");
      }
    }
    if (paths.length && current.name === "library") navigate({ name: "library" });
  });

  navigate({ name: "library" });
}

init().catch((e) => {
  console.error(e);
  navigate({ name: "library" });
});
