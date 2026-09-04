//! The reading notebook — one notebook for the whole library.
//!
//! On disk it is a plain folder inside the app's data directory:
//!
//! ```text
//! notebook/notebook.json             format marker
//! notebook/documents/<doc-id>.json   one file per document's entries
//! notebook/snapshots/<entry-id>.png  snapshot images
//! ```
//!
//! `Notebook.dailyprophet` — the file that travels through the sync folder —
//! is exactly that folder, zipped. Keeping a file per document is what makes
//! writing cheap: adding a note rewrites a few hundred bytes rather than the
//! whole notebook.
//!
//! Entries themselves are opaque to Rust, like reading state: the frontend
//! owns their shape. Merging only needs `id`, `updatedAt` and `deleted`.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::library;

const FORMAT_MARKER: &[u8] = br#"{"format":"notebook","version":1}"#;

/// The name the notebook takes in the sync folder.
pub const NOTEBOOK_FILE: &str = "Notebook.dailyprophet";

/// A deletion is remembered as a tombstone so it propagates through sync
/// instead of the entry returning from another device. They are dropped once
/// every device has had a very long time to see them.
const TOMBSTONE_TTL_MS: u64 = 180 * 24 * 60 * 60 * 1000;

/// A snapshot is a PNG of a dragged region — generous, but not unbounded.
const MAX_SNAPSHOT_BYTES: usize = 12 * 1024 * 1024;

/// One document's page of the notebook.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookDoc {
    pub doc_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub source_url: String,
    /// Whether the section is folded shut in the sidebar.
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub updated_at: u64,
    /// Highlights, bookmarks, snapshots and notes. Opaque here.
    #[serde(default)]
    pub entries: Vec<Value>,
}

pub fn notebook_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("notebook"))
}

fn documents_dir(dir: &Path) -> PathBuf {
    dir.join("documents")
}

fn snapshots_dir(dir: &Path) -> PathBuf {
    dir.join("snapshots")
}

/// Ids reach the filesystem, so they are held to the same shape as document
/// ids: no separators, no dots, nothing that could climb out of the folder.
fn safe_id(id: &str) -> Result<(), String> {
    if library::valid_id(id) {
        Ok(())
    } else {
        Err("invalid notebook id".into())
    }
}

fn ensure_dirs(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(documents_dir(dir))
        .map_err(|e| format!("could not create the notebook folder: {e}"))?;
    fs::create_dir_all(snapshots_dir(dir))
        .map_err(|e| format!("could not create the notebook folder: {e}"))?;
    let marker = dir.join("notebook.json");
    if !marker.exists() {
        let _ = fs::write(marker, FORMAT_MARKER);
    }
    Ok(())
}

fn read_doc(path: &Path) -> Option<NotebookDoc> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<NotebookDoc>(&raw).ok()
}

fn write_doc(dir: &Path, doc: &NotebookDoc) -> Result<(), String> {
    safe_id(&doc.doc_id)?;
    ensure_dirs(dir)?;
    let path = documents_dir(dir).join(format!("{}.json", doc.doc_id));
    let raw = serde_json::to_string(doc).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| format!("could not save the notebook: {e}"))
}

// ---- entry merging --------------------------------------------------------

fn entry_id(entry: &Value) -> Option<&str> {
    entry.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// When an entry last changed. Older notebooks may only carry `createdAt`.
fn entry_stamp(entry: &Value) -> u64 {
    entry
        .get("updatedAt")
        .and_then(|v| v.as_u64())
        .or_else(|| entry.get("createdAt").and_then(|v| v.as_u64()))
        .unwrap_or(0)
}

/// Union two entry lists by id, keeping whichever side was edited last. A
/// tombstone is an edit like any other, which is how a deletion travels.
fn union_entries(a: &[Value], b: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for entry in a.iter().chain(b.iter()) {
        let Some(id) = entry_id(entry).map(str::to_owned) else {
            continue; // an entry without an id cannot be reconciled
        };
        match seen.get(&id) {
            None => {
                seen.insert(id, out.len());
                out.push(entry.clone());
            }
            Some(&idx) => {
                if entry_stamp(entry) > entry_stamp(&out[idx]) {
                    out[idx] = entry.clone();
                }
            }
        }
    }
    out
}

/// Drop tombstones nobody can still be waiting for.
fn prune(entries: Vec<Value>, now: u64) -> Vec<Value> {
    entries
        .into_iter()
        .filter(|e| {
            let deleted = e.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false);
            !deleted || entry_stamp(e) + TOMBSTONE_TTL_MS > now
        })
        .collect()
}

/// Merge one document's page into the local notebook. Returns whether the
/// local copy actually changed.
fn merge_doc(dir: &Path, remote: NotebookDoc) -> Result<bool, String> {
    if safe_id(&remote.doc_id).is_err() {
        return Ok(false);
    }
    let path = documents_dir(dir).join(format!("{}.json", remote.doc_id));
    let local = read_doc(&path);
    let merged = match local.clone() {
        None => remote,
        Some(local) => {
            let newer_is_remote = remote.updated_at > local.updated_at;
            NotebookDoc {
                doc_id: local.doc_id.clone(),
                title: if newer_is_remote && !remote.title.is_empty() {
                    remote.title.clone()
                } else {
                    local.title.clone()
                },
                source_url: if newer_is_remote && !remote.source_url.is_empty() {
                    remote.source_url.clone()
                } else {
                    local.source_url.clone()
                },
                collapsed: if newer_is_remote { remote.collapsed } else { local.collapsed },
                updated_at: local.updated_at.max(remote.updated_at),
                entries: prune(
                    union_entries(&local.entries, &remote.entries),
                    library::now_ms(),
                ),
            }
        }
    };
    if local.as_ref() == Some(&merged) {
        return Ok(false);
    }
    write_doc(dir, &merged)?;
    Ok(true)
}

// ---- commands -------------------------------------------------------------

#[tauri::command]
pub fn notebook_load(app: AppHandle) -> Result<Vec<NotebookDoc>, String> {
    let root = notebook_dir(&app)?;
    ensure_dirs(&root)?;
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(documents_dir(&root)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(doc) = read_doc(&path) {
                    out.push(doc);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn notebook_save_doc(app: AppHandle, doc: NotebookDoc) -> Result<(), String> {
    let mut doc = doc;
    doc.entries = prune(std::mem::take(&mut doc.entries), library::now_ms());
    write_doc(&notebook_dir(&app)?, &doc)
}

/// Stores a snapshot's PNG. `data` is base64 — with or without the data-URL
/// prefix the canvas produces.
#[tauri::command]
pub fn notebook_put_snapshot(app: AppHandle, entry_id: String, data: String) -> Result<u64, String> {
    safe_id(&entry_id)?;
    let root = notebook_dir(&app)?;
    ensure_dirs(&root)?;
    let payload = data.rsplit(',').next().unwrap_or_default();
    let bytes = B64
        .decode(payload.trim())
        .map_err(|e| format!("that snapshot could not be decoded: {e}"))?;
    if bytes.is_empty() {
        return Err("that snapshot was empty".into());
    }
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err("that snapshot is too large".into());
    }
    let path = snapshots_dir(&root).join(format!("{entry_id}.png"));
    fs::write(&path, &bytes).map_err(|e| format!("could not save the snapshot: {e}"))?;
    Ok(bytes.len() as u64)
}

/// A snapshot as a data URI, for showing it in the sidebar.
#[tauri::command]
pub fn notebook_snapshot(app: AppHandle, entry_id: String) -> Result<Option<String>, String> {
    safe_id(&entry_id)?;
    let path = snapshots_dir(&notebook_dir(&app)?).join(format!("{entry_id}.png"));
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(format!("data:image/png;base64,{}", B64.encode(bytes)))),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn notebook_delete_snapshot(app: AppHandle, entry_id: String) -> Result<(), String> {
    safe_id(&entry_id)?;
    let path = snapshots_dir(&notebook_dir(&app)?).join(format!("{entry_id}.png"));
    let _ = fs::remove_file(path);
    Ok(())
}

#[tauri::command]
pub fn notebook_export(app: AppHandle, dest: String) -> Result<String, String> {
    let mut path = PathBuf::from(&dest);
    let has_ext = path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("dailyprophet"))
        .unwrap_or(false);
    if !has_ext {
        path.set_extension("dailyprophet");
    }
    zip_to(&app, &path)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Merges another notebook into this one. Returns how many document pages
/// changed as a result.
#[tauri::command]
pub fn notebook_import(app: AppHandle, path: String) -> Result<u32, String> {
    merge_from_zip(&app, Path::new(&path))
}

// ---- the .dailyprophet file ----------------------------------------------

/// Writes the whole notebook out as a zip.
pub fn zip_to(app: &AppHandle, dest: &Path) -> Result<(), String> {
    zip_dir_to(&notebook_dir(app)?, dest)
}

fn zip_dir_to(dir: &Path, dest: &Path) -> Result<(), String> {
    ensure_dirs(dir)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create folder: {e}"))?;
    }
    // Written beside the destination and moved into place, so a sync folder
    // never briefly holds a half-written notebook.
    let tmp = dest.with_extension("dailyprophet.part");
    let file = File::create(&tmp).map_err(|e| format!("could not create file: {e}"))?;
    let mut zw = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zw.start_file("notebook.json", opts).map_err(|e| e.to_string())?;
    zw.write_all(FORMAT_MARKER).map_err(|e| e.to_string())?;

    for (folder, ext) in [("documents", "json"), ("snapshots", "png")] {
        let Ok(entries) = fs::read_dir(dir.join(folder)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some(ext) {
                continue;
            }
            let name = format!("{folder}/{}", entry.file_name().to_string_lossy());
            let bytes = fs::read(&path).map_err(|e| format!("could not read {name}: {e}"))?;
            zw.start_file(&name, opts).map_err(|e| e.to_string())?;
            zw.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }

    zw.finish().map_err(|e| format!("could not finish the notebook: {e}"))?;
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not write the notebook: {e}")
    })
}

/// Reads a `.dailyprophet` file and merges it into the local notebook.
/// Returns the number of document pages that changed.
pub fn merge_from_zip(app: &AppHandle, path: &Path) -> Result<u32, String> {
    merge_zip_into(&notebook_dir(app)?, path)
}

fn merge_zip_into(dir: &Path, path: &Path) -> Result<u32, String> {
    ensure_dirs(dir)?;
    let file = File::open(path).map_err(|e| format!("could not open the notebook: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("not a notebook file: {e}"))?;
    if zip.by_name("notebook.json").is_err() {
        return Err("not a notebook file".into());
    }
    let mut changed = 0u32;
    let snaps = snapshots_dir(dir);
    for i in 0..zip.len() {
        let Ok(mut f) = zip.by_index(i) else { continue };
        let Some(name) = f.enclosed_name().map(|p| p.to_path_buf()) else {
            continue; // a name that escapes the archive root
        };
        let name = name.to_string_lossy().replace('\\', "/");
        if let Some(file_name) = name.strip_prefix("documents/") {
            if !file_name.ends_with(".json") {
                continue;
            }
            let mut raw = String::new();
            if f.read_to_string(&mut raw).is_err() {
                continue;
            }
            let Ok(doc) = serde_json::from_str::<NotebookDoc>(&raw) else { continue };
            if merge_doc(dir, doc)? {
                changed += 1;
            }
        } else if let Some(file_name) = name.strip_prefix("snapshots/") {
            // A snapshot is written once and never edited, so having it at
            // all is the whole question.
            let stem = file_name.trim_end_matches(".png");
            if !file_name.ends_with(".png") || safe_id(stem).is_err() {
                continue;
            }
            let dest = snaps.join(file_name);
            if dest.exists() {
                continue;
            }
            let mut bytes = Vec::new();
            if f.read_to_end(&mut bytes).is_err() || bytes.len() > MAX_SNAPSHOT_BYTES {
                continue;
            }
            let _ = fs::write(dest, bytes);
        }
    }
    Ok(changed)
}

/// Newest mtime anywhere in the notebook folder — what tells sync whether
/// the local notebook has moved on from the one in the folder.
pub fn local_stamp(app: &AppHandle) -> u64 {
    let Ok(dir) = notebook_dir(app) else { return 0 };
    let mut newest = 0u64;
    for folder in ["documents", "snapshots"] {
        let Ok(entries) = fs::read_dir(dir.join(folder)) else { continue };
        for entry in entries.flatten() {
            newest = newest.max(crate::sync::mtime_ms(&entry.path()));
        }
    }
    newest
}

/// True when there is anything worth publishing at all.
pub fn has_content(app: &AppHandle) -> bool {
    let Ok(dir) = notebook_dir(app) else { return false };
    fs::read_dir(documents_dir(&dir))
        .map(|mut e| e.any(|f| f.is_ok()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, at: u64, note: &str) -> Value {
        json!({ "id": id, "kind": "note", "createdAt": 1, "updatedAt": at, "note": note })
    }

    #[test]
    fn union_keeps_the_last_edit() {
        let a = vec![entry("a", 10, "mine"), entry("b", 5, "b")];
        let b = vec![entry("a", 20, "theirs"), entry("c", 7, "c")];
        let merged = union_entries(&a, &b);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0]["note"], json!("theirs"));
    }

    #[test]
    fn a_tombstone_beats_an_older_edit() {
        let alive = vec![entry("a", 10, "still here")];
        let dead = vec![json!({ "id": "a", "deleted": true, "updatedAt": 30 })];
        let merged = union_entries(&alive, &dead);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["deleted"], json!(true));
        // …and the other way round, since sync merges in both directions.
        let merged = union_entries(&dead, &alive);
        assert_eq!(merged[0]["deleted"], json!(true));
    }

    #[test]
    fn entries_without_an_id_are_dropped() {
        let merged = union_entries(&[json!({ "kind": "note" })], &[entry("a", 1, "a")]);
        assert_eq!(merged.len(), 1);
    }

    /// A notebook folder in a scratch directory, cleaned up on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "prophet-notebook-{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn doc(id: &str, updated: u64, entries: Vec<Value>) -> NotebookDoc {
        NotebookDoc {
            doc_id: id.into(),
            title: format!("Story {id}"),
            source_url: "https://example.com/x".into(),
            collapsed: false,
            updated_at: updated,
            entries,
        }
    }

    #[test]
    fn a_notebook_survives_the_round_trip_through_a_file() {
        let here = Scratch::new("here");
        let there = Scratch::new("there");
        write_doc(here.path(), &doc("aaa", 10, vec![entry("e1", 5, "hello")])).unwrap();
        ensure_dirs(here.path()).unwrap();
        fs::write(snapshots_dir(here.path()).join("e1.png"), b"not really a png").unwrap();

        let file = here.path().join("out.dailyprophet");
        zip_dir_to(here.path(), &file).unwrap();
        assert_eq!(merge_zip_into(there.path(), &file).unwrap(), 1);

        let landed = read_doc(&documents_dir(there.path()).join("aaa.json")).unwrap();
        assert_eq!(landed.title, "Story aaa");
        assert_eq!(landed.entries[0]["note"], json!("hello"));
        assert_eq!(
            fs::read(snapshots_dir(there.path()).join("e1.png")).unwrap(),
            b"not really a png"
        );
        // Merging the same file again is a no-op, so sync does not loop.
        assert_eq!(merge_zip_into(there.path(), &file).unwrap(), 0);
    }

    #[test]
    fn merging_keeps_both_devices_work_and_honours_a_deletion() {
        let mine = Scratch::new("mine");
        let theirs = Scratch::new("theirs");
        let now = library::now_ms();
        // They deleted the shared entry and wrote one of their own.
        write_doc(
            theirs.path(),
            &doc(
                "aaa",
                now,
                vec![
                    json!({ "id": "shared", "deleted": true, "updatedAt": now - 1000 }),
                    entry("theirs", now - 500, "from the iPad"),
                ],
            ),
        )
        .unwrap();
        let file = theirs.path().join("out.dailyprophet");
        zip_dir_to(theirs.path(), &file).unwrap();

        write_doc(
            mine.path(),
            &doc(
                "aaa",
                now - 9000,
                vec![
                    entry("shared", now - 8000, "old"),
                    entry("mine", now - 7000, "from the Mac"),
                ],
            ),
        )
        .unwrap();
        merge_zip_into(mine.path(), &file).unwrap();

        let merged = read_doc(&documents_dir(mine.path()).join("aaa.json")).unwrap();
        let ids: Vec<&str> = merged.entries.iter().filter_map(|e| entry_id(e)).collect();
        assert_eq!(ids, vec!["shared", "mine", "theirs"]);
        // The deletion travelled, and neither device lost its own note.
        assert_eq!(merged.entries[0]["deleted"], json!(true));
        assert_eq!(merged.entries[1]["note"], json!("from the Mac"));
        assert_eq!(merged.updated_at, now);
    }

    #[test]
    fn a_file_that_is_not_a_notebook_is_refused() {
        let dir = Scratch::new("bogus");
        let file = dir.path().join("plain.dailyprophet");
        {
            let mut zw = ZipWriter::new(File::create(&file).unwrap());
            zw.start_file("documents/aaa.json", SimpleFileOptions::default())
                .unwrap();
            zw.write_all(b"{}").unwrap();
            zw.finish().unwrap();
        }
        assert!(merge_zip_into(dir.path(), &file).is_err());
    }

    #[test]
    fn entries_named_to_escape_the_folder_are_ignored() {
        let dir = Scratch::new("escape");
        let file = dir.path().join("evil.dailyprophet");
        {
            let mut zw = ZipWriter::new(File::create(&file).unwrap());
            let opts = SimpleFileOptions::default();
            zw.start_file("notebook.json", opts).unwrap();
            zw.write_all(FORMAT_MARKER).unwrap();
            zw.start_file("documents/../../escaped.json", opts).unwrap();
            zw.write_all(br#"{"docId":"aaa","entries":[]}"#).unwrap();
            zw.start_file("snapshots/../../escaped.png", opts).unwrap();
            zw.write_all(b"nope").unwrap();
            zw.finish().unwrap();
        }
        assert_eq!(merge_zip_into(dir.path(), &file).unwrap(), 0);
        assert!(!dir.path().parent().unwrap().join("escaped.json").exists());
        assert!(!dir.path().parent().unwrap().join("escaped.png").exists());
    }

    #[test]
    fn old_tombstones_are_pruned_but_recent_ones_survive() {
        let now = 400 * 24 * 60 * 60 * 1000u64;
        let kept = prune(
            vec![
                json!({ "id": "old", "deleted": true, "updatedAt": 1 }),
                json!({ "id": "new", "deleted": true, "updatedAt": now - 1000 }),
                entry("alive", 1, "a"),
            ],
            now,
        );
        let ids: Vec<&str> = kept.iter().filter_map(|e| entry_id(e)).collect();
        assert_eq!(ids, vec!["new", "alive"]);
    }
}
