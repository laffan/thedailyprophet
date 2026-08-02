//! iCloud-folder plugin (Rust side).
//!
//! Thin proxy: each Tauri command forwards to the iOS Swift plugin via
//! `run_mobile_plugin`. On non-iOS targets the commands compile to a
//! clear "iOS only" error so the desktop build still links — the demo
//! harness surfaces that error verbatim.
//!
//! Once a folder's bookmark has been resolved and access is held, the
//! Swift side reads/writes by absolute path. That is the same shape the
//! existing `local_sync.rs` `std::fs` code already uses, so wiring this
//! into real Local Sync later is mostly a matter of resolving bookmarks
//! at startup before the existing read/write paths run.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_icloud_folder);

pub struct IcloudFolder<R: Runtime>(#[allow(dead_code)] Option<PluginHandle<R>>);

#[derive(Serialize)]
struct Empty {}

#[derive(Serialize)]
struct ResolveArgs {
    bookmark: String,
}

#[derive(Serialize)]
struct PathArgs {
    path: String,
}

#[derive(Serialize)]
struct WriteArgs {
    path: String,
    contents: String,
}

#[derive(Serialize)]
struct WriteBytesArgs {
    path: String,
    base64: String,
    overwrite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenameArgs {
    path: String,
    new_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    src_path: String,
    dst_dir: String,
}

/// Result carrying the final absolute path of a create / rename / move /
/// copy operation (collision auto-suffixed). The JS side strips the mount
/// base to recover the relative path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathResult {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
    pub path: String,
    pub bookmark: String,
    pub name: String,
    #[serde(default)]
    pub access_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub access_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListResult {
    pub entries: Vec<DirEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadResult {
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadBytesResult {
    /// File bytes, base64-encoded (the bridge can't carry large raw
    /// byte arrays reliably).
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteBytesResult {
    /// Actual filename written (collision auto-suffixed) so the caller
    /// can build a matching markdown ref.
    pub name: String,
}

const IOS_ONLY: &str = "iCloud folder access is iOS-only (no-op on this platform)";

#[tauri::command]
async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<PickResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<PickResult>("pickFolder", Empty {})
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn resolve_bookmark<R: Runtime>(
    app: AppHandle<R>,
    bookmark: String,
) -> Result<ResolveResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ResolveResult>("resolveBookmark", ResolveArgs { bookmark })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, bookmark);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn stop_access<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("stopAccess", PathArgs { path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

/// Arm an NSMetadataQuery under `path` (a resolved iCloud folder). The
/// Swift side emits a `watch-changed` plugin event — payload
/// `{ path }` — whenever items under the folder change, including
/// changes synced in from another device. Non-iCloud provider folders
/// produce no events; callers keep their foreground-reconcile fallback.
#[tauri::command]
async fn start_watch<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("startWatch", PathArgs { path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn stop_watch<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("stopWatch", PathArgs { path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn reveal_in_files<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("revealInFiles", PathArgs { path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn list_dir<R: Runtime>(app: AppHandle<R>, path: String) -> Result<ListResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ListResult>("listDir", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn read_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<ReadResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ReadResult>("readFile", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn write_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    contents: String,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("writeFile", WriteArgs { path, contents })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path, contents);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn read_file_bytes<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<ReadBytesResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ReadBytesResult>("readFileBytes", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn write_file_bytes<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    base64: String,
    overwrite: Option<bool>,
) -> Result<WriteBytesResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<WriteBytesResult>(
                "writeFileBytes",
                WriteBytesArgs { path, base64, overwrite: overwrite.unwrap_or(false) },
            )
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path, base64, overwrite);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn create_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    contents: String,
) -> Result<PathResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<PathResult>("createFile", WriteArgs { path, contents })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path, contents);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn create_dir<R: Runtime>(app: AppHandle<R>, path: String) -> Result<PathResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<PathResult>("createDir", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn rename_entry<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    new_name: String,
) -> Result<PathResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<PathResult>("renameEntry", RenameArgs { path, new_name })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path, new_name);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn delete_entry<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("deleteEntry", PathArgs { path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn move_entry<R: Runtime>(
    app: AppHandle<R>,
    src_path: String,
    dst_dir: String,
) -> Result<PathResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<PathResult>("moveEntry", MoveArgs { src_path, dst_dir })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, src_path, dst_dir);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn copy_entry<R: Runtime>(app: AppHandle<R>, path: String) -> Result<PathResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<PathResult>("copyEntry", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("icloud-folder")
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            resolve_bookmark,
            stop_access,
            start_watch,
            stop_watch,
            reveal_in_files,
            list_dir,
            read_file,
            write_file,
            read_file_bytes,
            write_file_bytes,
            create_file,
            create_dir,
            rename_entry,
            delete_entry,
            move_entry,
            copy_entry
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_icloud_folder)?;
                app.manage(IcloudFolder::<R>(Some(handle)));
            }
            #[cfg(not(target_os = "ios"))]
            {
                app.manage(IcloudFolder::<R>(None));
            }
            Ok(())
        })
        .build()
}
