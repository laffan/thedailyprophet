import { invoke } from "@tauri-apps/api/core";
import type { DocState, DocSummary, NotebookEntry } from "./types";

export function listDocuments(): Promise<DocSummary[]> {
  return invoke("list_documents");
}

export function getDocument(id: string): Promise<DocSummary> {
  return invoke("get_document", { id });
}

export function getDocumentHtml(id: string): Promise<string> {
  return invoke("get_document_html", { id });
}

export function saveState(id: string, state: DocState): Promise<void> {
  return invoke("save_state", { id, state });
}

export function renameDocument(id: string, title: string): Promise<void> {
  return invoke("rename_document", { id, title });
}

export function deleteDocument(id: string): Promise<void> {
  return invoke("delete_document", { id });
}

export function exportDocument(id: string, dest: string): Promise<string> {
  return invoke("export_document", { id, dest });
}

export function importDocument(path: string): Promise<DocSummary> {
  return invoke("import_document", { path });
}

export function appPlatform(): Promise<string> {
  return invoke("platform");
}

// ---- capture flow ------------------------------------------------------

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function captureStart(url: string, rect: CaptureRect): Promise<void> {
  return invoke("capture_start", { url, ...rect });
}

/** Returns the bounds the webview actually got (for drift compensation). */
export function captureSetBounds(rect: CaptureRect): Promise<CaptureRect | null> {
  return invoke("capture_set_bounds", { ...rect });
}

export type CaptureAction =
  | "begin_cleanup"
  | "end_cleanup"
  | "begin_include"
  | "include_current"
  | "clear_included"
  | "undo"
  | "restore_all"
  | "cancel";

export function captureControl(action: CaptureAction): Promise<void> {
  return invoke("capture_control", { action, options: null });
}

export function captureSnapshot(options: {
  includeScripts: boolean;
  title: string;
}): Promise<void> {
  return invoke("capture_control", { action: "snapshot", options });
}

// ---- settings & folder sync -------------------------------------------

export interface Settings {
  syncFolder: string | null;
  /** iOS security-scoped bookmark that re-grants access after a relaunch. */
  syncBookmark?: string | null;
  autoSync: boolean;
  lastSyncAt: number;
}

/**
 * iOS folder access, via the bundled icloud-folder plugin. Sandboxed apps
 * cannot keep a chosen folder by path alone: picking mints a bookmark, and
 * resolving it re-acquires security-scoped access on later launches.
 */
export function iosPickFolder(): Promise<{ path: string; bookmark: string; name?: string }> {
  return invoke("plugin:icloud-folder|pick_folder");
}

export function iosResolveBookmark(bookmark: string): Promise<{ path: string; stale?: boolean }> {
  return invoke("plugin:icloud-folder|resolve_bookmark", { bookmark });
}

/**
 * Pulls a folder's documents down from iCloud. Files that live only in the
 * cloud appear as hidden placeholders that ordinary directory reads skip, so
 * without this a freshly chosen iCloud folder looks empty.
 */
export function iosMaterializeFolder(
  path: string,
  suffix = ".prophet",
  timeoutMs = 90000,
): Promise<{ requested: number; downloaded: number; stillPending: number }> {
  return invoke("plugin:icloud-folder|materialize_folder", { path, suffix, timeoutMs });
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  merged: number;
  /** Reading-state sidecars written (small, frequent). */
  states: number;
  /** Notebook pages taken from the folder, and whether ours went out. */
  notebookMerged: number;
  notebookPushed: boolean;
  unchanged: number;
  errors: string[];
  folder: string;
}

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export function setSettings(settings: Settings): Promise<Settings> {
  return invoke("set_settings", { settings });
}

export function syncNow(): Promise<SyncReport> {
  return invoke("sync_now");
}

/** Where documents go when the platform can't offer a folder picker (iOS). */
export function defaultSyncFolder(): Promise<string> {
  return invoke("default_sync_folder");
}

// ---- annotations ------------------------------------------------------

export type AnnotationFormat = "markdown" | "json" | "csv" | "txt";

export function renderAnnotations(id: string, format: AnnotationFormat): Promise<string> {
  return invoke("render_annotations", { id, format });
}

export function exportAnnotations(
  id: string,
  dest: string,
  format: AnnotationFormat,
): Promise<string> {
  return invoke("export_annotations", { id, dest, format });
}

// ---- post-capture editing ---------------------------------------------

/** Persists the elements removed from a page; returns the new total. */
export function editSetRemovals(
  id: string,
  page: string,
  selectors: string[],
  replace = false,
): Promise<number> {
  return invoke("edit_set_removals", { id, page, selectors, replace });
}

export function editClearRemovals(id: string): Promise<void> {
  return invoke("edit_clear_removals", { id });
}

export function captureAppendPages(docId: string, urls: string[]): Promise<void> {
  return invoke("capture_control", { action: "append_pages", options: { docId, urls } });
}

// ---- the reading notebook ----------------------------------------------

export interface NotebookDocFile {
  docId: string;
  title: string;
  sourceUrl: string;
  collapsed: boolean;
  updatedAt: number;
  entries: NotebookEntry[];
}

export function notebookLoad(): Promise<NotebookDocFile[]> {
  return invoke("notebook_load");
}

export function notebookSaveDoc(doc: NotebookDocFile): Promise<void> {
  return invoke("notebook_save_doc", { doc });
}

/** `data` is the base64 body of a PNG data URL. Returns its size in bytes. */
export function notebookPutSnapshot(entryId: string, data: string): Promise<number> {
  return invoke("notebook_put_snapshot", { entryId, data });
}

export function notebookSnapshot(entryId: string): Promise<string | null> {
  return invoke("notebook_snapshot", { entryId });
}

export function notebookDeleteSnapshot(entryId: string): Promise<void> {
  return invoke("notebook_delete_snapshot", { entryId });
}

export function notebookExport(dest: string): Promise<string> {
  return invoke("notebook_export", { dest });
}

/** Merges another notebook in; returns how many document pages changed. */
export function notebookImport(path: string): Promise<number> {
  return invoke("notebook_import", { path });
}
