mod cache;
mod commands;
mod fixtures;
mod inbox;
mod models;
mod wiki;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_connection_status,
            commands::bootstrap_fixture,
            commands::load_local_cache,
            commands::store_local_cache,
            inbox::get_inbox_status,
            inbox::capture_inbox_message,
            wiki::load_wiki_cache,
            wiki::store_wiki_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ya Desktop");
}
