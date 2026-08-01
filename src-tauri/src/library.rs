use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub id: String,
    pub title: String,
    pub source_url: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub excerpt: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub scripts: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSummary {
    pub meta: DocMeta,
    pub state: Option<Value>,
    pub cover_data_uri: Option<String>,
}

/// Payload delivered by the capture toolkit when a snapshot is finished.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDocument {
    pub title: String,
    pub source_url: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub excerpt: Option<String>,
    #[serde(default)]
    pub scripts: bool,
    pub html: String,
    #[serde(default)]
    pub cover_b64: Option<String>,
    #[serde(default)]
    pub cover_mime: Option<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("library"))
}

pub fn ensure_library_dir(app: &AppHandle) -> Result<(), String> {
    fs::create_dir_all(library_root(app)?).map_err(|e| format!("could not create library dir: {e}"))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn doc_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid document id".into());
    }
    Ok(library_root(app)?.join(id))
}

fn mime_for_cover(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "img",
    }
}

fn read_meta(dir: &Path) -> Result<DocMeta, String> {
    let raw = fs::read_to_string(dir.join("meta.json"))
        .map_err(|e| format!("could not read meta.json: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid meta.json: {e}"))
}

fn read_state(dir: &Path) -> Option<Value> {
    let raw = fs::read_to_string(dir.join("state.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn cover_data_uri(dir: &Path, meta: &DocMeta) -> Option<String> {
    let name = meta.cover.as_deref()?;
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    let bytes = fs::read(dir.join(name)).ok()?;
    if bytes.len() > 4 * 1024 * 1024 {
        return None; // never balloon the library listing
    }
    Some(format!(
        "data:{};base64,{}",
        mime_for_cover(name),
        B64.encode(&bytes)
    ))
}

pub fn summary_for(dir: &Path) -> Result<DocSummary, String> {
    let meta = read_meta(dir)?;
    let state = read_state(dir);
    let cover = cover_data_uri(dir, &meta);
    Ok(DocSummary {
        meta,
        state,
        cover_data_uri: cover,
    })
}

pub fn write_meta(dir: &Path, meta: &DocMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(dir.join("meta.json"), raw).map_err(|e| format!("could not write meta.json: {e}"))
}

pub fn create_document(app: &AppHandle, new: NewDocument) -> Result<DocSummary, String> {
    ensure_library_dir(app)?;
    let id = uuid::Uuid::new_v4().to_string();
    let dir = doc_dir(app, &id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create document dir: {e}"))?;

    let size_bytes = new.html.len() as u64;
    fs::write(dir.join("snapshot.html"), &new.html)
        .map_err(|e| format!("could not write snapshot: {e}"))?;

    let mut cover_name: Option<String> = None;
    if let (Some(b64), Some(mime)) = (&new.cover_b64, &new.cover_mime) {
        if let Ok(bytes) = B64.decode(b64) {
            if !bytes.is_empty() && bytes.len() <= 4 * 1024 * 1024 {
                let name = format!("cover.{}", ext_for_mime(mime));
                if fs::write(dir.join(&name), &bytes).is_ok() {
                    cover_name = Some(name);
                }
            }
        }
    }

    let meta = DocMeta {
        id,
        title: if new.title.trim().is_empty() {
            "Untitled".to_string()
        } else {
            new.title.trim().to_string()
        },
        source_url: new.source_url,
        author: new.author,
        excerpt: new.excerpt,
        created_at: now_ms(),
        size_bytes,
        cover: cover_name,
        scripts: new.scripts,
    };
    write_meta(&dir, &meta)?;
    summary_for(&dir)
}

// ---- commands -------------------------------------------------------------

#[tauri::command]
pub fn list_documents(app: AppHandle) -> Result<Vec<DocSummary>, String> {
    ensure_library_dir(&app)?;
    let root = library_root(&app)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("could not read library: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("meta.json").exists() {
            match summary_for(&path) {
                Ok(s) => out.push(s),
                Err(e) => eprintln!("skipping {:?}: {e}", path.file_name()),
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn get_document(app: AppHandle, id: String) -> Result<DocSummary, String> {
    let dir = doc_dir(&app, &id)?;
    if !dir.exists() {
        return Err("document not found".into());
    }
    summary_for(&dir)
}

#[tauri::command]
pub fn get_document_html(app: AppHandle, id: String) -> Result<String, String> {
    let dir = doc_dir(&app, &id)?;
    fs::read_to_string(dir.join("snapshot.html"))
        .map_err(|e| format!("could not read snapshot: {e}"))
}

#[tauri::command]
pub fn save_state(app: AppHandle, id: String, state: Value) -> Result<(), String> {
    if !state.is_object() {
        return Err("state must be an object".into());
    }
    let dir = doc_dir(&app, &id)?;
    if !dir.exists() {
        return Err("document not found".into());
    }
    let raw = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    fs::write(dir.join("state.json"), raw).map_err(|e| format!("could not write state: {e}"))
}

#[tauri::command]
pub fn rename_document(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let dir = doc_dir(&app, &id)?;
    let mut meta = read_meta(&dir)?;
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title cannot be empty".into());
    }
    meta.title = trimmed.chars().take(300).collect();
    write_meta(&dir, &meta)
}

#[tauri::command]
pub fn delete_document(app: AppHandle, id: String) -> Result<(), String> {
    let dir = doc_dir(&app, &id)?;
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("could not delete document: {e}"))
}

#[tauri::command]
pub fn platform() -> String {
    std::env::consts::OS.to_string()
}
