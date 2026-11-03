# The Daily Prophet

A reader for interactive, web-based long-form writing on macOS and iPadOS. It
saves a web page, scripts and all, as an archive that still works offline.
Saved pages sit on a library shelf, and the app remembers your place,
bookmarks and highlights.

## Installation

Download the installer for your system from the
[Releases](../../releases) page: `.dmg` (macOS).

The builds are not code-signed. On macOS, if the app is blocked on first
launch, move it to Applications and run:

```sh
xattr -cr "/Applications/The Daily Prophet.app"
```

### Build from source

Requires [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri build    # installers end up in src-tauri/target/release/bundle/
npm run tauri dev      # run in development
```

## More detail

[README_DETAIL.md](README_DETAIL.md) explains the capture flow, the archive format and known limitations.
