# Capture on iPadOS: what a Swift webview shim would need

Capture is desktop-only today. This document explains exactly why, and
specifies the plugin that would lift the restriction — what has to be
written, what can be reused unchanged, and what is likely to go wrong.

It is a design spec, not a record of something built. Nothing here is
implemented.

## Why capture stops at the platform line

The capture flow needs a **second live webview**: the real site, with your
real session, positioned inside the app window, which the app can inject a
script into, evaluate JavaScript in, move as the sheet resizes, and close.
Browse, Include and Clean up are all direct manipulation of that live page.
Nothing about the flow works against a fetched copy — the whole point is
that you log in, dismiss the banner and expand the section *before* the
snapshot is taken.

Two pieces of Tauri's public API are compiled out of a mobile build:

| what | gate | where |
| --- | --- | --- |
| `Window::add_child` | `#[cfg(any(test, all(desktop, feature = "unstable")))]` | `tauri-2.11.5/src/window/mod.rs:1127` |
| `Webview::{set_bounds, bounds, close, set_focus, …}` | `#[cfg(desktop)]` on the whole `impl` block | `tauri-2.11.5/src/webview/mod.rs:1480` |

This is what an iOS build reports as *"no method named `set_bounds` found
for struct `tauri::Webview`"*, and it is why every call site in
`src-tauri/src/capture.rs` is wrapped in `#[cfg(desktop)]` with an
`Err("Capturing needs the desktop app for now…")` arm.

**The restriction is Tauri's API surface, not the platform.** Every layer
underneath already handles iOS:

- `tauri-runtime-wry` routes `WebviewKind::WindowChild → build_as_child` in
  a branch that explicitly lists `target_os = "ios"` —
  `tauri-runtime-wry-2.11.4/src/lib.rs:5239-5245`
- wry's `wkwebview::InnerWebView::new_as_child` handles
  `RawWindowHandle::UiKit`, the iOS window handle —
  `wry-0.55.1/src/wkwebview/mod.rs:186`
- the runtime's `set_bounds` / `close` live in a plain `WebviewDispatch`
  impl with no platform gating at all
- UIKit has no objection: a `WKWebView` nested in another view is ordinary
  subview composition

So there are two routes. **Route A** is upstream: Tauri exposes `add_child`
and webview bounds on mobile, and this repo deletes its `cfg` gates. That
may be a small change — but those iOS paths are unexercised, so "the code
exists" is not "it works" (see [Risks](#risks-and-unknowns)). **Route B**,
specified below, is a Swift plugin that owns the `WKWebView` directly and
never asks Tauri for a child webview.

## What already exists and does not change

This matters more than the plugin itself: the capture *logic* is
platform-neutral, and route B does not touch it.

- **`src-tauri/injected/capture.js`** (~1,900 lines) — the entire toolkit.
  Recorder, include-mode link picking, cleanup-mode hover/remove,
  `archiveSnapshot()`, `harvestPage()`, `appendPages()`. Runs in the page.
  Unchanged.
- **Every `capture_*` Rust command** — `capture_page_info`,
  `capture_progress`, `capture_count`, `capture_included`, `capture_fetch`,
  `capture_deliver`, `capture_failed`, `capture_archive_begin`,
  `capture_archive_resource`, `capture_archive_finish`,
  `capture_archive_open_existing`, `capture_archive_commit`. These take
  data and write to the library; they never touch a webview handle.
  Unchanged.
- **The archive layer** — `archive.rs`, `library.rs`, `protocol.rs`,
  `transfer.rs`, `sync.rs`. Already platform-neutral; the reader works on
  iPad today.
- **The sheet UI** — `src/views/capture.ts`, the stepper, the slot, the
  controls. The slot is an empty DOM element that a native view is
  positioned over; that idea is identical on iOS.

What must be rewritten is only the **plumbing**: create the webview,
position it, inject at document-start, evaluate JS in it, route IPC out of
it, close it.

## The contract to reproduce

Five things, and the shim is defined by them.

### 1. Create, positioned over the slot

`capture_start(url, x, y, width, height)` currently builds a
`WebviewBuilder` with `.initialization_script(capture.js)` and calls
`window.add_child(...)` at a logical position and size.

The Swift equivalent: a `WKWebView` added as a subview of
`self.manager.viewController?.view` — the same accessor
`IcloudFolderPlugin.pickFolder` uses to present its picker — with the frame
set from the logical rect and `isOpaque`/`backgroundColor` set so the
sheet's paper background does not bleed through. All of it on the main
queue; `WKWebView` is main-thread-only.

The URL scheme must be validated **before** loading — `capture_start`
already rejects anything that is not `http`/`https`, and that check must
not move to the Swift side where it is easy to forget.

### 2. Inject `capture.js` at document-start, on every navigation

This is the requirement people get wrong. The toolkit must be present
*before the page's own scripts run*, and it must survive logins, redirects
and in-page navigation — the user browses freely during the Browse step.

`WKUserScript(source:injectionTime: .atDocumentStart, forMainFrameOnly: false)`
added to the webview's `configuration.userContentController` gives exactly
this, and re-applies on every navigation automatically. That is the same
semantic Tauri's `initialization_script` provides, so `capture.js` needs no
changes.

Read the script from the Rust side (`include_str!`) and pass it across as a
command argument rather than duplicating the file into the Swift bundle —
one copy, one source of truth.

### 3. Evaluate JS on demand

`capture_control(action, options)` builds a JS string and calls
`wv.eval(js)`. The action list is fixed:

```
begin_cleanup   end_cleanup    begin_include   include_current
clear_included  append_pages   undo            restore_all
snapshot        cancel
```

All of them resolve to a call on `window.__PROPHET_CAPTURE__`
(`capture.js:1769`), except `cancel`, which closes the webview and emits
`capture://closed`.

Swift side: `webView.evaluateJavaScript(_:completionHandler:)`. Keep the JS
string construction in Rust — `append_pages` and `snapshot` serialize
their arguments through `serde_json`, which is what keeps a document title
or URL from breaking out of the string. Do not rebuild that escaping in
Swift.

### 4. Route IPC from the remote page back to Rust

The hard part, and the one with the security surface.

`capture.js` calls `window.__TAURI_INTERNALS__.invoke(cmd, args)`
(`capture.js:28-31`). On desktop that reaches Tauri's IPC, and because the
app declares an ACL manifest in `build.rs`, **every** command is gated;
`capabilities/capture.json` then grants the capture webview's remote origins
exactly the twelve `capture_*` reporting commands and nothing else.

A plugin-owned `WKWebView` is outside Tauri's IPC entirely, so the shim has
to provide that channel itself:

- add a `WKScriptMessageHandler` under a fixed name
- inject a small prelude (before `capture.js`) defining
  `window.__TAURI_INTERNALS__.invoke` as a promise-returning wrapper over
  `postMessage`, with a request-id map for replies
- in the handler, **check the command name against a hardcoded allowlist of
  the twelve `capture_*` commands** and reject anything else

That allowlist is not optional and not a convenience. It is the shim's
replacement for `capabilities/capture.json`, and it is the only thing
standing between an arbitrary web page and the rest of the app's command
surface. It belongs in one constant, next to a comment saying so.

From the handler, forward to Rust. Note the direction: the existing plugin
pattern is Rust → Swift via `run_mobile_plugin`, and this needs
Swift → Rust. Options are a `SwiftRs` callback registered at plugin init,
or the plugin emitting a Tauri event that a Rust listener turns into the
matching command call. Either way the payload must be treated as untrusted
— which the `capture_*` commands already do, since on desktop they are
reachable from any page too.

### 5. Reposition and close

`capture_set_bounds` is called on every layout change and returns the bounds
the webview *actually* got, so the frontend can compensate for coordinate
drift (`src/views/capture.ts:312-332` — up to three correction rounds,
±150pt sanity clamp). Reading the frame back after setting it is part of the
contract, not a debugging aid.

On iOS the drift causes are different — the safe-area inset and the keyboard
— but the same read-back protocol absorbs both, so the frontend needs no
change. `capture_control("cancel")` and the end of a successful capture both
remove the webview from its superview.

## Files to add

Mirroring `src-tauri/tauri-plugin-icloud-folder/`, which is the working
precedent in this repo for a vendored iOS plugin:

```
src-tauri/tauri-plugin-capture-webview/
  Cargo.toml                       links = "tauri-plugin-capture-webview"
  build.rs                         COMMANDS = [open, set_bounds, eval, close]
  src/lib.rs                       run_mobile_plugin proxies; non-iOS -> Err
  permissions/                     one .toml per command + default.toml
  ios/Package.swift                swift-tools-version:5.5, .iOS(.v13)
  ios/Sources/CaptureWebviewPlugin.swift
```

Then in the app:

- `src-tauri/src/lib.rs` — register the plugin
- `src-tauri/src/capture.rs` — replace each `#[cfg(not(desktop))] { Err(…) }`
  arm with a call into the plugin. The `#[cfg(desktop)]` arms stay exactly
  as they are; desktop keeps using Tauri's native child webview, which
  already works.
- `src/main.ts` — `canCapture` becomes true on iOS, which re-enables the
  capture section on the shelf and the *Add pages* tab in the reader's edit
  bar (`src/views/library.ts`, `src/views/reader.ts`). Both already read
  that single flag, so nothing else in the frontend changes.

Roughly 400–600 lines of Swift and 150 of Rust. The 1,900-line capture
toolkit and all twelve `capture_*` commands are untouched.

## Risks and unknowns

Stated plainly, because they are what would actually decide the schedule.

- **The IPC bridge is the real work.** Everything else is a
  frame-and-lifecycle exercise. The `postMessage` ↔ promise wrapper has to
  match `__TAURI_INTERNALS__.invoke`'s shape closely enough that
  `capture.js` does not notice, including rejection semantics — the toolkit
  calls `.catch()` on nearly every invoke.
- **`capture_fetch` exists for a reason.** Same-origin fetches inside the
  page carry the user's session; cross-origin ones fall back to a Rust-side
  fetch (`capture.js:551`). That split must survive, or captures silently
  lose third-party resources.
- **Memory.** iPadOS is far more willing to kill a tab than macOS, and a
  30 MB archive is assembled in-page before delivery. `archiveSnapshot()`
  streams each resource out via `capture_archive_resource` rather than
  accumulating, which helps, but this is untested under iOS memory
  pressure and is the most likely place for a large capture to die.
- **The keyboard.** When the software keyboard appears during a login, iOS
  resizes the visual viewport. The bounds read-back should absorb it; it
  has not been tried.
- **Route A may land first.** If Tauri exposes `add_child` on mobile, this
  plugin becomes unnecessary — the `cfg` gates come off and desktop and iOS
  share one path. Worth a check upstream before starting.

## Why this is not done yet

Capture works well on desktop and every *reading* feature — including
import, annotation, and folder sync — already works on iPad. The plugin
above is a contained piece of work, but it is a new IPC trust boundary
hand-written in Swift, replacing one that Tauri's ACL currently enforces.
That is worth building deliberately rather than as a footnote to a UI pass.
