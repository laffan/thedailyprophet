import { invoke } from "@tauri-apps/api/core";
import type { DocState, DocSummary } from "./types";

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

export function captureSetBounds(rect: CaptureRect): Promise<void> {
  return invoke("capture_set_bounds", { ...rect });
}

export type CaptureAction =
  | "begin_cleanup"
  | "end_cleanup"
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
