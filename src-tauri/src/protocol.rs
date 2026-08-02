//! The `prophet://` URI scheme — the offline equivalent of the network.
//!
//! A document is served at `prophet://<doc-id>/<original-path>`, so every
//! request the page makes (scripts, stylesheets, fonts, images, `fetch`,
//! `XMLHttpRequest`, module imports) arrives here and is answered from the
//! document's resource map. The browser's own loader stays in charge, which
//! is what keeps script identity, `async`/`defer` ordering and lifecycle
//! events behaving exactly as they did online.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, UriSchemeContext};

use crate::archive::ResourceIndex;
use crate::library;

/// Served to the document itself: everything may come from our own scheme,
/// nothing may reach the network. Offline reading is enforced here, not by
/// convention.
const DOC_CSP: &str = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: prophet:; \
img-src 'self' data: blob: prophet:; media-src 'self' data: blob: prophet:; \
font-src 'self' data: blob: prophet:; style-src 'self' 'unsafe-inline' data: blob: prophet:; \
script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: prophet:; \
connect-src 'self' data: blob: prophet:; frame-src 'self' data: blob: prophet:; object-src 'none'";

const READER_RUNTIME: &str = include_str!("../../src/reader/runtime.js");

fn index_cache() -> &'static Mutex<HashMap<String, std::sync::Arc<ResourceIndex>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, std::sync::Arc<ResourceIndex>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop a document's cached lookup table (after delete / re-import).
pub fn invalidate(doc_id: &str) {
    if let Ok(mut c) = index_cache().lock() {
        c.remove(doc_id);
    }
}

fn not_found(msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

/// A link the reader followed that was never captured. Navigations deserve a
/// readable page rather than a bare 404 body.
fn uncaptured_page(path: &str, source: &str) -> tauri::http::Response<Vec<u8>> {
    let shown = html_escape(path);
    let origin = html_escape(&crate::archive::origin_of(source));
    let body = format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page not in this document</title>
<style>
:root{{color-scheme:light dark}}
body{{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif;
margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#f3ecdd;color:#262016;padding:40px}}
@media (prefers-color-scheme:dark){{body{{background:#191510;color:#ece4d3}}}}
.card{{max-width:30rem;text-align:center}}
h1{{font-size:20px;margin:0 0 12px;font-family:Georgia,serif}}
p{{margin:0 0 10px;opacity:.8;font-size:14px}}
code{{font-size:12.5px;opacity:.75;word-break:break-all}}
button{{font:inherit;font-size:14px;margin-top:18px;padding:8px 18px;border:0;border-radius:6px;
background:#7a2e1d;color:#f7f1e4;cursor:pointer}}
</style></head><body><div class="card">
<h1>This page wasn't included</h1>
<p>The link points to a page that wasn't part of the capture, and this
document is offline.</p>
<code>{origin}{shown}</code>
<p style="margin-top:16px">To include pages like this one, use <b>Include pages</b>
during the Browse step when capturing.</p>
<button onclick="history.back()">Go back</button>
</div></body></html>"#
    );
    tauri::http::Response::builder()
        .status(404)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", DOC_CSP)
        .body(body.into_bytes())
        .unwrap()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Navigations (as opposed to subresource loads) ask for HTML first.
fn is_navigation(request: &tauri::http::Request<Vec<u8>>) -> bool {
    request
        .headers()
        .get("Accept")
        .and_then(|v| v.to_str().ok())
        .map(|a| a.contains("text/html"))
        .unwrap_or(false)
}

/// Inject the reader runtime as the first thing in `<head>` so it installs
/// its hooks before any page script runs.
fn inject_runtime(html: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(html);
    let safe = READER_RUNTIME.replace("</script", "<\\/script");
    let tag = format!("<script data-prophet-runtime>{safe}</script>");
    let lower = text.to_lowercase();
    let insert_at = lower
        .find("<head")
        .and_then(|i| lower[i..].find('>').map(|j| i + j + 1))
        .or_else(|| lower.find("<html").and_then(|i| lower[i..].find('>').map(|j| i + j + 1)))
        .unwrap_or(0);
    let mut out = String::with_capacity(text.len() + tag.len());
    out.push_str(&text[..insert_at]);
    out.push_str(&tag);
    out.push_str(&text[insert_at..]);
    out.into_bytes()
}

pub fn handle(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let app: &AppHandle = ctx.app_handle();
    let url = request.uri().to_string();
    let parsed = match tauri::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => return not_found(&format!("bad url: {e}")),
    };

    // prophet://<doc-id>/<path>
    let doc_id = parsed.host_str().unwrap_or("").to_string();
    if !library::valid_id(&doc_id) {
        return not_found("invalid document id");
    }
    let dir = match library::doc_dir(app, &doc_id) {
        Ok(d) if d.exists() => d,
        _ => return not_found("document not found"),
    };

    let meta_raw = match std::fs::read_to_string(dir.join("meta.json")) {
        Ok(r) => r,
        Err(e) => return not_found(&format!("no meta: {e}")),
    };
    let meta: library::DocMeta = match serde_json::from_str(&meta_raw) {
        Ok(m) => m,
        Err(e) => return not_found(&format!("bad meta: {e}")),
    };

    let mut key = parsed.path().to_string();
    if let Some(q) = parsed.query() {
        key.push('?');
        key.push_str(q);
    }

    let main_path = {
        let m = tauri::Url::parse(&meta.source_url).ok();
        m.map(|u| {
            let mut s = u.path().to_string();
            if let Some(q) = u.query() {
                s.push('?');
                s.push_str(q);
            }
            s
        })
        .unwrap_or_else(|| "/".to_string())
    };

    // The main document: served with the reader runtime injected.
    let is_main = key == main_path
        || key == "/"
        || key == main_path.split('?').next().unwrap_or(&main_path);
    if is_main {
        if let Ok(bytes) = std::fs::read(dir.join("main.html")) {
            return tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Content-Security-Policy", DOC_CSP)
                .header("Cache-Control", "no-store")
                .body(inject_runtime(&bytes))
                .unwrap();
        }
    }

    // Subresources, from the document's resource map.
    let index = {
        let mut cache = match index_cache().lock() {
            Ok(c) => c,
            Err(e) => e.into_inner(),
        };
        cache
            .entry(doc_id.clone())
            .or_insert_with(|| std::sync::Arc::new(ResourceIndex::build(&dir, &meta.source_url)))
            .clone()
    };

    match index.get(&key) {
        Some((bytes, mime)) => {
            // Pages added with the include tool are documents in their own
            // right: they get the reader runtime and the offline CSP too, so
            // scroll position, highlights and bookmarks work across a
            // multi-page document.
            if mime.contains("html") {
                return tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "text/html; charset=utf-8")
                    .header("Content-Security-Policy", DOC_CSP)
                    .header("Cache-Control", "no-store")
                    .body(inject_runtime(&bytes))
                    .unwrap();
            }
            let ct = if mime.is_empty() {
                "application/octet-stream".to_string()
            } else if crate::archive::is_texty(&mime) && !mime.contains("charset") {
                format!("{mime}; charset=utf-8")
            } else {
                mime
            };
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", ct)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-store")
                .body(bytes)
                .unwrap()
        }
        None if is_navigation(&request) => uncaptured_page(&key, &meta.source_url),
        None => not_found("not captured"),
    }
}
