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
        let allowed = matches!(name.as_str(), "meta.json" | "state.json" | "snapshot.html")
            || name.starts_with("cover.");
        if !allowed || !entry.path().is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| format!("could not read {name}: {e}"))?;
        zw.start_file(&name, opts).map_err(|e| e.to_string())?;
        zw.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    zw.finish().map_err(|e| format!("could not finish archive: {e}"))?;
    Ok(dest_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn import_document(app: AppHandle, path: String) -> Result<DocSummary, String> {
    import_from_path(&app, Path::new(&path))
}

pub fn import_from_path(app: &AppHandle, path: &Path) -> Result<DocSummary, String> {
    library::ensure_library_dir(app)?;

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

    let html = {
        let mut raw = String::new();
        zip.by_name("snapshot.html")
            .map_err(|_| "not a Daily Prophet document (missing snapshot.html)".to_string())?
            .read_to_string(&mut raw)
            .map_err(|e| e.to_string())?;
        raw
    };
    if html.is_empty() {
        return Err("snapshot.html is empty".into());
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
    fs::write(dir.join("snapshot.html"), &html).map_err(|e| e.to_string())?;
    if let Some(raw) = state_raw {
        fs::write(dir.join("state.json"), raw).map_err(|e| e.to_string())?;
    }
    if let Some((name, bytes)) = cover_bytes {
        fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    library::write_meta(&dir, &meta)?;

    library::summary_for(&dir)
}
