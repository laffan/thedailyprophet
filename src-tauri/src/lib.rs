mod capture;
mod library;
mod transfer;

use tauri::Emitter;

/// Shared HTTP client used as a fallback fetcher for page resources the
/// capture webview cannot read itself (cross-origin without CORS).
pub struct Fetcher(pub reqwest::Client);

const FALLBACK_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = reqwest::Client::builder()
        .user_agent(FALLBACK_UA)
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .expect("failed to build http client");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Fetcher(client))
        .invoke_handler(tauri::generate_handler![
            library::list_documents,
            library::get_document,
            library::get_document_html,
            library::save_state,
            library::rename_document,
            library::delete_document,
            library::platform,
            transfer::export_document,
            transfer::import_document,
            capture::capture_start,
            capture::capture_control,
            capture::capture_page_info,
            capture::capture_progress,
            capture::capture_count,
            capture::capture_fetch,
            capture::capture_deliver,
            capture::capture_failed,
        ])
        .setup(|app| {
            library::ensure_library_dir(app.handle())?;

            // .prophet files passed on the command line (Windows/Linux file
            // associations); macOS/iOS arrive via RunEvent::Opened below.
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                for arg in std::env::args().skip(1) {
                    if arg.to_lowercase().ends_with(".prophet") {
                        let _ = transfer::import_from_path(&handle, std::path::Path::new(&arg));
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "capture" {
                if let tauri::WindowEvent::Destroyed = event {
                    let _ = tauri::Manager::app_handle(window).emit("capture://closed", ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building The Daily Prophet");

    app.run(|app_handle, event| {
        let _ = &app_handle;
        let _ = &event;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if url.scheme() != "file" {
                    continue;
                }
                if let Ok(path) = url.to_file_path() {
                    match transfer::import_from_path(app_handle, &path) {
                        Ok(summary) => {
                            let _ = app_handle.emit("library://imported", summary);
                        }
                        Err(e) => {
                            let _ = app_handle.emit("library://import-error", e);
                        }
                    }
                }
            }
        }
    });
}
