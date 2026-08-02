use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::library::{self, DocSummary, NewDocument};
use crate::Fetcher;

const MAX_FETCH_BYTES: u64 = 30 * 1024 * 1024;

/// Opens the capture webview as a child of the main window (a modal sheet —
/// no separate OS window), on the requested page, with the capture toolkit
/// injected as an initialization script (re-injected on every navigation, so
/// logging in and moving between pages is fine).
///
/// `x/y/width/height` are logical (CSS) pixels of the slot the frontend
/// reserved for the page, relative to the window's content area.
#[tauri::command]
pub async fn capture_start(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
        match parsed.scheme() {
            "http" | "https" => {}
            other => return Err(format!("only http(s) pages can be captured (got {other}:)")),
        }
        if let Some(existing) = app.get_webview("capture") {
            let _ = existing.close();
        }
        let window = app
            .get_window("main")
            .ok_or("main window not found")?;
        let builder =
            tauri::webview::WebviewBuilder::new("capture", tauri::WebviewUrl::External(parsed))
                .initialization_script(include_str!("../injected/capture.js"))
                .focused(true);
        let webview = window
            .add_child(
                builder,
                tauri::LogicalPosition::new(x, y),
                tauri::LogicalSize::new(width.max(1.0), height.max(1.0)),
            )
            .map_err(|e| format!("could not open capture view: {e}"))?;
        let _ = webview.set_focus();
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, url, x, y, width, height);
        Err("Capturing needs the desktop app for now — import .prophet files on this device instead.".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundsInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Keeps the embedded capture webview aligned with the slot the frontend
/// reserved for it (called on layout changes / window resize). Returns the
/// bounds the webview actually ended up with (logical px) so the frontend
/// can detect and compensate for any coordinate drift.
#[tauri::command]
pub async fn capture_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<Option<BoundsInfo>, String> {
    let wv = app
        .get_webview("capture")
        .ok_or("the capture view is not open")?;
    let rect = tauri::Rect {
        position: tauri::LogicalPosition::new(x, y).into(),
        size: tauri::LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
    };
    wv.set_bounds(rect).map_err(|e| e.to_string())?;

    let scale = wv.window().scale_factor().unwrap_or(1.0);
    Ok(wv.bounds().ok().map(|b| {
        let pos = b.position.to_logical::<f64>(scale);
        let size = b.size.to_logical::<f64>(scale);
        BoundsInfo {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        }
    }))
}

/// Drives the injected toolkit from the main window.
#[tauri::command]
pub async fn capture_control(
    app: AppHandle,
    action: String,
    options: Option<Value>,
) -> Result<(), String> {
    let wv = app
        .get_webview("capture")
        .ok_or("the capture view is not open")?;
    const NS: &str = "window.__PROPHET_CAPTURE__ && window.__PROPHET_CAPTURE__";
    let js = match action.as_str() {
        "begin_cleanup" => format!("{NS}.beginCleanup();"),
        "end_cleanup" => format!("{NS}.endCleanup();"),
        "begin_include" => format!("{NS}.beginInclude();"),
        "include_current" => format!("{NS}.includeCurrent();"),
        "clear_included" => format!("{NS}.clearIncluded();"),
        "append_pages" => {
            let opts = options.unwrap_or_else(|| Value::Object(Default::default()));
            let doc_id = opts.get("docId").and_then(|v| v.as_str()).unwrap_or("");
            if !library::valid_id(doc_id) {
                return Err("invalid document id".into());
            }
            let urls = serde_json::to_string(opts.get("urls").unwrap_or(&Value::Null))
                .map_err(|e| e.to_string())?;
            format!("{NS}.appendPages({}, {urls});", serde_json::to_string(doc_id).unwrap())
        }
        "undo" => format!("{NS}.undo();"),
        "restore_all" => format!("{NS}.restoreAll();"),
        "snapshot" => {
            let opts = options.unwrap_or_else(|| Value::Object(Default::default()));
            let json = serde_json::to_string(&opts).map_err(|e| e.to_string())?;
            format!("{NS}.snapshot({json});")
        }
        "cancel" => {
            let _ = wv.close();
            let _ = app.emit("capture://closed", ());
            return Ok(());
        }
        other => return Err(format!("unknown capture action: {other}")),
    };
    wv.eval(js).map_err(|e| e.to_string())
}

// ---- commands invoked BY the capture page (remote IPC) --------------------
//
// These are reachable from arbitrary web pages loaded in the capture webview
// (see capabilities/capture.json), so every one of them treats its input as
// untrusted: they only report progress, fetch public resources with hard
// size caps, or hand over content that the library layer sanitizes.

#[tauri::command]
pub fn capture_page_info(app: AppHandle, title: String, url: String) -> Result<(), String> {
    let _ = app.emit(
        "capture://page",
        serde_json::json!({ "title": title, "url": url }),
    );
    Ok(())
}

#[tauri::command]
pub fn capture_progress(
    app: AppHandle,
    stage: String,
    detail: Option<String>,
) -> Result<(), String> {
    let _ = app.emit(
        "capture://progress",
        serde_json::json!({ "stage": stage, "detail": detail }),
    );
    Ok(())
}

#[tauri::command]
pub fn capture_count(app: AppHandle, count: u32) -> Result<(), String> {
    let _ = app.emit("capture://count", count);
    Ok(())
}

/// The set of linked pages the user picked with the include tool.
#[tauri::command]
pub fn capture_included(app: AppHandle, urls: Value) -> Result<(), String> {
    let _ = app.emit("capture://included", urls);
    Ok(())
}

#[tauri::command]
pub fn capture_failed(app: AppHandle, message: String) -> Result<(), String> {
    let _ = app.emit("capture://error", message);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedResource {
    pub ok: bool,
    pub status: u16,
    pub mime: String,
    pub b64: String,
}

fn miss(status: u16) -> FetchedResource {
    FetchedResource {
        ok: false,
        status,
        mime: String::new(),
        b64: String::new(),
    }
}

/// Fallback resource fetcher for assets the page context cannot read
/// (cross-origin without CORS headers). No cookies are attached; this is
/// only for public assets like CDN stylesheets, fonts and images.
#[tauri::command]
pub async fn capture_fetch(
    state: tauri::State<'_, Fetcher>,
    url: String,
) -> Result<FetchedResource, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("unsupported scheme".into()),
    }
    let resp = match state.0.get(parsed).send().await {
        Ok(r) => r,
        Err(_) => return Ok(miss(0)),
    };
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        return Ok(miss(status));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_FETCH_BYTES {
            return Ok(miss(status));
        }
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return Ok(miss(status)),
    };
    if bytes.len() as u64 > MAX_FETCH_BYTES {
        return Ok(miss(status));
    }
    Ok(FetchedResource {
        ok: true,
        status,
        mime,
        b64: B64.encode(&bytes),
    })
}

// ---- resource-map archive capture (format 2) -----------------------------

/// Staging area for the archive currently being captured. Resources are
/// streamed to disk as the page yields them rather than accumulated in one
/// giant IPC payload.
#[derive(Default)]
pub struct Staging {
    pub inner: std::sync::Mutex<Option<StagingArchive>>,
}

pub struct StagingArchive {
    pub id: String,
    pub dir: std::path::PathBuf,
    #[allow(dead_code)]
    pub main_url: String,
    pub entries: Vec<crate::archive::ResourceEntry>,
    pub bytes: u64,
}

const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

#[tauri::command]
pub fn capture_archive_begin(
    app: AppHandle,
    state: tauri::State<'_, Staging>,
    main_url: String,
) -> Result<(), String> {
    let (id, dir) = library::new_document_dir(&app)?;
    let mut slot = state.inner.lock().map_err(|_| "staging poisoned")?;
    // Abandon any half-finished previous attempt.
    if let Some(old) = slot.take() {
        let _ = std::fs::remove_dir_all(&old.dir);
    }
    *slot = Some(StagingArchive {
        id,
        dir,
        main_url,
        entries: Vec::new(),
        bytes: 0,
    });
    Ok(())
}

#[tauri::command]
pub fn capture_archive_resource(
    state: tauri::State<'_, Staging>,
    url: String,
    mime: String,
    b64: String,
) -> Result<bool, String> {
    let mut slot = state.inner.lock().map_err(|_| "staging poisoned")?;
    let st = slot.as_mut().ok_or("no capture in progress")?;
    let bytes = crate::archive::decode_b64(&b64)?;
    if st.bytes + bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Ok(false);
    }
    // Skip duplicates (the page may reference the same asset repeatedly).
    if st.entries.iter().any(|e| e.u == url) {
        return Ok(true);
    }
    let entry = crate::archive::store_resource(&st.dir, &url, &mime, &bytes)?;
    st.bytes += bytes.len() as u64;
    st.entries.push(entry);
    Ok(true)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDoc {
    pub title: String,
    pub source_url: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub excerpt: Option<String>,
    pub main_html: String,
    #[serde(default)]
    pub cover_b64: Option<String>,
    #[serde(default)]
    pub cover_mime: Option<String>,
    #[serde(default)]
    pub scripts: bool,
}

#[tauri::command]
pub async fn capture_archive_finish(
    app: AppHandle,
    state: tauri::State<'_, Staging>,
    doc: ArchiveDoc,
) -> Result<DocSummary, String> {
    let summary = {
        let mut slot = state.inner.lock().map_err(|_| "staging poisoned")?;
        let st = slot.take().ok_or("no capture in progress")?;
        let dir = st.dir.clone();
        let result = (|| -> Result<DocSummary, String> {
            let origin = crate::archive::origin_of(&doc.source_url);
            let known: Vec<String> = st.entries.iter().map(|e| e.u.clone()).collect();
            let html = crate::archive::rewrite_text(&doc.main_html, &origin, &known);
            std::fs::write(dir.join("main.html"), html.as_bytes())
                .map_err(|e| format!("could not write main.html: {e}"))?;
            crate::archive::write_manifest(&dir, &st.entries)?;

            let cover = match (&doc.cover_b64, &doc.cover_mime) {
                (Some(b), Some(m)) => library::write_cover(&dir, b, m),
                _ => None,
            };
            let meta = library::DocMeta {
                id: st.id.clone(),
                title: if doc.title.trim().is_empty() {
                    "Untitled".into()
                } else {
                    doc.title.trim().chars().take(300).collect()
                },
                source_url: doc.source_url.clone(),
                author: doc.author.clone(),
                excerpt: doc.excerpt.clone(),
                created_at: library::now_ms(),
                size_bytes: html.len() as u64 + st.bytes,
                cover,
                scripts: doc.scripts,
                format: 2,
            };
            library::write_meta(&dir, &meta)?;
            library::summary_for(&dir)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        result?
    };

    crate::protocol::invalidate(&summary.meta.id);
    crate::sync::auto_sync(&app);
    let _ = app.emit("capture://done", &summary);
    if let Some(wv) = app.get_webview("capture") {
        let _ = wv.close();
    }
    Ok(summary)
}

/// Records the elements the reader removed after capture. Selectors are
/// stored per page and applied when the document is served.
#[tauri::command]
pub fn edit_set_removals(
    app: AppHandle,
    id: String,
    page: String,
    selectors: Vec<String>,
    replace: bool,
) -> Result<u32, String> {
    let dir = library::doc_dir(&app, &id)?;
    if !dir.exists() {
        return Err("document not found".into());
    }
    let mut removals = crate::archive::read_removals(&dir);
    let entry = removals.entry(page).or_default();
    if replace {
        entry.clear();
    }
    for sel in selectors {
        let sel = sel.trim().to_string();
        if !sel.is_empty() && !entry.contains(&sel) {
            entry.push(sel);
        }
    }
    let total = removals.values().map(|v| v.len() as u32).sum();
    crate::archive::write_removals(&dir, &removals)?;
    crate::protocol::invalidate(&id);
    crate::sync::auto_sync(&app);
    Ok(total)
}

/// Clears every post-capture removal, restoring the document as captured.
#[tauri::command]
pub fn edit_clear_removals(app: AppHandle, id: String) -> Result<(), String> {
    let dir = library::doc_dir(&app, &id)?;
    crate::archive::write_removals(&dir, &Default::default())?;
    crate::protocol::invalidate(&id);
    crate::sync::auto_sync(&app);
    Ok(())
}

/// Stages an existing document so newly captured resources are appended to
/// it — this is how pages get added to a document after the fact.
#[tauri::command]
pub fn capture_archive_open_existing(
    app: AppHandle,
    state: tauri::State<'_, Staging>,
    id: String,
) -> Result<(), String> {
    let dir = library::doc_dir(&app, &id)?;
    if !dir.exists() {
        return Err("document not found".into());
    }
    let entries = crate::archive::read_manifest(&dir);
    let mut slot = state.inner.lock().map_err(|_| "staging poisoned")?;
    *slot = Some(StagingArchive {
        id,
        dir,
        main_url: String::new(),
        entries,
        bytes: 0,
    });
    Ok(())
}

/// Writes the appended resources back into the existing document.
#[tauri::command]
pub fn capture_archive_commit(
    app: AppHandle,
    state: tauri::State<'_, Staging>,
) -> Result<u32, String> {
    let (id, dir, entries) = {
        let mut slot = state.inner.lock().map_err(|_| "staging poisoned")?;
        let st = slot.take().ok_or("no document is staged")?;
        (st.id, st.dir, st.entries)
    };
    let added = entries.len() as u32;
    crate::archive::write_manifest(&dir, &entries)?;
    crate::protocol::invalidate(&id);
    crate::sync::auto_sync(&app);
    let _ = app.emit("library://changed", ());
    let _ = app.emit("capture://appended", added);
    Ok(added)
}

/// Final delivery: persist the snapshot, tell the main window, close capture.
#[tauri::command]
pub async fn capture_deliver(app: AppHandle, doc: NewDocument) -> Result<DocSummary, String> {
    let summary = library::create_document(&app, doc)?;
    let _ = app.emit("capture://done", &summary);
    let _ = app.emit("library://changed", ());
    if let Some(wv) = app.get_webview("capture") {
        let _ = wv.close();
    }
    Ok(summary)
}
