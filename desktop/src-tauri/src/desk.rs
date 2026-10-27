//! Tauri commands for the calendar app: state file, local worker, test-folder inbox,
//! native alarms (window forward + repeating sound) and printing.

use crate::calendar::{self, AlarmSpec, InboxResult};
use crate::worker::{
    config::WorkerConfig,
    error::{ErrorCode, WorkerError},
    inbox::{scan_once, Layout},
    pipeline::{source_type_for, Input},
    proposal::{EngineId, Proposal},
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
use tauri::{AppHandle, Emitter, Manager};

const INBOX_EVERY: Duration = Duration::from_secs(15);
/// A Drive upload is usually complete within this; the scan leaves newer files for later.
const INBOX_SETTLE: Duration = Duration::from_secs(3);
/// Drafts are offered for inbox files this recent (older ones were handled before).
const DRAFT_WINDOW: Duration = Duration::from_secs(3 * 24 * 3600);
/// Inbox jobs whose rule draft was final (simple sentence): the scanner makes no AI call.
const SKIP_FILE: &str = "ai-skip.json";

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
    skip: Arc<Mutex<std::collections::HashSet<String>>>,
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

/// The same analysis the `blackhole-worker` CLI runs (config file + BLACKHOLE_* env; Claude by default).
fn run_analysis(input: &Input, now: DateTime<FixedOffset>) -> Result<Proposal, WorkerError> {
    run_analysis_in(input, now, None)
}

fn run_analysis_in(input: &Input, now: DateTime<FixedOffset>, inbox: Option<&Path>) -> Result<Proposal, WorkerError> {
    WorkerConfig::from_env()?.analyze(input, EngineId::TextFirst, now, inbox)
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

pub(crate) fn percent_decode(s: &str) -> String {
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
    // The page answers with `inbox_drafted` (which jobs need no AI); only then the scanner is woken,
    // so a simple sentence is never sent to the API before the page could say so.
    let drafted = desk.drafted.lock().unwrap();
    if list.iter().any(|d| !drafted.contains(&d.job_id)) {
        drop(drafted);
        let mut drafted = desk.drafted.lock().unwrap();
        for d in &list {
            drafted.insert(d.job_id.clone());
        }
        // Safety net: a page that never answers still gets its AI pass on the next regular scan.
    }
    list
}

/// The page drafted new inbox jobs. `skip`: jobs whose rule draft is final (simple sentence,
/// 「AI 생략」 on), never sent to the API. Then the scanner runs at once for the others.
#[tauri::command]
pub fn inbox_drafted(app: AppHandle, desk: tauri::State<'_, Desk>, skip: Vec<String>) {
    if !skip.is_empty() {
        let mut set = desk.skip.lock().unwrap();
        for job in &skip {
            if set.insert(job.clone()) {
                crate::worker::claude::log_skip(&crate::worker::claude::usage_log_path(), "rule", "text");
            }
        }
        if let Ok(dir) = data_dir(&app) {
            let list: Vec<&String> = set.iter().collect();
            let _ = std::fs::write(dir.join(SKIP_FILE), serde_json::to_string(&list).unwrap_or_default());
        }
    }
    desk.kick.store(true, Ordering::SeqCst);
}

/// A sentence typed here whose rule draft was final: counted, not sent.
#[tauri::command]
pub fn ai_skipped(reason: String) {
    crate::worker::claude::log_skip(&crate::worker::claude::usage_log_path(), &reason, "text");
}

/// Copy a file into the current inbox folder (`<날짜-시각>-맥-<이름>`) and wake the scanner.
/// The file itself is only read.
#[tauri::command]
pub fn inbox_put(desk: tauri::State<'_, Desk>, path: String) -> Result<String, String> {
    let (enabled, root) = {
        let run = desk.inbox.lock().unwrap();
        (run.enabled, run.root.clone())
    };
    if !enabled || root.as_os_str().is_empty() {
        return Err("인박스 처리가 꺼져 있습니다.".into());
    }
    let from = Path::new(&path);
    source_type_for(from).map_err(|e| e.message)?;
    let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "입력".into());
    let target = Layout::new(&root).inbox().join(format!("{}-맥-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), name));
    std::fs::copy(from, &target).map_err(|e| format!("인박스에 넣지 못했습니다: {e}"))?;
    desk.kick.store(true, Ordering::SeqCst);
    Ok(target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// Claude API status for 설정. The key itself is never returned to the page.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    analyzer: String,
    model: String,
    has_key: bool,
    month_requests: u64,
    month_usd: f64,
    budget_usd: f64,
    skip_simple: bool,
    month: crate::worker::claude::MonthSummary,
}

fn claude_status_now() -> Result<ClaudeStatus, String> {
    let config = WorkerConfig::from_env().map_err(|e| e.message)?;
    let has_key = crate::worker::claude::api_key().map_err(|e| e.message)?.is_some();
    let month = chrono::Local::now().format("%Y-%m").to_string();
    let summary = crate::worker::claude::month_summary(&crate::worker::claude::usage_log_path(), &month);
    let ai = crate::worker::claude::AiSettings::load();
    Ok(ClaudeStatus {
        analyzer: config.analyzer.clone(),
        model: config.claude_model.clone(),
        has_key,
        month_requests: summary.requests,
        month_usd: summary.usd,
        budget_usd: ai.budget_usd,
        skip_simple: ai.skip_simple,
        month: summary,
    })
}

/// 설정: monthly AI budget (USD, 0 = none) and 「간단한 문장은 AI 생략」.
#[tauri::command]
pub fn claude_set_options(budget_usd: f64, skip_simple: bool) -> Result<ClaudeStatus, String> {
    let ai = crate::worker::claude::AiSettings { budget_usd: budget_usd.clamp(0.0, 1000.0), skip_simple };
    ai.save().map_err(|e| e.message)?;
    claude_status_now()
}

#[tauri::command]
pub fn claude_status() -> Result<ClaudeStatus, String> {
    claude_status_now()
}

/// Store a pasted key in the macOS keychain only.
#[tauri::command]
pub fn claude_set_key(key: String) -> Result<ClaudeStatus, String> {
    crate::worker::claude::store_key(&key).map_err(|e| e.message)?;
    claude_status_now()
}

#[tauri::command]
pub fn claude_clear_key() -> Result<ClaudeStatus, String> {
    crate::worker::claude::clear_key().map_err(|e| e.message)?;
    claude_status_now()
}

/// 「연결 확인」: one free request (model lookup) with the stored key.
#[tauri::command]
pub async fn claude_check() -> Result<String, String> {
    blocking(|| {
        let config = WorkerConfig::from_env()?;
        let key = crate::worker::claude::api_key()?.ok_or_else(|| WorkerError::new(ErrorCode::ApiKeyMissing, "Claude API 키가 없습니다."))?;
        let url = std::env::var("BLACKHOLE_CLAUDE_URL").unwrap_or_else(|_| crate::worker::claude::DEFAULT_URL.into());
        crate::worker::claude::check_key(&url, &key, &config.claude_model)?;
        Ok(format!("연결됨 · {} · {}", config.claude_model, chrono::Local::now().format("%H:%M")))
    })
    .await
    .map_err(|e| e.message)
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

/// Kept for older pages: the alarm window rings itself; `false` stops the sound.
#[tauri::command]
pub fn alarm_ring(app: AppHandle, on: bool) -> bool {
    if !on {
        crate::mac::stop_ring(&app.state::<crate::mac::MacState>());
    }
    true
}

/// Alarms that passed while Blackhole was not running (the page finds them at start).
#[tauri::command]
pub fn alarm_missed(app: AppHandle, alarms: Vec<AlarmSpec>) {
    crate::mac::show_alarms(&app, alarms.into_iter().map(|a| AlarmSpec { missed: true, ..a }).collect());
}

/// The alarm window: what to show.
#[tauri::command]
pub fn alarm_current(app: AppHandle) -> Vec<AlarmSpec> {
    app.state::<crate::mac::MacState>().showing.lock().unwrap().clone()
}

/// The alarm window: 확인 / 완료 / 10분 뒤. The main page applies it to the calendar.
#[tauri::command]
pub fn alarm_answer(app: AppHandle, key: String, answer: String) {
    if let Some(alarm) = crate::mac::alarm_answered(&app, &key) {
        let _ = app.emit_to("main", "bh-alarm-answer", serde_json::json!({ "alarm": alarm, "answer": answer }));
    }
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

    if let Ok(dir) = data_dir(app) {
        let saved: Vec<String> = std::fs::read_to_string(dir.join(SKIP_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        desk.skip.lock().unwrap().extend(saved);
    }

    // The alarm clock runs here, not in the page: a hidden window's timers may be slowed down.
    let (alarms, handle) = (desk.alarms.clone(), app.clone());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let due = calendar::take_due(&mut alarms.lock().unwrap(), calendar::now_ms());
        if due.is_empty() {
            continue;
        }
        for alarm in &due {
            let _ = handle.emit_to("main", "bh-alarm", serde_json::json!({ "key": alarm.key }));
        }
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || crate::mac::show_alarms(&h, due));
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

    let (inbox, kick, skip) = (desk.inbox.clone(), desk.kick.clone(), desk.skip.clone());
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
            let result = scan_once(&Layout::new(&root), EngineId::TextFirst, now, INBOX_SETTLE, |input, _| {
                let job = crate::worker::pipeline::input_hash(input).map(|(sha, _)| format!("job-{}", &sha[..16])).unwrap_or_default();
                if skip.lock().unwrap().contains(&job) {
                    return crate::worker::pipeline::rule_only_proposal(input, now);
                }
                // A password or a card number typed on the phone never goes to the AI (or into a note).
                if let Some(p) = withheld_secret(input, now) {
                    return Ok(p);
                }
                run_analysis_in(input, now, Some(&Layout::new(&root).inbox()))
            });
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

/// A short text from the phone that looks like a secret (비번 1234, 카드번호 …): a result with no
/// items and no text, only the reason — the value is not sent to Claude and not kept in the calendar.
pub fn withheld_secret(input: &crate::worker::pipeline::Input, now: chrono::DateTime<chrono::FixedOffset>) -> Option<crate::worker::proposal::Proposal> {
    use crate::worker::pipeline::Input;
    let text = match input {
        Input::Text(t) => t.to_string(),
        Input::File(path) => {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext != "txt" || std::fs::metadata(path).map(|m| m.len() > 2_000).unwrap_or(true) {
                return None;
            }
            // Any encoding the worker reads (an EUC-KR note used to skip this check and go to the AI).
            crate::worker::pipeline::decode_text(&std::fs::read(path).ok()?).ok()?
        }
    };
    if matches!(crate::secret::guess(&text), crate::secret::Guess::None) {
        return None;
    }
    let mut p = crate::worker::pipeline::rule_only_proposal(&Input::Text(""), now).ok()?;
    p.source_text = String::new();
    p.summary = "비밀 같아 AI로 보내지 않음".into();
    p.needs_review = true;
    p.review_reasons = vec!["비밀번호·카드번호 같은 내용이라 AI로 보내지 않았어요 · Mac 빠른 입력창에 넣으면 키체인에만 저장됩니다".into()];
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn a_secret_from_the_phone_is_withheld() {
        use crate::worker::pipeline::Input;
        let now = chrono::Local::now().fixed_offset();
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("note.txt");
        std::fs::write(&f, "현관 비밀번호 4821").unwrap();
        let p = super::withheld_secret(&Input::File(&f), now).expect("withheld");
        assert!(p.items.is_empty() && p.source_text.is_empty() && p.needs_review);
        assert!(!serde_json::to_string(&p).unwrap().contains("4821"));
        std::fs::write(&f, "내일 3시 치과").unwrap();
        assert!(super::withheld_secret(&Input::File(&f), now).is_none());
        assert!(super::withheld_secret(&Input::Text("카드번호 1234-5678-9012-3456"), now).is_some());
        // Saved by Windows 메모장 as 「유니코드」(UTF-16): still caught.
        let mut le = vec![0xFF, 0xFE];
        le.extend("현관 비밀번호 4821".encode_utf16().flat_map(u16::to_le_bytes));
        std::fs::write(&f, le).unwrap();
        assert!(super::withheld_secret(&Input::File(&f), now).is_some());
    }

    #[test]
    fn decodes_file_name_header() {
        assert_eq!(percent_decode("%EA%B0%80%EC%A0%95%ED%86%B5%EC%8B%A0%EB%AC%B8.png"), "가정통신문.png");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("plain.txt"), "plain.txt");
    }
}
