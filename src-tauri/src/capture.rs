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
