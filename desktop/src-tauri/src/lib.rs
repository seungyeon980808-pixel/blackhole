mod cache;
mod calendar;
mod commands;
mod desk;
mod fixtures;
mod models;
pub mod worker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(desk::Desk::default())
        .setup(|app| {
            desk::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Blackhole running so alarms still ring (macOS: Dock icon reopens).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "macos") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_connection_status,
            commands::bootstrap_fixture,
            commands::load_local_cache,
            commands::store_local_cache,
            desk::load_calendar_state,
            desk::save_calendar_state,
            desk::analyze_text,
            desk::analyze_path,
            desk::analyze_bytes,
            desk::inbox_status,
            desk::inbox_set,
            desk::inbox_results,
            desk::alarms_schedule,
            desk::alarm_ring,
            desk::print_page,
            desk::set_window_look
        ])
        .build(tauri::generate_context!())
        .expect("error while building Blackhole");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(w) = tauri::Manager::get_webview_window(handle, "main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        let _ = (handle, &event);
    });
}
