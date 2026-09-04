/**
 * The notebook's markdown editor.
 *
 * Notes are markdown, and they are styled where they are typed rather than in
 * a separate preview: headings grow, emphasis leans, links and code change
 * colour, all while the source stays visible and editable. CodeMirror's
 * markdown grammar does the parsing; everything below is presentation.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

const markdownStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.32em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.18em", fontWeight: "700", lineHeight: "1.3" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--ink-soft)" },
  { tag: [t.monospace, t.labelName], fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { tag: t.quote, color: "var(--ink-soft)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent)" },
  { tag: t.contentSeparator, color: "var(--rule-strong)" },
  // The markup itself — the #, the *, the backticks — stays visible but
  // recedes, so the text reads as prose while remaining plain markdown.
  { tag: t.processingInstruction, color: "var(--rule-strong)" },
]);

const theme = EditorView.theme({
  "&": {
    fontSize: "13px",
    color: "var(--ink)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "var(--sans)",
    padding: "6px 0",
    lineHeight: "1.5",
    caretColor: "var(--ink)",
  },
  ".cm-line": { padding: "0" },
  ".cm-scroller": { fontFamily: "var(--sans)", lineHeight: "1.5" },
  ".cm-placeholder": { color: "var(--ink-soft)", fontStyle: "italic" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgba(122, 46, 29, 0.22)",
  },
});

export interface NoteEditor {
  dom: HTMLElement;
  value(): string;
  focus(): void;
  destroy(): void;
}

/**
 * A markdown editor bound to one entry's note. `onChange` fires on every
 * keystroke — the store debounces the write, so that is the cheap end.
 */
export function noteEditor(opts: {
  value: string;
  hint: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
}): NoteEditor {
  const extensions: Extension[] = [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(markdownStyle),
    EditorView.lineWrapping,
    placeholder(opts.hint),
    theme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      blur: () => {
        opts.onBlur?.();
        return false;
      },
      // The document underneath listens for clicks to close menus; a click
      // in a note is not one of those.
      mousedown: (event) => {
        event.stopPropagation();
        return false;
      },
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: opts.value, extensions }),
  });

  return {
    dom: view.dom,
    value: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
