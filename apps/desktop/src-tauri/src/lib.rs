//! Mailpoppy desktop shell.
//!
//! The Rust core stays deliberately thin: it hosts the webview (the React app).
//! It no longer ships or spawns a sidecar binary — Mailpoppy is distributed as an
//! **AgentsPoppy poppy**, so the host runs the provisioning backend
//! (`backend/index.cjs`) on its own shared Node runtime (see the agentspoppy repo's
//! `docs/RUNTIMES.md`). No AWS credentials ever cross into the webview either way.
//!
//! For local development, run the backend from source and this shell talks to it
//! over `http://127.0.0.1:8787`:
//!
//! ```sh
//! npm run dev -w @mailpoppy/desktop-sidecar   # the provisioning backend, via tsx
//! npm run tauri:dev -w @mailpoppy/desktop     # this shell + the vite frontend
//! ```

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opens attachment download URLs (presigned S3) in the system browser —
        // window.open() does nothing in the WKWebView.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // The main window starts hidden (`"visible": false`) so users never
            // see the blank webview flash on launch — the frontend calls
            // `getCurrentWindow().show()` once React has painted its first frame.
            // This is a safety net: if the frontend ever fails to do so (a JS
            // error, a missing permission), reveal the window anyway after a
            // short delay so the app can never get stuck invisible.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mailpoppy");
}
