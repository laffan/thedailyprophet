//! Resource-map archives — the Safari `.webarchive` model.
//!
//! Rather than rewriting a page into one self-contained file, we keep the
//! main document byte-for-byte as the server sent it and store every
//! subresource under its **original URL**. At read time a custom URI scheme
//! (`prophet://<doc-id>/…`) serves those resources back to the webview, so
//! the browser's own loader does the work: real script URLs, native
//! `async`/`defer` ordering, native module graphs, native lifecycle events.
//!
//! Layout inside a document directory:
//! ```text
//!   meta.json        document metadata (format: 2, mainUrl)
//!   state.json       reading state
//!   main.html        the main resource, unmodified
//!   resources.json   [{ "u": <original url>, "f": <file>, "m": <mime> }]
//!   res/<file>       resource bytes
//! ```

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceEntry {
    /// Original absolute URL.
    pub u: String,
    /// File name inside `res/`.
    pub f: String,
    /// MIME type.
    pub m: String,
}

/// Key a URL the way the webview will ask for it.
///
/// Same-origin resources are requested as `prophet://<id>/<path>?<query>`,
/// so they are keyed by path+query. Cross-origin ones are rewritten into
/// `/__ext/<base64url>` at capture time and keyed by that.
pub fn key_for_url(url: &str, main_origin: &str) -> String {
    if let Some(rest) = same_origin_rest(url, main_origin) {
        rest
    } else {
        format!("/__ext/{}", B64URL.encode(url.as_bytes()))
    }
}

const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Returns `path?query` when `url` shares an origin with `main_origin`.
fn same_origin_rest(url: &str, main_origin: &str) -> Option<String> {
    let rest = url.strip_prefix(main_origin)?;
    if rest.is_empty() {
        return Some("/".to_string());
    }
    if !rest.starts_with('/') {
        return None;
    }
    Some(rest.split('#').next().unwrap_or(rest).to_string())
}

/// `scheme://host[:port]` of a URL.
pub fn origin_of(url: &str) -> String {
    match tauri::Url::parse(url) {
        Ok(u) => {
            let mut s = format!("{}://{}", u.scheme(), u.host_str().unwrap_or(""));
            if let Some(p) = u.port() {
                s.push_str(&format!(":{p}"));
            }
            s
        }
        Err(_) => String::new(),
    }
}

fn safe_file_name(url: &str) -> String {
    // Content-addressed-ish: stable, collision-resistant enough, filesystem safe.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let ext = url
        .split('#')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("bin");
    format!("{h:016x}.{ext}")
}

pub fn read_manifest(dir: &Path) -> Vec<ResourceEntry> {
    fs::read_to_string(dir.join("resources.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_manifest(dir: &Path, entries: &[ResourceEntry]) -> Result<(), String> {
    let raw = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    fs::write(dir.join("resources.json"), raw)
        .map_err(|e| format!("could not write resources.json: {e}"))
}

/// Store one resource; returns its manifest entry.
pub fn store_resource(
    dir: &Path,
    url: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<ResourceEntry, String> {
    let res_dir = dir.join("res");
    fs::create_dir_all(&res_dir).map_err(|e| format!("could not create res dir: {e}"))?;
    let file = safe_file_name(url);
    fs::write(res_dir.join(&file), bytes).map_err(|e| format!("could not write resource: {e}"))?;
    Ok(ResourceEntry {
        u: url.to_string(),
        f: file,
        m: mime.to_string(),
    })
}

/// Lookup table from request path -> (file, mime), built once per document.
pub struct ResourceIndex {
    pub dir: PathBuf,
    #[allow(dead_code)]
    pub main_url: String,
    pub by_key: HashMap<String, (String, String)>,
}

impl ResourceIndex {
    pub fn build(dir: &Path, main_url: &str) -> Self {
        let origin = origin_of(main_url);
        let mut by_key: HashMap<String, (String, String)> = HashMap::new();
        // Tracks which query-less aliases came from a URL that had no query.
        // A bare URL always wins the alias: otherwise a framework's data
        // request (`/chapter?_rsc=…`) could shadow the page at `/chapter`.
        let mut alias_is_exact: HashMap<String, bool> = HashMap::new();
        for e in read_manifest(dir) {
            let key = key_for_url(&e.u, &origin);
            let had_query = key.contains('?');
            if let Some(base) = key.split('?').next() {
                let base = base.to_string();
                let replace = match alias_is_exact.get(&base) {
                    None => true,
                    // Only a query-less URL may displace an existing alias.
                    Some(existing_exact) => !*existing_exact && !had_query,
                };
                if replace {
                    by_key.insert(base.clone(), (e.f.clone(), e.m.clone()));
                    alias_is_exact.insert(base, !had_query);
                }
            }
            by_key.insert(key, (e.f, e.m));
        }
        Self {
            dir: dir.to_path_buf(),
            main_url: main_url.to_string(),
            by_key,
        }
    }

    pub fn get(&self, key: &str) -> Option<(Vec<u8>, String)> {
        let (file, mime) = self
            .by_key
            .get(key)
            .or_else(|| self.by_key.get(key.split('?').next().unwrap_or(key)))?;
        let bytes = fs::read(self.dir.join("res").join(file)).ok()?;
        Some((bytes, mime.clone()))
    }
}

// ---- Safari .webarchive import -------------------------------------------

/// A parsed `.webarchive`: the main resource plus its subresources.
pub struct WebArchive {
    pub main_url: String,
    pub main_html: Vec<u8>,
    #[allow(dead_code)]
    pub main_mime: String,
    pub resources: Vec<(String, String, Vec<u8>)>, // (url, mime, bytes)
}

fn dict_get<'a>(d: &'a plist::Dictionary, k: &str) -> Option<&'a plist::Value> {
    d.get(k)
}

fn res_from_dict(d: &plist::Dictionary) -> Option<(String, String, Vec<u8>)> {
    let url = dict_get(d, "WebResourceURL")?.as_string()?.to_string();
    let data = dict_get(d, "WebResourceData")?.as_data()?.to_vec();
    let mime = dict_get(d, "WebResourceMIMEType")
        .and_then(|v| v.as_string())
        .unwrap_or("application/octet-stream")
        .to_string();
    Some((url, mime, data))
}

pub fn parse_webarchive(path: &Path) -> Result<WebArchive, String> {
    let value: plist::Value =
        plist::from_file(path).map_err(|e| format!("not a readable .webarchive: {e}"))?;
    let dict = value
        .as_dictionary()
        .ok_or("unexpected .webarchive structure")?;
    let main = dict
        .get("WebMainResource")
        .and_then(|v| v.as_dictionary())
        .ok_or("missing WebMainResource")?;
    let (main_url, main_mime, main_html) =
        res_from_dict(main).ok_or("malformed WebMainResource")?;

    let mut resources = Vec::new();
    if let Some(subs) = dict.get("WebSubresources").and_then(|v| v.as_array()) {
        for s in subs {
            if let Some(d) = s.as_dictionary() {
                if let Some(r) = res_from_dict(d) {
                    resources.push(r);
                }
            }
        }
    }
    // Nested frame archives contribute their resources too.
    if let Some(frames) = dict.get("WebSubframeArchives").and_then(|v| v.as_array()) {
        for f in frames {
            if let Some(fd) = f.as_dictionary() {
                if let Some(m) = fd.get("WebMainResource").and_then(|v| v.as_dictionary()) {
                    if let Some(r) = res_from_dict(m) {
                        resources.push(r);
                    }
                }
                if let Some(subs) = fd.get("WebSubresources").and_then(|v| v.as_array()) {
                    for s in subs {
                        if let Some(d) = s.as_dictionary() {
                            if let Some(r) = res_from_dict(d) {
                                resources.push(r);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(WebArchive {
        main_url,
        main_html,
        main_mime,
        resources,
    })
}

/// Rewrite cross-origin absolute URLs in text so they resolve through the
/// document's own origin (`/__ext/<b64>`), which is what makes an offline
/// page able to reach its CDN assets. Same-origin absolute URLs are made
/// root-relative so they survive the origin swap.
pub fn rewrite_text(text: &str, main_origin: &str, known: &[String]) -> String {
    let mut out = text.replace(main_origin, "");
    for url in known {
        if url.starts_with(main_origin) || !url.starts_with("http") {
            continue;
        }
        let replacement = format!("/__ext/{}", B64URL.encode(url.as_bytes()));
        if out.contains(url) {
            out = out.replace(url, &replacement);
        }
        let escaped = url.replace('&', "&amp;");
        if out.contains(&escaped) {
            out = out.replace(&escaped, &replacement.replace('&', "&amp;"));
        }
    }
    out
}

pub fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    B64.decode(data).map_err(|e| format!("bad base64: {e}"))
}

pub fn is_texty(mime: &str) -> bool {
    mime.starts_with("text/")
        || mime.contains("javascript")
        || mime.contains("ecmascript")
        || mime.contains("json")
        || mime.contains("xml")
        || mime.contains("svg")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Converts a .webarchive into the on-disk archive layout so the reader
    /// pipeline can be exercised end to end. Run with:
    ///   PROPHET_WA=<in.webarchive> PROPHET_OUT=<dir> cargo test -- --nocapture convert
    #[test]
    fn convert() {
        let (Ok(input), Ok(out)) = (
            std::env::var("PROPHET_WA"),
            std::env::var("PROPHET_OUT"),
        ) else {
            return;
        };
        let wa = parse_webarchive(Path::new(&input)).expect("parse");
        let dir = PathBuf::from(&out);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let origin = origin_of(&wa.main_url);
        let known: Vec<String> = wa.resources.iter().map(|(u, _, _)| u.clone()).collect();
        let mut entries = Vec::new();
        for (url, mime, bytes) in &wa.resources {
            if url.starts_with("data:") {
                continue;
            }
            let stored = if is_texty(mime) {
                rewrite_text(&String::from_utf8_lossy(bytes), &origin, &known).into_bytes()
            } else {
                bytes.clone()
            };
            entries.push(store_resource(&dir, url, mime, &stored).unwrap());
        }
        write_manifest(&dir, &entries).unwrap();
        let html = rewrite_text(&String::from_utf8_lossy(&wa.main_html), &origin, &known);
        fs::write(dir.join("main.html"), html.as_bytes()).unwrap();

        // Mirror the runtime lookup table for the test server.
        let idx = ResourceIndex::build(&dir, &wa.main_url);
        let map: std::collections::HashMap<_, _> = idx
            .by_key
            .iter()
            .map(|(k, (f, m))| (k.clone(), serde_json::json!({ "f": f, "m": m })))
            .collect();
        fs::write(
            dir.join("index.json"),
            serde_json::to_string(&serde_json::json!({
                "mainUrl": wa.main_url,
                "keys": map,
            }))
            .unwrap(),
        )
        .unwrap();
        println!("converted {} resources -> {}", entries.len(), out);
    }
}
