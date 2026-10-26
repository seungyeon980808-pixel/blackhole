mod cache;
mod calendar;
mod commands;
mod desk;
mod fixtures;
mod mac;
mod models;
pub mod worker;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Started at login: menu bar only, the window stays hidden until asked for.
    let at_login = std::env::args().any(|a| a == "--login");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let action = app.state::<mac::MacState>().shortcuts.lock().unwrap().get(&shortcut.id()).cloned();
                    if let Some(action) = action {
                        mac::run_action(app, &action);
                    }
                })
                .build(),
        )
        .manage(desk::Desk::default())
        .manage(mac::MacState::default())
        .setup(move |app| {
            let handle = app.handle();
            desk::start(handle);
            let dir = app.path().app_data_dir()?;
            let mut settings = mac::load_settings(&dir);
            // First start: offer starting at login, on by default (설정 turns it off for good).
            // (A development build cannot be a login item; the installed app offers it then.)
            if !settings.autostart_offered && mac::set_autostart(true).is_ok() {
                settings.autostart_offered = true;
                settings.autostart = true;
                let _ = mac::save_settings(&dir, &settings);
            }
            *app.state::<mac::MacState>().sound.lock().unwrap() = settings.alarm_sound.clone();
            let _ = mac::build_tray(handle, &settings.shortcuts);
            for problem in mac::register_shortcuts(handle, &settings.shortcuts) {
                eprintln!("블랙홀 단축키: {problem}");
            }
            if at_login {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing a window keeps Blackhole running (menu bar + Dock) so the inbox and alarms go on.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "macos") && window.label() != mac::ALARM {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == mac::QUICK {
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
            desk::inbox_drafts,
            desk::inbox_drafted,
            desk::inbox_put,
            desk::ai_skipped,
            desk::claude_status,
            desk::claude_set_key,
            desk::claude_clear_key,
            desk::claude_check,
            desk::claude_set_options,
            desk::alarms_schedule,
            desk::alarm_ring,
            desk::alarm_missed,
            desk::alarm_current,
            desk::alarm_answer,
            desk::print_page,
            desk::set_window_look,
            desk::share_calendar,
            desk::phone_actions,
            desk::messenger_status,
            desk::messenger_set,
            mac::desk_status,
            mac::desk_set,
            mac::alarm_sound_try,
            mac::put_take,
            mac::quick_put_text,
            mac::quick_put_bytes,
            mac::quick_put_path,
            mac::quick_hide,
            mac::quick_action,
            mac::speech_permission,
            mac::open_privacy,
            mac::notify_test
        ])
        .build(tauri::generate_context!())
        .expect("error while building Blackhole");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        match &event {
            tauri::RunEvent::Reopen { .. } => mac::show_main(handle),
            // Files dropped on the Dock icon, or 「다음으로 열기 → 블랙홀」 in Finder.
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        mac::put_path(handle, &path, "Dock");
                    }
                }
            }
            _ => {}
        }
        let _ = (handle, &event);
    });
}
