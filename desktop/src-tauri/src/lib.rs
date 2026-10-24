mod cache;
mod commands;
mod fixtures;
mod models;
pub mod worker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_connection_status,
            commands::bootstrap_fixture,
            commands::load_local_cache,
            commands::store_local_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ya Desktop");
}
