//! Tauri commands for the calendar app: state file, local worker, test-folder inbox,
//! native alarms (window forward + repeating sound) and printing.

use crate::calendar::{self, AlarmSpec, InboxResult};
use crate::worker::{
    config::WorkerConfig,
    error::{ErrorCode, WorkerError},
    inbox::{scan_once, Layout},
    pipeline::{analyze_with, source_type_for, Engines, Input},
    proposal::{EngineId, Proposal, SourceType},
};
use chrono::{DateTime, FixedOffset};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

const INBOX_EVERY: Duration = Duration::from_secs(15);
/// A Drive upload is usually complete within this; the scan leaves newer files for later.
const INBOX_SETTLE: Duration = Duration::from_secs(3);
/// Drafts are offered for inbox files this recent (older ones were handled before).
const DRAFT_WINDOW: Duration = Duration::from_secs(3 * 24 * 3600);
const RING_LIMIT: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
struct InboxRun {
    enabled: bool,
    root: PathBuf,
    test_root: PathBuf,
    last_scan_at: Option<String>,
    last_error: Option<String>,
    running: bool,
}

#[derive(Default)]
pub struct Desk {
    inbox: Arc<Mutex<InboxRun>>,
    drafts: Mutex<calendar::DraftScan>,
    /// Set when a new inbox file was seen: the scanner runs now instead of waiting.
    kick: Arc<AtomicBool>,
    drafted: Mutex<std::collections::HashSet<String>>,
    messenger: Arc<Mutex<MessengerRun>>,
    alarms: Arc<Mutex<Vec<AlarmSpec>>>,
    ringing: Arc<AtomicBool>,
}

#[derive(Default)]
struct MessengerRun {
    enabled: bool,
    last_poll_at: Option<String>,
    last_error: Option<String>,
    written: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessengerStatus {
    configured: bool,
    config_path: String,
    enabled: bool,
    last_poll_at: Option<String>,
    last_error: Option<String>,
    written: usize,
}

fn messenger_status_of(run: &MessengerRun) -> MessengerStatus {
    let config = crate::worker::messenger::MessengerConfig::load();
    MessengerStatus {
        configured: matches!(config, Ok(Some(_))),
        config_path: crate::worker::messenger::MessengerConfig::path().to_string_lossy().into_owned(),
        enabled: run.enabled,
        last_poll_at: run.last_poll_at.clone(),
        last_error: run.last_error.clone().or_else(|| config.err().map(|e| e.message)),
        written: run.written,
    }
}

/// Discord·Slack input status (configuration is a file outside the repo).
#[tauri::command]
pub fn messenger_status(desk: tauri::State<'_, Desk>) -> MessengerStatus {
    messenger_status_of(&desk.messenger.lock().unwrap())
}

#[tauri::command]
pub fn messenger_set(desk: tauri::State<'_, Desk>, enabled: bool) -> MessengerStatus {
    let mut run = desk.messenger.lock().unwrap();
    run.enabled = enabled;
    run.last_error = None;
    messenger_status_of(&run)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxStatus {
    available: bool,
    /// Drive 「블랙홀」 folder found on this Mac (offered in 설정, never chosen automatically).
    drive_root: Option<String>,
    test_root: String,
    enabled: bool,
    root: String,
    last_scan_at: Option<String>,
    last_error: Option<String>,
    running: bool,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("앱 데이터 경로를 열 수 없습니다: {e}"))
}

fn io_error(e: impl std::fmt::Display) -> WorkerError {
    WorkerError::new(ErrorCode::Io, e.to_string())
}

fn parse_now(now: &str) -> Result<DateTime<FixedOffset>, WorkerError> {
    DateTime::parse_from_rfc3339(now).map_err(|e| WorkerError::new(ErrorCode::UnsupportedInput, format!("기준 시각 형식 오류({now}): {e}")))
}

/// The same analysis the `blackhole-worker` CLI runs (engine A, config file + BLACKHOLE_* env).
fn run_analysis(input: &Input, now: DateTime<FixedOffset>) -> Result<Proposal, WorkerError> {
    let config = WorkerConfig::from_env()?;
    let source = match input {
        Input::File(path) => source_type_for(path)?.0,
        Input::Text(_) => SourceType::Text,
    };
    let (whisper, kordoc) = (config.whisper(), config.kordoc());
    let (text_chat, direct_chat) = (config.chat_for(source, false), config.chat_for(source, true));
    let engines = Engines { transcriber: &whisper, reader: &kordoc, text_model: &text_chat, direct_model: &direct_chat };
    analyze_with(input, EngineId::TextFirst, now, &engines, &config.options)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, WorkerError> + Send + 'static) -> Result<T, WorkerError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(io_error)?
}

#[tauri::command]
pub fn load_calendar_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    calendar::load_state(&data_dir(&app)?).map_err(|e| format!("달력 자료를 불러올 수 없습니다: {e}"))
}

#[tauri::command]
pub fn save_calendar_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    calendar::save_state(&data_dir(&app)?, &state).map_err(|e| format!("달력 자료를 저장할 수 없습니다: {e}"))
}

#[tauri::command]
pub async fn analyze_text(text: String, now: String) -> Result<Proposal, WorkerError> {
    let now = parse_now(&now)?;
    blocking(move || run_analysis(&Input::Text(&text), now)).await
}

/// A file dropped on the window: copied into 입력/ first, the original is only read.
#[tauri::command]
pub async fn analyze_path(app: AppHandle, path: String, now: String) -> Result<Proposal, WorkerError> {
    let now = parse_now(&now)?;
    let dir = data_dir(&app).map_err(io_error)?;
    blocking(move || {
        let from = Path::new(&path);
        source_type_for(from)?;
        let bytes = std::fs::read(from)?;
        let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let kept = calendar::keep_input(&dir, &name, &bytes)?;
        run_analysis(&Input::File(&kept), now)
    })
    .await
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((a * 16 + b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Photo, recording or file from the app: raw bytes in the request body, name in `x-file-name`.
#[tauri::command]
pub async fn analyze_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Proposal, WorkerError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(WorkerError::new(ErrorCode::UnsupportedInput, "파일 내용이 없습니다."));
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let name = percent_decode(&header("x-file-name").unwrap_or_else(|| "input".into()));
    let now = parse_now(&header("x-now").unwrap_or_default())?;
    let bytes = bytes.clone();
    let dir = data_dir(&app).map_err(io_error)?;
    blocking(move || {
        let kept = calendar::keep_input(&dir, &name, &bytes)?;
        run_analysis(&Input::File(&kept), now)
    })
    .await
}

fn status(run: &InboxRun) -> InboxStatus {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    InboxStatus {
        available: true,
        drive_root: calendar::find_drive_blackhole(&home).map(|p| p.to_string_lossy().into_owned()),
        test_root: run.test_root.to_string_lossy().into_owned(),
        enabled: run.enabled,
        root: run.root.to_string_lossy().into_owned(),
        last_scan_at: run.last_scan_at.clone(),
        last_error: run.last_error.clone(),
        running: run.running,
    }
}

#[tauri::command]
pub fn inbox_status(desk: tauri::State<'_, Desk>) -> InboxStatus {
    status(&desk.inbox.lock().unwrap())
}

#[tauri::command]
pub fn inbox_set(app: AppHandle, desk: tauri::State<'_, Desk>, enabled: bool, root: Option<String>) -> Result<InboxStatus, String> {
    let root = match root.filter(|r| !r.trim().is_empty()) {
        Some(r) => PathBuf::from(r),
        None => data_dir(&app)?.join(calendar::TEST_INBOX_DIR),
    };
    calendar::check_inbox_root(&root)?;
    if enabled {
        Layout::new(&root).ensure().map_err(|e| e.message)?;
    }
    let mut run = desk.inbox.lock().unwrap();
    run.enabled = enabled;
    run.root = root;
    run.last_error = None;
    Ok(status(&run))
}

#[tauri::command]
pub fn inbox_results(desk: tauri::State<'_, Desk>) -> Result<Vec<InboxResult>, String> {
    let root = desk.inbox.lock().unwrap().root.clone();
    if root.as_os_str().is_empty() {
        return Ok(Vec::new());
    }
    calendar::inbox_results(&Layout::new(root).state()).map_err(|e| e.to_string())
}

/// Inbox files that can be drafted at once (phone text, phone transcripts). Cheap: polled
/// every 2 s. A file seen for the first time wakes the scanner, so the AI starts sooner too.
#[tauri::command]
pub fn inbox_drafts(desk: tauri::State<'_, Desk>) -> Vec<calendar::InboxDraft> {
    let (enabled, root) = {
        let run = desk.inbox.lock().unwrap();
        (run.enabled, run.root.clone())
    };
    if !enabled || root.as_os_str().is_empty() {
        return Vec::new();
    }
    let since = std::time::SystemTime::now() - DRAFT_WINDOW;
    let list = desk.drafts.lock().unwrap().scan(&root, since);
    let mut drafted = desk.drafted.lock().unwrap();
    if list.iter().any(|d| drafted.insert(d.job_id.clone())) {
        desk.kick.store(true, Ordering::SeqCst);
    }
    list
}

fn drive_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    calendar::find_drive_blackhole(&home).ok_or_else(|| "드라이브 「블랙홀」 폴더가 없습니다.".to_string())
}

/// Write the phone's copy (Drive 「블랙홀/달력.json」, made by the phone). Returns a status line.
#[tauri::command]
pub fn share_calendar(shared: serde_json::Value) -> Result<String, String> {
    let written = calendar::write_shared(&drive_root()?, &shared)?;
    let at = chrono::Local::now().format("%H:%M");
    Ok(if written { format!("휴대폰 공유 사본을 {at}에 씀") } else { format!("휴대폰 공유 사본 그대로({at} 확인, 바뀐 것 없음)") })
}

#[tauri::command]
pub fn phone_actions() -> Vec<serde_json::Value> {
    drive_root().map(|root| calendar::read_phone_actions(&root)).unwrap_or_default()
}

#[tauri::command]
pub fn alarms_schedule(desk: tauri::State<'_, Desk>, alarms: Vec<AlarmSpec>) {
    *desk.alarms.lock().unwrap() = alarms;
}

fn bring_forward(app: &AppHandle, on_top: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_always_on_top(on_top);
        if on_top {
            let _ = w.set_focus();
            let _ = w.request_user_attention(Some(UserAttentionType::Critical));
        }
    }
}

fn start_ring(ringing: &Arc<AtomicBool>) {
    if ringing.swap(true, Ordering::SeqCst) {
        return;
    }
    let flag = ringing.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        while flag.load(Ordering::SeqCst) && started.elapsed() < RING_LIMIT {
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("/usr/bin/afplay").arg("/System/Library/Sounds/Glass.aiff").status();
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        flag.store(false, Ordering::SeqCst);
    });
}

/// Start/stop ringing. Returns true when the sound is played here (macOS); otherwise the
/// web page beeps itself.
#[tauri::command]
pub fn alarm_ring(app: AppHandle, desk: tauri::State<'_, Desk>, on: bool) -> bool {
    if on {
        bring_forward(&app, true);
        if cfg!(target_os = "macos") {
            start_ring(&desk.ringing);
        }
    } else {
        desk.ringing.store(false, Ordering::SeqCst);
        bring_forward(&app, false);
    }
    cfg!(target_os = "macos")
}

/// Window glass: the desktop shows through (macOS vibrancy) for the 유리 theme; the 공문서
/// theme paints opaque paper, so the effect is removed there.
#[tauri::command]
pub fn set_window_look(app: AppHandle, theme: String, mode: String) -> Result<(), String> {
    use tauri::utils::{config::WindowEffectsConfig, WindowEffect, WindowEffectState};
    let w = app.get_webview_window("main").ok_or("창이 없습니다.")?;
    let (effect, dark) = match (theme.as_str(), mode.as_str()) {
        ("glass", "light") => (Some(WindowEffect::Popover), false),
        ("glass", _) => (Some(WindowEffect::HudWindow), true),
        _ => (None, false),
    };
    let config = effect.map(|e| WindowEffectsConfig { effects: vec![e], state: Some(WindowEffectState::Active), radius: None, color: None, interactive: false });
    w.set_effects(config).map_err(|e| e.to_string())?;
    w.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light })).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn print_page(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main").ok_or("창이 없습니다.")?.print().map_err(|e| e.to_string())
}

/// Background threads: alarm clock (1 s) and inbox scanner (every 15 s while enabled).
pub fn start(app: &AppHandle) {
    let desk = app.state::<Desk>();
    if let Ok(dir) = data_dir(app) {
        let mut run = desk.inbox.lock().unwrap();
        run.test_root = dir.join(calendar::TEST_INBOX_DIR);
        run.root = run.test_root.clone();
    }

    let (alarms, ringing, handle) = (desk.alarms.clone(), desk.ringing.clone(), app.clone());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let due = calendar::take_due(&mut alarms.lock().unwrap(), calendar::now_ms());
        for alarm in due {
            bring_forward(&handle, true);
            start_ring(&ringing);
            let _ = handle.emit("bh-alarm", serde_json::json!({ "key": alarm.key }));
        }
    });

    // Discord·Slack → the current inbox folder, every 30 s while enabled.
    let (messenger, inbox_for_messenger) = (desk.messenger.clone(), desk.inbox.clone());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        if !messenger.lock().unwrap().enabled {
            continue;
        }
        let root = inbox_for_messenger.lock().unwrap().root.clone();
        let result = crate::worker::messenger::MessengerConfig::load().and_then(|c| match c {
            Some(config) => crate::worker::messenger::poll(&root, &config),
            None => Err(WorkerError::new(ErrorCode::Io, "메신저 설정 파일이 없습니다.")),
        });
        let mut run = messenger.lock().unwrap();
        run.last_poll_at = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());
        match result {
            Ok(report) => {
                run.written += report.written.len();
                run.last_error = report.errors.first().cloned();
            }
            Err(e) => run.last_error = Some(e.message),
        }
    });

    let (inbox, kick) = (desk.inbox.clone(), desk.kick.clone());
    std::thread::spawn(move || {
        let mut last = Instant::now() - INBOX_EVERY;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let root = {
                let run = inbox.lock().unwrap();
                let kicked = kick.load(Ordering::SeqCst) && last.elapsed() >= INBOX_SETTLE;
                if !run.enabled || (last.elapsed() < INBOX_EVERY && !kicked) {
                    continue;
                }
                run.root.clone()
            };
            kick.store(false, Ordering::SeqCst);
            last = Instant::now();
            inbox.lock().unwrap().running = true;
            let now = chrono::Local::now().fixed_offset();
            let result = scan_once(&Layout::new(&root), EngineId::TextFirst, now, INBOX_SETTLE, |input, _| run_analysis(input, now));
            let mut run = inbox.lock().unwrap();
            run.running = false;
            run.last_scan_at = Some(now.format("%Y-%m-%dT%H:%M:%S").to_string());
            run.last_error = match result {
                Ok(report) => {
                    // A file still uploading: look again in a few seconds, not in 15.
                    if !report.waiting.is_empty() {
                        kick.store(true, Ordering::SeqCst);
                    }
                    report.failed.first().map(|f| format!("{}: {}", f.original, f.error.message))
                }
                Err(e) => Some(e.message),
            };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_file_name_header() {
        assert_eq!(percent_decode("%EA%B0%80%EC%A0%95%ED%86%B5%EC%8B%A0%EB%AC%B8.png"), "가정통신문.png");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("plain.txt"), "plain.txt");
    }
}
