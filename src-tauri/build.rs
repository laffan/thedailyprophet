fn main() {
    // Declaring an app ACL manifest gates ALL app commands: every command
    // must then be granted through a capability. This is what lets us expose
    // exactly six capture_* commands to remote pages in the capture webview
    // (capabilities/capture.json) while everything else stays main-window
    // only (capabilities/main.json).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            // main window (local context)
            "list_documents",
            "get_document",
            "get_document_html",
            "save_state",
            "rename_document",
            "delete_document",
            "platform",
            "export_document",
            "import_document",
            "render_annotations",
            "export_annotations",
            "get_settings",
            "set_settings",
            "sync_now",
            "default_sync_folder",
            "capture_start",
            "capture_control",
            "capture_set_bounds",
            // capture webview (remote context)
            "capture_page_info",
            "capture_progress",
            "capture_count",
            "capture_included",
            "capture_fetch",
            "capture_deliver",
            "capture_failed",
            "capture_archive_begin",
            "capture_archive_resource",
            "capture_archive_finish",
        ])),
    )
    .expect("failed to run tauri-build");
}
