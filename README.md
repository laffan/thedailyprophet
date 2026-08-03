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
  2. **Include pages** *(optional)* — turn on link picking and click any
     link to add that page to the same document; click again to drop it.
     Included pages are *loaded* at capture time, not merely downloaded, so
     the route chunks, media and data requests their own code triggers are
     captured too.
     Off-site links are ignored so a capture can't run away. If a link is
     hard to hit (a menu, a script-driven control), browse to the page
     normally and press **Add this page** instead.
  3. **Clean up** — hover-and-click removal of extraneous elements
     (sidebars, banners, newsletter boxes). Arrow keys grow/shrink the
     selection between child and parent, `Z` undoes, everything can be
     restored.
  4. **Save** — the page source is re-fetched with your session and every
     resource it loaded (scripts, stylesheets, fonts, images, API responses)
     is stored under its original URL. Clean-up removals are recorded as
     selectors so the original HTML stays intact for hydration.
- **Archive format (the Safari `.webarchive` model)** — the main document is
  kept exactly as the server sent it and every subresource is stored under
  its **original URL**. At read time the app serves them back through its own
  `prophet://` URI scheme, so the browser's loader does the work: real script
  URLs, native `async`/`defer` ordering, native module graphs, native
  lifecycle events. Bundled apps (Next.js/Turbopack, webpack, Vite) hydrate
  and stay interactive offline because nothing about how they load has been
  rewritten.
- **Multi-page documents** — pages added with the include tool are stored
  under their own URLs, so following the link in the reader is ordinary
  navigation inside the archive. Scroll position is remembered per page, and
  bookmarks and highlights record which page they belong to, so jumping to
  one navigates there first. A link that was never included shows a short
  explanatory page rather than failing.
- **Editing after capture** — **Edit document…** in the reader's menu opens
  an overlay over the document itself. In *Remove elements* mode, clicking
  anything marks it with a red boundary and tint; in *Add pages* mode,
  clicking a link marks it green. Nothing changes until **Update Document**,
  so the whole selection stays reviewable. Removals are stored as selectors
  in `cleanup.json` and applied when the document is served, leaving the
  captured page untouched and the edit reversible; added pages are fetched
  through the capture view so they arrive with their scripts and data.
- **Safari `.webarchive` import** — `.webarchive` files open directly; the
  format maps onto ours one-to-one.
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
- **Shared folder sync** — point every device at one folder (iCloud Drive,
  Dropbox, a network share) in Settings. Documents are copied out, anything
  new found there is copied in, and reading state is *merged*: highlights and
  bookmarks are unioned by id and the more recently read device wins the
  scroll position, so annotating on two devices never loses one side's work.
  Optionally runs automatically after each capture or import. Files in the
  folder are named after the document (`The Elevator Story.prophet`), and are
  matched by the id stored inside each archive rather than by filename — so
  renaming a document renames its file without breaking the pairing.
- **Annotation export** — save a document's highlights and bookmarks as
  Markdown, JSON, CSV or plain text, from the shelf's ⋯ menu or the reader.
  The reader's sidebar doubles as an annotation browser: highlights are
  listed in document order, grouped by page for multi-page documents, and
  can be exported or copied as Markdown from there.
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

**Sync on iPadOS.** The app never picks a sync folder for you — a folder is
only useful if *you* point it at something that actually syncs. Both
platforms open a real system folder picker, so you can choose the same
iCloud Drive folder on your Mac and your iPad.

iOS needs a little more than a path: a sandboxed app loses access to a
chosen folder when it relaunches. Picking therefore also mints a
*security-scoped bookmark*, stored alongside the path, and the app resolves
that bookmark to re-acquire access before each sync (and updates the path if
iCloud has moved the folder). This is handled by the bundled
`src-tauri/tauri-plugin-icloud-folder` plugin, adapted from the working
implementation in [laffan/hush](https://github.com/laffan/hush).

iCloud also keeps files in the cloud until something asks for them, and an
undownloaded file is a *hidden* placeholder that ordinary directory reads
skip — which makes a folder full of documents look empty. Before each sync
the app asks iCloud to download the folder's `.prophet` files and waits for
them, reporting anything still in flight.

For the app's own folder to be visible in the Files app, add these to the
generated `Info.plist` after `tauri ios init`:

```xml
<key>UIFileSharingEnabled</key><true/>
<key>LSSupportsOpeningDocumentsInPlace</key><true/>
```

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
        │  capture_control("snapshot") ───► │  re-fetches the page source,
        │  ◄── capture_archive_resource ────│  streams each resource to disk
        │  ◄── capture_progress events ─────│  (page fetch w/ cookies first,
        │                                   │   Rust fetch as CORS fallback)
        │  ◄── capture_archive_finish ──────│  main.html + resources + meta
        ▼
   ~/Library/Application Support/com.thedailyprophet.reader/library/<uuid>/
        main.html   resources.json   res/…   meta.json   state.json   cover.jpg
```

Remote pages can only reach Tauri commands that are explicitly granted:
`build.rs` declares the app's ACL manifest (which gates *every* app command),
`capabilities/main.json` grants the library/reader commands to the main
webview, and `capabilities/capture.json` grants exactly the six `capture_*`
reporting commands to remote URLs in the capture webview. All six treat
their caller as untrusted.

## How reading works

Documents are opened by navigating an iframe to `prophet://<doc-id>/<path>`.
Every request the page makes — scripts, stylesheets, fonts, images, `fetch`,
`XMLHttpRequest`, module imports — arrives at the protocol handler in
`src-tauri/src/protocol.rs` and is answered from the document's resource map.

This is the same idea as Safari's `.webarchive`: don't rewrite the page, feed
the loader. It is what makes interactive articles keep working offline.

- Archive documents get a real origin (`prophet://<doc-id>`), so storage,
  modules and script identity behave as they did online. The CSP served with
  the document permits only the app's own scheme, so reading is provably
  offline — enforced, not assumed.
- A small runtime is injected at the top of `<head>` for reader features
  only: scroll tracking, text-quote highlight anchoring, bookmark context,
  in-page anchors, external-link interception, and applying the clean-up
  removals the user made during capture (recorded as selectors so the
  original HTML stays intact for hydration).
- Legacy single-file snapshots (format 1) still render in a sandboxed
  `srcdoc` iframe with the older replay path, so existing library items keep
  working.

## The `.prophet` format

A `.prophet` file is a plain zip archive:

| entry            | contents                                              |
| ---------------- | ----------------------------------------------------- |
| `prophet.json`   | format marker `{ "format": "prophet", "version": 1 }` |
| `meta.json`      | id, title, source URL, `format` (1 or 2), created date |
| `main.html`      | the main document, as the server sent it (format 2)   |
| `resources.json` | `[{ u: <original url>, f: <file>, m: <mime> }]`        |
| `res/…`          | the subresource bytes                                 |
| `snapshot.html`  | single-file snapshot (format 1 documents)             |
| `state.json`     | scroll position, progress, bookmarks, highlights      |
| `cover.<ext>`    | optional cover image                                  |

Safari `.webarchive` files can be imported directly and are converted into
this layout — the two formats express the same idea.

Imports keep the original document id when it's free, so passing a document
between machines is stable; otherwise a fresh id is minted.

## Known limitations (v1)

- Capture is desktop-only; iPadOS reads and imports.
- Same-origin iframes are captured one level deep; cross-origin iframes
  become placeholders.
- Video/audio larger than the per-resource cap (30 MB) is linked, not
  inlined — it won't play offline.
- Live features that need fresh data (tickers, comments, search) can only
  serve what was captured. A request the page never made while you browsed
  isn't in the archive, so interactions you never tried may dead-end.
- Resources the page loads from a third-party origin are captured only if
  they were requested while you browsed; anything else is blocked offline by
  the document CSP (usually a font or analytics beacon, so it degrades
  gracefully).
- Archives are capped at 512 MB, and at most 60 included pages per document.
- Sync merges annotations by union, so deleting a highlight on one device
  does not delete it on the others — it returns on the next sync. Sync is
  also a folder mirror, not a live watcher: it runs when you press **Sync
  now**, or after a capture/import when automatic sync is on.
- On iPadOS the sync folder is the app's own Files folder (see above), not
  an arbitrary folder you pick.
- Included pages are loaded in a hidden frame and scrolled, but only assets
  the page requests on its own are captured. Something that loads solely in
  response to an interaction nobody performed (a sound tied to one button,
  a panel opened from a menu) can still be missing.

## Roadmap ideas

- iCloud/Files sync of the library
- Full-text search across the shelf
- Notes on highlights, and highlight export (Markdown)
- Reader themes (typography override for non-interactive captures)
- Capture on iPadOS via an embedded browse sheet
