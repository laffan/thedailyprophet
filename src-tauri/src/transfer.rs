//! Export/import of `.prophet` files.
//!
//! A `.prophet` file is a plain zip archive:
//!   prophet.json    format marker { "format": "prophet", "version": 1 }
//!   meta.json       document metadata
//!   snapshot.html   the self-contained snapshot
//!   state.json      reading state: scroll position, bookmarks, highlights
//!   cover.<ext>     optional cover image

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::library::{self, DocSummary};

const FORMAT_MARKER: &[u8] = br#"{"format":"prophet","version":1}"#;

#[tauri::command]
pub fn export_document(app: AppHandle, id: String, dest: String) -> Result<String, String> {
    let dir = library::doc_dir(&app, &id)?;
    if !dir.exists() {
        return Err("document not found".into());
    }

    let mut dest_path = PathBuf::from(&dest);
    let has_ext = dest_path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("prophet"))
        .unwrap_or(false);
    if !has_ext {
        dest_path.set_extension("prophet");
    }

    let file = File::create(&dest_path).map_err(|e| format!("could not create file: {e}"))?;
    let mut zw = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zw.start_file("prophet.json", opts)
        .map_err(|e| e.to_string())?;
    zw.write_all(FORMAT_MARKER).map_err(|e| e.to_string())?;

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let allowed = matches!(
            name.as_str(),
            "meta.json" | "state.json" | "snapshot.html" | "main.html" | "resources.json"
        ) || name.starts_with("cover.");
        if !allowed || !entry.path().is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| format!("could not read {name}: {e}"))?;
        zw.start_file(&name, opts).map_err(|e| e.to_string())?;
        zw.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    // Resource map (format 2).
    if let Ok(res) = fs::read_dir(dir.join("res")) {
        for entry in res.flatten() {
            if !entry.path().is_file() {
                continue;
            }
            let name = format!("res/{}", entry.file_name().to_string_lossy());
            let bytes = fs::read(entry.path()).map_err(|e| format!("could not read {name}: {e}"))?;
            zw.start_file(&name, opts).map_err(|e| e.to_string())?;
            zw.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }

    zw.finish().map_err(|e| format!("could not finish archive: {e}"))?;
    Ok(dest_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn import_document(app: AppHandle, path: String) -> Result<DocSummary, String> {
    import_from_path(&app, Path::new(&path))
}

/// Import a Safari `.webarchive`. Its model — untouched main resource plus
/// subresources keyed by original URL — is the same one our format-2
/// archives use, so this is a direct translation.
pub fn import_webarchive(app: &AppHandle, path: &Path) -> Result<DocSummary, String> {
    let wa = crate::archive::parse_webarchive(path)?;
    let (id, dir) = library::new_document_dir(app)?;

    let result = (|| -> Result<DocSummary, String> {
        let origin = crate::archive::origin_of(&wa.main_url);
        let mut entries = Vec::new();
        let mut total: u64 = 0;

        for (url, mime, bytes) in &wa.resources {
            // Data URLs are already self-contained; leave them in the markup.
            if url.starts_with("data:") {
                continue;
            }
            let known: Vec<String> = wa.resources.iter().map(|(u, _, _)| u.clone()).collect();
            let stored: Vec<u8> = if crate::archive::is_texty(mime) {
                // Rewrite absolute URLs inside CSS/JS so nested references
                // (e.g. @import, url(...)) resolve through our origin too.
                let text = String::from_utf8_lossy(bytes).to_string();
                crate::archive::rewrite_text(&text, &origin, &known).into_bytes()
            } else {
                bytes.clone()
            };
            total += stored.len() as u64;
            entries.push(crate::archive::store_resource(&dir, url, mime, &stored)?);
        }
        crate::archive::write_manifest(&dir, &entries)?;

        let known: Vec<String> = wa.resources.iter().map(|(u, _, _)| u.clone()).collect();
        let html_raw = String::from_utf8_lossy(&wa.main_html).to_string();
        let html = crate::archive::rewrite_text(&html_raw, &origin, &known);
        fs::write(dir.join("main.html"), html.as_bytes())
            .map_err(|e| format!("could not write main.html: {e}"))?;

        let title = extract_title(&html_raw).unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Untitled".into())
        });
        let meta = library::DocMeta {
            id: id.clone(),
            title,
            source_url: wa.main_url.clone(),
            author: None,
            excerpt: extract_meta(&html_raw, "description"),
            created_at: library::now_ms(),
            size_bytes: html.len() as u64 + total,
            cover: None,
            scripts: true,
            format: 2,
        };
        library::write_meta(&dir, &meta)?;
        library::summary_for(&dir)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&dir);
    }
    let summary = result?;
    crate::protocol::invalidate(&summary.meta.id);
    Ok(summary)
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let end = lower[open_end..].find("</title>")? + open_end;
    let raw = html[open_end..end].trim();
    if raw.is_empty() {
        return None;
    }
    Some(
        raw.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&#x27;", "'")
            .replace("&quot;", "\"")
            .chars()
            .take(300)
            .collect(),
    )
}

fn extract_meta(html: &str, name: &str) -> Option<String> {
    let needle = format!("name=\"{name}\"");
    let lower = html.to_lowercase();
    let at = lower.find(&needle)?;
    let tag_start = lower[..at].rfind("<meta")?;
    let tag_end = lower[tag_start..].find('>')? + tag_start;
    let tag = &html[tag_start..tag_end];
    let ci = tag.to_lowercase().find("content=")?;
    let rest = &tag[ci + 8..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = rest[1..].find(quote)? + 1;
    Some(rest[1..end].chars().take(400).collect())
}

pub fn import_from_path(app: &AppHandle, path: &Path) -> Result<DocSummary, String> {
    library::ensure_library_dir(app)?;

    if path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("webarchive"))
        .unwrap_or(false)
    {
        return import_webarchive(app, path);
    }

    let file = File::open(path).map_err(|e| format!("could not open file: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("not a .prophet archive: {e}"))?;

    let mut meta: library::DocMeta = {
        let mut raw = String::new();
        zip.by_name("meta.json")
            .map_err(|_| "not a Daily Prophet document (missing meta.json)".to_string())?
            .read_to_string(&mut raw)
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| format!("invalid meta.json: {e}"))?
    };

    // Format 1 carries snapshot.html; format 2 carries main.html + res/.
    let mut html = String::new();
    let mut html_name = "snapshot.html";
    if let Ok(mut f) = zip.by_name("snapshot.html") {
        f.read_to_string(&mut html).map_err(|e| e.to_string())?;
    }
    if html.is_empty() {
        html_name = "main.html";
        let mut f = zip
            .by_name("main.html")
            .map_err(|_| "not a Daily Prophet document (no page content)".to_string())?;
        f.read_to_string(&mut html).map_err(|e| e.to_string())?;
    }
    if html.is_empty() {
        return Err("document contains no page content".into());
    }

    let state_raw: Option<String> = match zip.by_name("state.json") {
        Ok(mut f) => {
            let mut raw = String::new();
            f.read_to_string(&mut raw).map_err(|e| e.to_string())?;
            serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .filter(|v| v.is_object())
                .map(|_| raw)
        }
        Err(_) => None,
    };

    let mut cover_entry: Option<String> = None;
    for i in 0..zip.len() {
        if let Ok(f) = zip.by_index(i) {
            let name = f.name().to_string();
            if name.starts_with("cover.") && !name.contains('/') && !name.contains("..") {
                cover_entry = Some(name);
                break;
            }
        }
    }
    let cover_bytes: Option<(String, Vec<u8>)> = match &cover_entry {
        Some(name) => {
            let mut f = zip.by_name(name).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if buf.is_empty() || buf.len() > 4 * 1024 * 1024 {
                None
            } else {
                Some((name.clone(), buf))
            }
        }
        None => None,
    };

    // Keep the original id when it's free (re-importing the same document on
    // another machine stays stable); otherwise mint a fresh one.
    let id = if library::valid_id(&meta.id) && !library::doc_dir(app, &meta.id)?.exists() {
        meta.id.clone()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    meta.id = id.clone();
    meta.size_bytes = html.len() as u64;
    if meta.created_at == 0 {
        meta.created_at = library::now_ms();
    }
    meta.cover = cover_bytes.as_ref().map(|(n, _)| n.clone());

    let dir = library::doc_dir(app, &id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create document dir: {e}"))?;
    fs::write(dir.join(html_name), &html).map_err(|e| e.to_string())?;

    // Resource map entries (format 2).
    for i in 0..zip.len() {
        let (name, bytes) = match zip.by_index(i) {
            Ok(mut f) => {
                let name = f.name().to_string();
                if !(name == "resources.json" || name.starts_with("res/")) || name.contains("..") {
                    continue;
                }
                let mut buf = Vec::new();
                f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
                (name, buf)
            }
            Err(_) => continue,
        };
        let target = dir.join(&name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(target, bytes).map_err(|e| e.to_string())?;
    }
    if let Some(raw) = state_raw {
        fs::write(dir.join("state.json"), raw).map_err(|e| e.to_string())?;
    }
    if let Some((name, bytes)) = cover_bytes {
        fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    library::write_meta(&dir, &meta)?;

    library::summary_for(&dir)
}
