import { el, hashString, domainOf } from "./util";
import type { DocSummary } from "./types";

// Curated ink-and-paper palettes for generated covers.
const PALETTES: Array<{ bg: string; bg2: string; ink: string; rule: string }> = [
  { bg: "#2b2117", bg2: "#3d2f20", ink: "#f2e8d5", rule: "#c9a86a" },
  { bg: "#1f2a33", bg2: "#2c3c49", ink: "#e9eef2", rule: "#8fb6cc" },
  { bg: "#33251f", bg2: "#4a362c", ink: "#f4e9dc", rule: "#d99f6c" },
  { bg: "#24301f", bg2: "#33452c", ink: "#ecf2e4", rule: "#a4c48a" },
  { bg: "#31202e", bg2: "#452e41", ink: "#f3e9f1", rule: "#c99bc0" },
  { bg: "#3a2b12", bg2: "#54401e", ink: "#f5edd8", rule: "#d9b45c" },
];

/** Builds a cover element: the snapshot's cover image if present, else a generated "book spine". */
export function coverEl(doc: DocSummary): HTMLElement {
  if (doc.coverDataUri) {
    const c = el("div.cover.cover-image");
    c.style.backgroundImage = `url("${doc.coverDataUri}")`;
    return c;
  }
  const p = PALETTES[hashString(doc.meta.id + doc.meta.title) % PALETTES.length];
  const c = el(
    "div.cover.cover-generated",
    null,
    el("div.cover-rules"),
    el("div.cover-title", null, doc.meta.title || "Untitled"),
    el("div.cover-domain", null, domainOf(doc.meta.sourceUrl)),
  );
  c.style.background = `linear-gradient(160deg, ${p.bg2} 0%, ${p.bg} 70%)`;
  c.style.color = p.ink;
  c.style.setProperty("--cover-rule", p.rule);
  return c;
}
