import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { importDocument } from "./api";
import { toast } from "./util";
import { mountLibrary } from "./views/library";
import { mountCapture } from "./views/capture";
import { mountReader } from "./views/reader";
import { mountSettings } from "./views/settings";

export type Route =
  | { name: "library" }
  | { name: "capture"; url: string }
  | { name: "reader"; id: string }
  | { name: "settings" };

export interface AppContext {
  navigate: (route: Route) => void;
}

const root = document.getElementById("app")!;
let cleanup: (() => void) | null = null;
let current: Route = { name: "library" };

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
  const ctx: AppContext = { navigate };
  if (route.name === "library") cleanup = mountLibrary(root, ctx);
  else if (route.name === "capture") cleanup = mountCapture(root, ctx, route.url);
  else if (route.name === "settings") cleanup = mountSettings(root, ctx);
  else cleanup = mountReader(root, ctx, route.id);
}

async function init(): Promise<void> {
  // Documents imported out-of-band (file association, dock drop handled by Rust).
  await listen<{ meta: { title: string } }>("library://imported", (e) => {
    toast(`Imported “${e.payload.meta.title}”`);
    if (current.name === "library") navigate({ name: "library" });
  });
  await listen<string>("library://import-error", (e) => {
    toast(`Import failed: ${e.payload}`, "error");
  });

  // Drag a .prophet file anywhere onto the window to import it.
  await getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const paths = event.payload.paths.filter((p) =>
      p.toLowerCase().endsWith(".prophet") || p.toLowerCase().endsWith(".webarchive"),
    );
    for (const p of paths) {
      try {
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
