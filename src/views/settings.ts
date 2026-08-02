import type { AppContext } from "../main";
import {
  getSettings,
  setSettings,
  syncNow,
  defaultSyncFolder,
  appPlatform,
  type Settings,
} from "../api";
import { el, toast, fmtDate } from "../util";
import { confirmModal } from "../modal";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export function mountSettings(root: HTMLElement, ctx: AppContext): () => void {
  let disposed = false;
  let settings: Settings = { syncFolder: null, autoSync: false, lastSyncAt: 0 };
  let platform = "";
  let busy = false;

  const body = el("div.settings-body", null, el("p.muted", null, "Loading…"));

  root.append(
    el(
      "div.settings-view",
      null,
      el(
        "header.settings-head",
        null,
        el(
          "button.btn.btn-ghost.btn-small",
          { onclick: () => ctx.navigate({ name: "library" }) },
          "← Library",
        ),
        el("h2", null, "Settings"),
        el("span.settings-head-spacer"),
      ),
      body,
    ),
  );

  function isMobile(): boolean {
    return platform === "ios" || platform === "android";
  }

  async function save(next: Partial<Settings>): Promise<void> {
    try {
      settings = await setSettings({ ...settings, ...next });
      render();
    } catch (e) {
      toast(String(e), "error");
    }
  }

  /**
   * Always the user's choice — a sync folder is only useful if they point it
   * at something that actually syncs (iCloud Drive, Dropbox, a share).
   */
  async function chooseFolder(): Promise<void> {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      await save({ syncFolder: picked });
      return;
    } catch (e) {
      if (!isMobile()) {
        toast(`Could not open the folder picker: ${e}`, "error");
        return;
      }
      // iOS has no folder picker in Tauri's dialog plugin yet.
      toast("Choosing any folder isn't available on this device yet", "error");
    }
  }

  /** The explicit fallback on iPadOS — chosen deliberately, never automatic. */
  async function useAppFolder(): Promise<void> {
    const ok = await confirmModal({
      title: "Use this app's Files folder?",
      body:
        "The Daily Prophet can only reach its own folder on this device. It appears in the Files app under “On My iPad → The Daily Prophet”, and you can move or copy it into iCloud Drive from there to share it with your Mac. This is not the same as picking an iCloud folder directly.",
      confirmText: "Use it",
    });
    if (!ok) return;
    try {
      const folder = await defaultSyncFolder();
      await save({ syncFolder: folder });
      toast("Sync folder set — find it in the Files app");
    } catch (e) {
      toast(`Could not set the folder: ${e}`, "error");
    }
  }

  async function runSync(): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      const r = await syncNow();
      const parts: string[] = [];
      if (r.pulled) parts.push(`${r.pulled} added`);
      if (r.pushed) parts.push(`${r.pushed} copied out`);
      if (r.merged) parts.push(`${r.merged} annotation set${r.merged === 1 ? "" : "s"} merged`);
      toast(parts.length ? `Synced — ${parts.join(", ")}` : "Already up to date");
      if (r.errors.length) {
        toast(`${r.errors.length} item(s) had problems: ${r.errors[0]}`, "error");
      }
      settings = await getSettings();
    } catch (e) {
      toast(`Sync failed: ${e}`, "error");
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  function render(): void {
    if (disposed) return;
    body.innerHTML = "";

    const folder = settings.syncFolder;
    const autoToggle = el("input", {
      type: "checkbox",
      checked: settings.autoSync,
      disabled: !folder,
      onchange: (e: Event) => void save({ autoSync: (e.target as HTMLInputElement).checked }),
    });

    body.append(
      el(
        "section.settings-card",
        null,
        el("h3.settings-title", null, "Shared folder"),
        el(
          "p.settings-desc",
          null,
          "Keep this library in step with your other devices by pointing them all at the same folder — an iCloud Drive, Dropbox or network folder works well. Documents are copied there, anything new found there is added here, and highlights and bookmarks made on different devices are merged rather than overwritten.",
        ),
        folder
          ? el(
              "div.settings-folder",
              null,
              el("code.settings-path", { title: folder }, folder),
              el(
                "div.settings-folder-actions",
                null,
                el(
                  "button.btn.btn-ghost.btn-small",
                  { onclick: () => void chooseFolder() },
                  "Change…",
                ),
                el(
                  "button.btn.btn-ghost.btn-small",
                  { onclick: () => void save({ syncFolder: null, autoSync: false }) },
                  "Stop syncing",
                ),
              ),
            )
          : el(
              "div.settings-folder-actions",
              null,
              el(
                "button.btn.btn-primary",
                { onclick: () => void chooseFolder() },
                "Choose a folder…",
              ),
              isMobile()
                ? el(
                    "button.btn.btn-ghost",
                    { onclick: () => void useAppFolder() },
                    "Use this app's Files folder",
                  )
                : null,
            ),
        folder
          ? el(
              "label.check-row.settings-check",
              null,
              autoToggle,
              el("span", null, "Sync automatically after capturing or importing"),
            )
          : null,
        folder
          ? el(
              "div.settings-sync-row",
              null,
              el(
                `button.btn.btn-primary${busy ? ".is-busy" : ""}`,
                { onclick: () => void runSync(), disabled: busy },
                busy ? "Syncing…" : "Sync now",
              ),
              el(
                "span.muted.settings-when",
                null,
                settings.lastSyncAt
                  ? `Last synced ${fmtDate(settings.lastSyncAt)}`
                  : "Not synced yet",
              ),
            )
          : null,
        isMobile()
          ? el(
              "p.settings-note",
              null,
              "Picking any folder you like needs a system folder picker that Tauri's iOS plugin doesn't offer yet, so on iPadOS the app can currently only sync its own Files folder. Pick the folder you want on your Mac; on iPad, use the button above and move that folder into iCloud Drive from the Files app.",
            )
          : null,
      ),
      el(
        "section.settings-card",
        null,
        el("h3.settings-title", null, "About"),
        el(
          "p.settings-desc",
          null,
          "The Daily Prophet keeps interactive articles readable offline, exactly as they behaved online. Documents are stored as resource archives and served locally, so nothing you read reaches the network.",
        ),
      ),
    );
  }

  void (async () => {
    try {
      [settings, platform] = await Promise.all([getSettings(), appPlatform()]);
    } catch (e) {
      toast(`Could not load settings: ${e}`, "error");
    }
    render();
  })();

  return () => {
    disposed = true;
  };
}
