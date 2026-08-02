import { exportAnnotations, renderAnnotations, type AnnotationFormat } from "./api";
import { toast } from "./util";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

const FORMATS: Array<{ ext: string; format: AnnotationFormat; name: string }> = [
  { ext: "md", format: "markdown", name: "Markdown" },
  { ext: "json", format: "json", name: "JSON" },
  { ext: "csv", format: "csv", name: "CSV (spreadsheet)" },
  { ext: "txt", format: "txt", name: "Plain text" },
];

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "annotations";
}

/**
 * Save a document's highlights and bookmarks. The chosen file extension
 * picks the format, so it's one dialog rather than two prompts.
 */
export async function exportAnnotationsFlow(id: string, title: string): Promise<void> {
  const dest = await saveDialog({
    defaultPath: `${safeName(title)} — highlights.md`,
    filters: FORMATS.map((f) => ({ name: f.name, extensions: [f.ext] })),
  });
  if (!dest) return;
  const ext = dest.split(".").pop()?.toLowerCase() ?? "md";
  const format = FORMATS.find((f) => f.ext === ext)?.format ?? "markdown";
  try {
    await exportAnnotations(id, dest, format);
    toast("Highlights exported");
  } catch (e) {
    toast(`Export failed: ${e}`, "error");
  }
}

/** Copies the annotations to the clipboard as Markdown. */
export async function copyAnnotations(id: string): Promise<void> {
  try {
    const text = await renderAnnotations(id, "markdown");
    await navigator.clipboard.writeText(text);
    toast("Highlights copied as Markdown");
  } catch (e) {
    toast(`Could not copy: ${e}`, "error");
  }
}
