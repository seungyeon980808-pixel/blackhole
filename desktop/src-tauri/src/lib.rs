mod cache;
mod calendar;
mod commands;
mod desk;
mod find;
mod fixtures;
mod mac;
mod secret;
mod models;
pub mod worker;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Started at login: menu bar only, the window stays hidden until asked for.
    let at_login = std::env::args().any(|a| a == "--login");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // Main window size and place are remembered (not the quick or alarm window).
        .plugin(tauri_plugin_window_state::Builder::new()
                .with_denylist(&[mac::QUICK, mac::ALARM])
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build())
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
            if settings.autostart && mac::autostart_on() {
                // Refresh the login item (app path, name shown in 「로그인 항목」).
                let _ = mac::set_autostart(true);
            }
            if !settings.autostart_offered && mac::set_autostart(true).is_ok() {
                settings.autostart_offered = true;
                settings.autostart = true;
                let _ = mac::save_settings(&dir, &settings);
            }
            *app.state::<mac::MacState>().sound.lock().unwrap() = settings.alarm_sound.clone();
            let _ = mac::build_app_menu(handle);
            let _ = mac::build_tray(handle, &settings.shortcuts);
            for problem in mac::register_shortcuts(handle, &settings.shortcuts) {
                eprintln!("블랙홀 단축키: {problem}");
            }
            #[cfg(target_os = "macos")]
            mac::watch_right_cmd(handle);
            if settings.board {
                mac::show_board(handle, true);
            }
            if settings.main_widget {
                mac::main_as_widget(handle, true);
            }
            if at_login {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_menu_event(|app, e| mac::menu_event(app, e.id().as_ref()))
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
                if window.label() == mac::BOARD || window.label() == "main" {
                    mac::widget_settle(window.app_handle(), window.label());
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
            mac::notify_test,
            mac::secret_intake,
            mac::quick_memo,
            mac::quick_search,
            mac::quick_today,
            mac::quick_ask,
            mac::ask_sources,
            mac::ask_records,
            mac::memo_tags,
            mac::note_open,
            mac::memo_note,
            mac::board_toggle,
            mac::board_fit,
            mac::board_timer_done,
            mac::board_size,
            mac::board_open,
            mac::quick_open,
            mac::quick_query_take,
            mac::secret_copy,
            mac::secret_reveal,
            mac::secret_remove,
            mac::secrets_list,
            mac::raycast_install
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
                    if url.scheme() == "blackhole" {
                        mac::open_url(handle, url);
                    } else if let Ok(path) = url.to_file_path() {
                        mac::put_path(handle, &path, "Dock");
                    }
                }
            }
            _ => {}
        }
        let _ = (handle, &event);
    });
}
