//! Folder sync — sharing a library between devices.
//!
//! The user nominates a folder (an iCloud Drive / Dropbox / network folder on
//! desktop; the app's own Documents folder on iPadOS, which the Files app
//! exposes). Each document is mirrored there as `<id>.prophet`, and anything
//! found there that isn't in the library is imported.
//!
//! Reading state is *merged* rather than overwritten: highlights and
//! bookmarks are unioned by id, and the newer device wins for scroll
//! position. Two devices annotating the same document therefore keep both
//! sets of annotations instead of one clobbering the other.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager};

use crate::library;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Absolute path of the folder to mirror into, if configured.
    #[serde(default)]
    pub sync_folder: Option<String>,
    /// iOS security-scoped bookmark for `sync_folder`. Sandboxed apps lose
    /// access to a chosen folder on relaunch unless they resolve this first.
    #[serde(default)]
    pub sync_bookmark: Option<String>,
    /// Sync on launch and after each capture.
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub last_sync_at: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: u32,
    pub pulled: u32,
    pub merged: u32,
    pub unchanged: u32,
    pub errors: Vec<String>,
    pub folder: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| format!("could not save settings: {e}"))
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Newest mtime among the files that change when a document is edited.
fn local_stamp(dir: &Path) -> u64 {
    ["state.json", "meta.json"]
        .iter()
        .map(|n| mtime_ms(&dir.join(n)))
        .max()
        .unwrap_or(0)
}

/// A filename a person can recognise. The document id lives inside the
/// archive, so the name is free to be readable.
fn file_name_for(meta: &library::DocMeta) -> String {
    let mut slug: String = meta
        .title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    slug = slug.split_whitespace().collect::<Vec<_>>().join(" ");
    if slug.len() > 70 {
        slug = slug.chars().take(70).collect::<String>().trim_end().to_string();
    }
    if slug.is_empty() || slug.starts_with('.') {
        slug = format!("Document {}", &meta.id[..8.min(meta.id.len())]);
    }
    format!("{slug}.prophet")
}

/// Everything the sync folder currently holds, identified by the document id
/// stored inside each archive.
struct FolderEntry {
    path: PathBuf,
    id: Option<String>,
    source_url: Option<String>,
}

fn scan_folder(folder: &Path) -> Vec<FolderEntry> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(folder) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext == "prophet" {
            let meta = crate::transfer::read_meta_from_archive(&path);
            out.push(FolderEntry {
                id: meta.as_ref().map(|m| m.id.clone()),
                source_url: meta.map(|m| m.source_url),
                path,
            });
        } else if ext == "webarchive" {
            out.push(FolderEntry { path, id: None, source_url: None });
        }
    }
    out
}

/// Picks a name that isn't already taken by a *different* document.
fn unique_path(folder: &Path, desired: &str, taken: &[PathBuf]) -> PathBuf {
    let candidate = folder.join(desired);
    if !taken.contains(&candidate) && !candidate.exists() {
        return candidate;
    }
    let stem = desired.trim_end_matches(".prophet");
    for n in 2..100 {
        let next = folder.join(format!("{stem} ({n}).prophet"));
        if !taken.contains(&next) && !next.exists() {
            return next;
        }
    }
    folder.join(desired)
}

// ---- state merging --------------------------------------------------------

fn array_of<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(|a| a.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

/// Union two annotation lists by `id`, preferring the newer entry.
fn union_by_id(a: &[Value], b: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for item in a.iter().chain(b.iter()) {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            out.push(item.clone());
            continue;
        }
        match seen.get(&id) {
            None => {
                seen.insert(id, out.len());
                out.push(item.clone());
            }
            Some(&idx) => {
                let existing_at = out[idx].get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
                let incoming_at = item.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
                if incoming_at > existing_at {
                    out[idx] = item.clone();
                }
            }
        }
    }
    out
}

/// Merge two reading states. Annotations are unioned; position follows
/// whichever device read the document more recently.
pub fn merge_state(local: &Value, remote: &Value) -> Value {
    let local_seen = local.get("lastOpenedAt").and_then(|v| v.as_u64()).unwrap_or(0);
    let remote_seen = remote.get("lastOpenedAt").and_then(|v| v.as_u64()).unwrap_or(0);
    let (newer, older) = if remote_seen > local_seen {
        (remote, local)
    } else {
        (local, remote)
    };

    let mut merged: Map<String, Value> = newer
        .as_object()
        .cloned()
        .unwrap_or_default();

    merged.insert(
        "highlights".into(),
        Value::Array(union_by_id(array_of(local, "highlights"), array_of(remote, "highlights"))),
    );
    merged.insert(
        "bookmarks".into(),
        Value::Array(union_by_id(array_of(local, "bookmarks"), array_of(remote, "bookmarks"))),
    );

    // Per-page positions: keep every page either side knows about.
    let mut pages: Map<String, Value> = older
        .get("pages")
        .and_then(|p| p.as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(newer_pages) = newer.get("pages").and_then(|p| p.as_object()) {
        for (k, v) in newer_pages {
            pages.insert(k.clone(), v.clone());
        }
    }
    if !pages.is_empty() {
        merged.insert("pages".into(), Value::Object(pages));
    }
    merged.insert(
        "lastOpenedAt".into(),
        Value::from(local_seen.max(remote_seen)),
    );
    Value::Object(merged)
}

fn read_state(dir: &Path) -> Value {
    fs::read_to_string(dir.join("state.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

// ---- commands -------------------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

/// The folder used when the platform can't offer a folder picker (iOS): the
/// app's own Documents directory, which the Files app exposes.
#[tauri::command]
pub fn default_sync_folder(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("no documents dir: {e}"))?
        .join("The Daily Prophet");
    fs::create_dir_all(&dir).map_err(|e| format!("could not create folder: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let mut s = settings;
    if let Some(folder) = s.sync_folder.clone() {
        let trimmed = folder.trim().to_string();
        if trimmed.is_empty() {
            s.sync_folder = None;
        } else {
            let path = PathBuf::from(&trimmed);
            fs::create_dir_all(&path)
                .map_err(|e| format!("could not use that folder: {e}"))?;
            // Prove it's writable now rather than failing at sync time.
            let probe = path.join(".prophet-write-test");
            match fs::write(&probe, b"ok") {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                }
                // On iOS the folder is only reachable while its bookmark is
                // resolved; a failure here isn't necessarily fatal.
                Err(e) if s.sync_bookmark.is_none() => {
                    return Err(format!("that folder is not writable: {e}"))
                }
                Err(_) => {}
            }
            s.sync_folder = Some(path.to_string_lossy().into_owned());
        }
    }
    save_settings(&app, &s)?;
    Ok(s)
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    let settings = load_settings(&app);
    let folder = settings
        .sync_folder
        .clone()
        .ok_or("no sync folder is configured")?;
    let report = run_sync(&app, Path::new(&folder))?;
    let mut s = settings;
    s.last_sync_at = library::now_ms();
    let _ = save_settings(&app, &s);
    Ok(report)
}

/// Runs a sync if one is configured and enabled; used after captures/imports.
pub fn auto_sync(app: &AppHandle) {
    let settings = load_settings(app);
    if !settings.auto_sync {
        return;
    }
    if let Some(folder) = settings.sync_folder.clone() {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = run_sync(&app, Path::new(&folder)) {
                eprintln!("auto sync failed: {e}");
            }
        });
    }
}

pub fn run_sync(app: &AppHandle, folder: &Path) -> Result<SyncReport, String> {
    let mut report = SyncReport {
        folder: folder.to_string_lossy().into_owned(),
        ..Default::default()
    };
    fs::create_dir_all(folder).map_err(|e| format!("could not open sync folder: {e}"))?;
    library::ensure_library_dir(app)?;
    let root = library::library_root(app)?;

    let root_docs: Vec<String> = fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_dir() && e.path().join("meta.json").exists())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|id| library::valid_id(id))
                .collect()
        })
        .unwrap_or_default();

    let folder_entries = scan_folder(folder);

    // --- pull: anything in the folder this device doesn't have yet
    for entry in &folder_entries {
        match &entry.id {
            // A .prophet we can identify.
            Some(id) if root_docs.contains(id) => {
                let local_dir = root.join(id);
                match crate::transfer::read_state_from_archive(&entry.path) {
                    Ok(Some(remote_state)) => {
                        let local_state = read_state(&local_dir);
                        let merged = merge_state(&local_state, &remote_state);
                        if merged != local_state {
                            let raw = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
                            if let Err(e) = fs::write(local_dir.join("state.json"), raw) {
                                report.errors.push(format!("{id}: {e}"));
                            } else {
                                report.merged += 1;
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => report.errors.push(format!("{id}: {e}")),
                }
            }
            _ => {
                // A .webarchive already imported once shouldn't come back on
                // every sync, so skip one whose source we already hold.
                if entry.id.is_none() {
                    let name = entry.path.file_name().unwrap_or_default().to_string_lossy();
                    if !name.to_lowercase().ends_with(".webarchive") {
                        continue;
                    }
                }
                if let Some(url) = &entry.source_url {
                    if root_docs.iter().any(|id| {
                        library::summary_for(&root.join(id))
                            .map(|s| &s.meta.source_url == url)
                            .unwrap_or(false)
                    }) {
                        continue;
                    }
                }
                match crate::transfer::import_from_path(app, &entry.path) {
                    Ok(_) => report.pulled += 1,
                    Err(e) => report.errors.push(format!(
                        "{}: {e}",
                        entry.path.file_name().unwrap_or_default().to_string_lossy()
                    )),
                }
            }
        }
    }

    // --- push: mirror the library out, under readable names
    let entries = fs::read_dir(&root).map_err(|e| format!("could not read library: {e}"))?;
    let mut written: Vec<PathBuf> = folder_entries.iter().map(|e| e.path.clone()).collect();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || !dir.join("meta.json").exists() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !library::valid_id(&id) {
            continue;
        }
        let Ok(summary) = library::summary_for(&dir) else {
            continue;
        };
        let desired = file_name_for(&summary.meta);

        // Find this document's existing file by id, wherever it sits.
        let existing = folder_entries
            .iter()
            .find(|e| e.id.as_deref() == Some(id.as_str()))
            .map(|e| e.path.clone());

        let dest = match existing {
            Some(p) => {
                // The title may have changed since it was last written.
                if p.file_name().map(|n| n.to_string_lossy().into_owned())
                    != Some(desired.clone())
                {
                    let renamed = unique_path(folder, &desired, &written);
                    if fs::rename(&p, &renamed).is_ok() {
                        written.push(renamed.clone());
                        renamed
                    } else {
                        p
                    }
                } else {
                    p
                }
            }
            None => {
                let fresh = unique_path(folder, &desired, &written);
                written.push(fresh.clone());
                fresh
            }
        };

        let local = local_stamp(&dir);
        // A one-second grace avoids re-pushing on filesystems with coarse
        // timestamps, and the merge step above may have just touched state.
        if dest.exists() && mtime_ms(&dest) + 1000 >= local {
            report.unchanged += 1;
            continue;
        }
        match crate::transfer::export_document_to(app, &id, &dest) {
            Ok(_) => report.pushed += 1,
            Err(e) => report.errors.push(format!("{id}: {e}")),
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hl(id: &str, at: u64, color: &str) -> Value {
        json!({ "id": id, "exact": format!("quote {id}"), "color": color, "createdAt": at })
    }

    fn meta_named(title: &str) -> library::DocMeta {
        library::DocMeta {
            id: "0f8a1c22-1111-2222-3333-444455556666".into(),
            title: title.into(),
            source_url: "https://example.com/x".into(),
            author: None,
            excerpt: None,
            created_at: 0,
            size_bytes: 0,
            cover: None,
            scripts: true,
            format: 2,
        }
    }

    #[test]
    fn sync_files_are_named_after_the_document() {
        assert_eq!(file_name_for(&meta_named("The Elevator Story")), "The Elevator Story.prophet");
    }

    #[test]
    fn sync_file_names_stay_filesystem_safe() {
        let name = file_name_for(&meta_named("Bad/Name: \"quoted\" <tag>|pipe?"));
        for bad in ['/', '\\', ':', '*', '?', '"', '<', '>', '|'] {
            assert!(!name.contains(bad), "{name} still contains {bad}");
        }
        assert!(name.ends_with(".prophet"));
    }

    #[test]
    fn very_long_titles_are_trimmed_but_still_readable() {
        let name = file_name_for(&meta_named(&"word ".repeat(60)));
        assert!(name.len() < 90, "too long: {} chars", name.len());
        assert!(name.starts_with("word"));
    }

    #[test]
    fn an_empty_title_still_produces_a_usable_name() {
        let name = file_name_for(&meta_named("   "));
        assert!(name.starts_with("Document "), "{name}");
        assert!(name.ends_with(".prophet"));
        assert!(!name.starts_with('.'));
    }

    #[test]
    fn merge_keeps_annotations_from_both_devices() {
        let laptop = json!({
            "lastOpenedAt": 100u64,
            "scrollY": 500, "progress": 0.5,
            "highlights": [hl("a", 10, "sun"), hl("b", 20, "mint")],
            "bookmarks": [json!({ "id": "b1", "label": "Chapter 1", "createdAt": 5 })],
        });
        let ipad = json!({
            "lastOpenedAt": 200u64,
            "scrollY": 900, "progress": 0.9,
            "highlights": [hl("a", 10, "sun"), hl("c", 30, "sky")],
            "bookmarks": [json!({ "id": "b2", "label": "Chapter 2", "createdAt": 25 })],
        });

        let merged = merge_state(&laptop, &ipad);
        let ids: Vec<&str> = merged["highlights"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["id"].as_str().unwrap())
            .collect();
        // Union, and the one they share is not duplicated.
        assert_eq!(ids.len(), 3, "expected a union of highlights, got {ids:?}");
        for want in ["a", "b", "c"] {
            assert!(ids.contains(&want), "missing highlight {want} in {ids:?}");
        }
        assert_eq!(merged["bookmarks"].as_array().unwrap().len(), 2);
        // Position follows the device that read it more recently.
        assert_eq!(merged["scrollY"], json!(900));
        assert_eq!(merged["lastOpenedAt"], json!(200u64));
    }

    #[test]
    fn merge_is_symmetric_for_annotations() {
        let a = json!({ "lastOpenedAt": 1u64, "highlights": [hl("x", 1, "sun")], "bookmarks": [] });
        let b = json!({ "lastOpenedAt": 2u64, "highlights": [hl("y", 2, "rose")], "bookmarks": [] });
        let ab = merge_state(&a, &b);
        let ba = merge_state(&b, &a);
        let mut ids_ab: Vec<String> = ab["highlights"].as_array().unwrap().iter()
            .map(|h| h["id"].as_str().unwrap().to_string()).collect();
        let mut ids_ba: Vec<String> = ba["highlights"].as_array().unwrap().iter()
            .map(|h| h["id"].as_str().unwrap().to_string()).collect();
        ids_ab.sort();
        ids_ba.sort();
        assert_eq!(ids_ab, ids_ba, "merge order changed which annotations survive");
    }

    #[test]
    fn merge_prefers_the_newer_version_of_a_shared_annotation() {
        // The same highlight recoloured on one device.
        let old = json!({ "lastOpenedAt": 1u64, "highlights": [hl("a", 10, "sun")], "bookmarks": [] });
        let new = json!({ "lastOpenedAt": 2u64, "highlights": [hl("a", 50, "mint")], "bookmarks": [] });
        let merged = merge_state(&old, &new);
        let items = merged["highlights"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["color"], json!("mint"));
    }

    #[test]
    fn merge_unions_per_page_positions() {
        let a = json!({
            "lastOpenedAt": 5u64, "highlights": [], "bookmarks": [],
            "pages": { "/one": { "scrollY": 10 } }
        });
        let b = json!({
            "lastOpenedAt": 9u64, "highlights": [], "bookmarks": [],
            "pages": { "/two": { "scrollY": 20 } }
        });
        let merged = merge_state(&a, &b);
        let pages = merged["pages"].as_object().unwrap();
        assert!(pages.contains_key("/one") && pages.contains_key("/two"), "lost a page position");
    }

    #[test]
    fn merge_survives_empty_and_missing_fields() {
        let empty = json!({});
        let real = json!({ "lastOpenedAt": 3u64, "highlights": [hl("z", 1, "sky")], "bookmarks": [] });
        let merged = merge_state(&empty, &real);
        assert_eq!(merged["highlights"].as_array().unwrap().len(), 1);
        let merged2 = merge_state(&real, &empty);
        assert_eq!(merged2["highlights"].as_array().unwrap().len(), 1);
    }
}
