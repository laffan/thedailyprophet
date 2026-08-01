# The Daily Prophet

A macOS / iPadOS reader app for **interactive, web-based long-form writing**.

At its core, The Daily Prophet is a capture tool: it creates a fully
interactive, self-contained snapshot of a web page that can be read — and
played with — completely offline. Each snapshot lives on a Library shelf,
like a book in Apple Books, and remembers where you stopped reading, what
you bookmarked, and what you highlighted.

Built on [Tauri 2.0](https://v2.tauri.app).

## Features

- **Capture pipeline with a human in the loop** — a modal sheet inside the
  main window (the page renders in an embedded child webview, no separate
  OS window):
  1. **Browse** — use the page like a normal browser. Log in, dismiss
     cookie banners, expand collapsed sections, scroll to force lazy
     content to load.
  2. **Clean up** — hover-and-click removal of extraneous elements
     (sidebars, banners, newsletter boxes). Arrow keys grow/shrink the
     selection between child and parent, `Z` undoes, everything can be
     restored.
  3. **Save** — the page is serialized into a single self-contained HTML
     file: stylesheets (including cross-origin ones, `@import`s and
     constructed/adopted stylesheets), images, fonts, posters, icons and
     open shadow roots are inlined as `data:` URIs.
- **Offline replay vault** — with "Keep interactivity" on (the default),
  the capture webview records every network response the page consumes
  (fetch, XHR, lazy script chunks — captured from document-start, with the
  user's session) and embeds it in the snapshot. The reader replays those
  responses through patched `fetch`/`XMLHttpRequest`/script loading, so
  data-driven charts and scrollytelling behave offline exactly as they did
  online. Script-generated DOM is stripped at capture so re-running scripts
  rebuild it once, like an online reload (kept instead when the page is
  app-rendered, e.g. an SPA shell).
- **Library shelf** — covers (from `og:image` or the page's best image, with
  a generated "book spine" fallback), reading progress, rename / delete /
  export, drag-and-drop import.
- **Reading state** — scroll position is saved continuously and restored on
  reopen (robust to reflows: position is stored both absolutely and as a
  ratio).
- **Bookmarks** — one tap marks your place, labeled with the section heading
  you're in; jump back from the sidebar.
- **Highlights** — select text, pick a color. Highlights are anchored by
  *text quote* (exact text + surrounding context, à la Hypothesis), so they
  survive re-renders inside interactive snapshots. Orphaned highlights are
  kept and flagged instead of silently dropped.
- **Portable documents** — export any story as a `.prophet` file and open it
  in another instance of the app, bookmarks and highlights included. The
  app registers the `.prophet` file association; double-click or drag onto
  the window to import.

## Development

Prerequisites:

- Node 20+ and npm
- Rust (stable) — `rustup` recommended
- Platform toolchains per the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm install
npm run tauri dev      # run the desktop app
npm run tauri build    # produce a bundled macOS app / dmg
```

Icons are committed; to regenerate them from scratch:

```sh
npm run icon
```

### iPadOS

Reading, bookmarks, highlights and `.prophet` import/export all work on
iPadOS. The capture flow already renders as a modal inside the main window,
but embedding a second webview (`Window::add_child`) is desktop-only in
Tauri today, so capture is desktop-only in this version (the capture
command returns a friendly error on iOS).

```sh
npm run tauri ios init   # one-time; generates the Xcode project in src-tauri/gen
npm run tauri ios dev    # run on simulator/device
npm run tauri ios build  # archive for distribution
```

You'll need Xcode and an Apple Developer signing identity configured; see
the [Tauri iOS guide](https://v2.tauri.app/develop/#developing-your-mobile-application).

## How capture works

```
main webview (modal sheet UI)     capture child webview (the page itself,
        │                          embedded in the same window over the
        │                          sheet's slot area)
        │  capture_start(url, rect) ─────►  opens with capture.js injected
        │  capture_set_bounds(rect) ─────►  (re-injected on every navigation,
        │     (on every layout change)      so logins/redirects are fine)
        │  capture_control("begin_cleanup")►  overlay: hover/click to remove
        │  ◄── capture_count events ────────│
        │  capture_control("snapshot") ───► │  serializer: clones the DOM,
        │  ◄── capture_progress events ─────│  inlines every resource
        │                                   │  (page fetch w/ cookies first,
        │                                   │   Rust fetch as CORS fallback)
        │  ◄── capture_deliver ─────────────│  single-file HTML + cover + meta
        ▼
   ~/Library/Application Support/com.thedailyprophet.reader/library/<uuid>/
        snapshot.html   meta.json   state.json   cover.jpg
```

Remote pages can only reach Tauri commands that are explicitly granted:
`build.rs` declares the app's ACL manifest (which gates *every* app command),
`capabilities/main.json` grants the library/reader commands to the main
webview, and `capabilities/capture.json` grants exactly the six `capture_*`
reporting commands to remote URLs in the capture webview. All six treat
their caller as untrusted.

## How reading works

Snapshots are rendered in a sandboxed `<iframe sandbox="allow-scripts allow-forms">`
via `srcdoc`, with a small runtime injected at the top of `<head>`:

- The opaque origin means snapshot scripts **cannot touch the app or Tauri
  IPC** — the runtime talks to the reader UI only through `postMessage`.
- The app's CSP blocks all network access from snapshots, so reading is
  *provably* offline; anything not inlined at capture time simply doesn't
  load.
- The runtime shims everything that throws in opaque origins —
  `localStorage`/`sessionStorage`, `document.cookie`, `indexedDB`, `caches`,
  `history.pushState`, `WebSocket`/`EventSource` — so page scripts keep
  running instead of dying on their first storage access.
- The runtime replays the snapshot's vault: `fetch` and `XMLHttpRequest`
  return the recorded responses (relative URLs resolve against the original
  article URL), and dynamically-inserted scripts/images are served from the
  vault as `blob:` URLs — this is what keeps code-split chunks and
  data-driven graphics alive offline.
- Scroll tracking, highlight anchoring/painting, bookmark context, in-page
  anchor navigation and external-link interception all live in the runtime;
  external links open in the system browser.

> **Privacy note:** the vault stores API responses the page fetched with
> your session — a `.prophet` file of a personalized page may contain
> personalized data. Export and share accordingly.

## The `.prophet` format

A `.prophet` file is a plain zip archive:

| entry           | contents                                             |
| --------------- | ----------------------------------------------------- |
| `prophet.json`  | format marker `{ "format": "prophet", "version": 1 }` |
| `meta.json`     | id, title, source URL, author, excerpt, created date  |
| `snapshot.html` | the self-contained interactive snapshot               |
| `state.json`    | scroll position, progress, bookmarks, highlights      |
| `cover.<ext>`   | optional cover image                                  |

Imports keep the original document id when it's free, so passing a document
between machines is stable; otherwise a fresh id is minted.

## Known limitations (v1)

- Capture is desktop-only; iPadOS reads and imports.
- Same-origin iframes are captured one level deep; cross-origin iframes
  become placeholders.
- Video/audio larger than the per-resource cap (30 MB) is linked, not
  inlined — it won't play offline.
- Live features that need fresh data (tickers, comments, search) replay
  their captured responses; they cannot show anything newer than the
  capture. Requests the page never made while you browsed are not in the
  vault — interactions you never tried may dead-end offline.
- ES-module graphs with relative imports inside `blob:`-served modules
  cannot be fully rewired; module-heavy apps may degrade.
- Total inlining budget is ~120 MB per snapshot (vault capped at ~48 MB);
  resources beyond it are left as absolute URLs.

## Roadmap ideas

- iCloud/Files sync of the library
- Full-text search across the shelf
- Notes on highlights, and highlight export (Markdown)
- Reader themes (typography override for non-interactive captures)
- Capture on iPadOS via an embedded browse sheet
