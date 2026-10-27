//! Ready-to-use Mac pieces: menu-bar icon, global shortcuts, the quick-input window, clipboard
//! and screen-capture sending, files dropped on the Dock icon, login item, notifications and the
//! full-screen alarm window. Everything that is put in ends up as one `bh-put` event for the main
//! window, which decides (inbox folder or direct analysis) like for its own input.

use crate::calendar::{self, AlarmSpec};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const QUICK: &str = "quick";
pub const ALARM: &str = "alarm";
const RING_LIMIT: Duration = Duration::from_secs(10 * 60);
pub const SOUNDS: [&str; 8] = ["Glass", "Hero", "Submarine", "Sosumi", "Ping", "Funk", "Blow", "Purr"];

/* ---------- settings (app data, read before the page loads) ---------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
    pub quick: String,
    pub clipboard: String,
    pub capture: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        // ⌃⌥⌘: free on a Korean Mac with Raycast (⌃Space/⌃⌥Space switch input, ⌥⌘Space is Finder,
        // ⌥Space is Raycast). Registered by key code, so they work with the Korean input on.
        Self { quick: "Ctrl+Alt+Super+Space".into(), clipboard: "Ctrl+Alt+Super+V".into(), capture: "Ctrl+Alt+Super+S".into() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeskSettings {
    pub shortcuts: Shortcuts,
    /// Start at login (menu bar only, no window). Turned on at the first start.
    pub autostart: bool,
    pub alarm_sound: String,
    /// The first-start guide was closed.
    pub onboarded: bool,
    /// Set once the login item was offered (so turning it off stays off).
    pub autostart_offered: bool,
    /// Right ⌘ pressed twice quickly opens the quick window (needs 손쉬운 사용).
    pub right_cmd_twice: bool,
}

impl Default for DeskSettings {
    fn default() -> Self {
        Self { shortcuts: Shortcuts::default(), autostart: false, alarm_sound: "Glass".into(), onboarded: false, autostart_offered: false, right_cmd_twice: true }
    }
}

const SETTINGS_FILE: &str = "desk-settings.json";

pub fn load_settings(dir: &Path) -> DeskSettings {
    std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_settings(dir: &Path, s: &DeskSettings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(SETTINGS_FILE), serde_json::to_string_pretty(s).unwrap_or_default()).map_err(|e| e.to_string())
}

/// 「Alt+Super+K」 → 「⌥⌘K」.
pub fn pretty_shortcut(s: &str) -> String {
    let mut out = String::new();
    let mut key = String::new();
    for part in s.split('+').map(str::trim) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => out.push('⌃'),
            "alt" | "option" => out.push('⌥'),
            "shift" => out.push('⇧'),
            "super" | "cmd" | "command" | "meta" | "cmdorctrl" | "commandorcontrol" => out.push('⌘'),
            _ => key = part.to_uppercase(),
        }
    }
    // Apple's order: ⌃⌥⇧⌘
    let order = ['⌃', '⌥', '⇧', '⌘'];
    let mods: String = order.iter().filter(|c| out.contains(**c)).collect();
    format!("{mods}{}", if key == "SPACE" { "Space".into() } else { key })
}

/* ---------- login item (LaunchAgent) ---------- */

const AGENT_LABEL: &str = "com.malhaedwo.blackhole.desktop.login";

fn agent_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library").join("LaunchAgents").join(format!("{AGENT_LABEL}.plist"))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn agent_plist(exe: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{AGENT_LABEL}</string>
  <key>AssociatedBundleIdentifiers</key><string>com.malhaedwo.blackhole.desktop</string>
  <key>ProgramArguments</key><array><string>{}</string><string>--login</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
        xml_escape(&exe.to_string_lossy())
    )
}

/// Start at login on/off. Only a file in ~/Library/LaunchAgents (no system setting changed).
pub fn set_autostart(on: bool) -> Result<(), String> {
    let path = agent_path();
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // Only a real installed app (not `cargo run` / a test build) starts at login.
        if !exe.to_string_lossy().contains(".app/Contents/MacOS/") {
            return Err("설치한 앱(.app)에서만 로그인 시 실행을 켤 수 있습니다.".into());
        }
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&path, agent_plist(&exe)).map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub fn autostart_on() -> bool {
    agent_path().is_file()
}

/* ---------- menu-bar icon (drawn in code: ring + crescent, template image) ---------- */

pub fn tray_rgba(n: u32) -> Vec<u8> {
    let mut out = vec![0u8; (n * n * 4) as usize];
    let c = n as f64 / 2.0;
    let r_out = n as f64 * 0.42;
    let r_in = n as f64 * 0.33;
    let ss = 4;
    for y in 0..n {
        for x in 0..n {
            let mut hit = 0;
            for sy in 0..ss {
                for sx in 0..ss {
                    let px = x as f64 + (sx as f64 + 0.5) / ss as f64 - c;
                    let py = y as f64 + (sy as f64 + 0.5) / ss as f64 - c;
                    let d = (px * px + py * py).sqrt();
                    // corona ring, plus a thicker crescent to the lower left (the eclipse)
                    let moon = ((px - n as f64 * 0.05).powi(2) + (py + n as f64 * 0.07).powi(2)).sqrt();
                    if d <= r_out && (d >= r_in || moon > r_in) {
                        hit += 1;
                    }
                }
            }
            let a = (hit * 255 / (ss * ss)) as u8;
            let i = ((y * n + x) * 4) as usize;
            out[i + 3] = a;
        }
    }
    out
}

/* ---------- runtime state ---------- */

#[derive(Default)]
pub struct MacState {
    /// shortcut id → action ("quick", "clipboard", "capture")
    pub shortcuts: Mutex<HashMap<u32, String>>,
    /// Alarms on screen in the alarm window, the first one is shown.
    pub showing: Mutex<Vec<AlarmSpec>>,
    pub ringing: Arc<AtomicBool>,
    pub sound: Mutex<String>,
    /// Things put in, waiting for the main page (it may not be loaded yet: Dock drop at launch).
    pub puts: Mutex<Vec<Put>>,
    /// A query for the quick window that is still loading.
    pub quick_query: Mutex<String>,
}

/* ---------- putting things in ---------- */

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Put {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<LinkInfo>,
    /// ⌘Enter in the quick window: keep as 기억 as typed (no AI).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
    /// Open this entry (search result, Raycast).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<String>,
    /// 빠른 입력, 클립보드, 화면 캡처, Dock, 끌어 놓기
    pub via: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub url: String,
    pub title: String,
    pub text: String,
}

fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false) && app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

pub fn emit_put(app: &AppHandle, put: Put) {
    let label = put.link.as_ref().map(|l| if l.title.is_empty() { l.url.clone() } else { l.title.clone() })
        .or_else(|| put.text.clone())
        .or_else(|| put.path.as_deref().and_then(|p| Path::new(p).file_name()).map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    if !main_visible(app) {
        let short: String = label.chars().take(60).collect();
        notify(app, &format!("블랙홀에 넣음 · {}", put.via), &short);
    }
    app.state::<MacState>().puts.lock().unwrap().push(put);
    let _ = app.emit_to("main", "bh-put", ());
}

/// The main page takes what was put in (on the `bh-put` signal and once at start).
#[tauri::command]
pub fn put_take(app: AppHandle) -> Vec<Put> {
    std::mem::take(&mut *app.state::<MacState>().puts.lock().unwrap())
}

/// A single http(s) link and nothing else.
pub fn single_url(text: &str) -> Option<String> {
    let t = text.trim();
    (!t.contains(char::is_whitespace) && (t.starts_with("https://") || t.starts_with("http://")) && t.len() < 2048).then(|| t.to_string())
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
}

/// Title and readable text of an HTML page (scripts, styles and tags removed).
pub fn page_text(html: &str) -> (String, String) {
    let lower = html.to_lowercase();
    let title = lower.find("<title").and_then(|a| {
        let start = lower[a..].find('>')? + a + 1;
        let end = lower[start..].find("</title")? + start;
        Some(decode_entities(html[start..end].trim()))
    }).unwrap_or_default();
    let meta = regex::Regex::new(r#"(?is)<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)"#).ok()
        .and_then(|re| re.captures(html).map(|c| decode_entities(c[1].trim())))
        .unwrap_or_default();
    let body = regex::Regex::new(r"(?is)<(script|style|noscript|svg|head)\b.*?</(script|style|noscript|svg|head)>").map(|re| re.replace_all(html, " ").into_owned()).unwrap_or_default();
    let body = regex::Regex::new(r"(?s)<[^>]*>").map(|re| re.replace_all(&body, " ").into_owned()).unwrap_or_default();
    let body = decode_entities(&body);
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut text = if meta.is_empty() { String::new() } else { format!("{meta}\n") };
    text.push_str(&body.chars().take(3000).collect::<String>());
    (title.split_whitespace().collect::<Vec<_>>().join(" "), text)
}

pub fn fetch_link(url: &str) -> LinkInfo {
    let mut info = LinkInfo { url: url.into(), ..LinkInfo::default() };
    let resp = ureq::get(url).timeout(Duration::from_secs(10)).set("user-agent", "Mozilla/5.0 (Macintosh) Blackhole/0.2").call();
    if let Ok(r) = resp {
        let html_like = r.content_type().contains("html") || r.content_type().contains("text");
        if html_like {
            let mut body = String::new();
            use std::io::Read;
            let _ = r.into_reader().take(2_000_000).read_to_string(&mut body);
            let (title, text) = page_text(&body);
            info.title = title;
            info.text = text;
        }
    }
    info
}

/// What happened to a sentence: put in, kept as a secret, or 「비밀로 저장할까요?」.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Intake {
    Put,
    Secret,
    Ask,
}

/// Secrets first, by local rules: a sure one goes to the keychain only; a doubtful one is asked
/// (`secret: None`) — from places that cannot ask (clipboard, Raycast) it is not sent at all.
pub fn intake(app: &AppHandle, text: &str, secret: Option<bool>, can_ask: bool) -> Result<Intake, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let store = |name: &str, value: &str| -> Result<Intake, String> {
        crate::secret::store(&dir, name, value)?;
        notify(app, "비밀로 저장(키체인)", &format!("「{name}」 · 값은 이 Mac 키체인에만 있습니다"));
        Ok(Intake::Secret)
    };
    match (crate::secret::guess(text), secret) {
        (_, Some(false)) | (crate::secret::Guess::None, _) => Ok(Intake::Put),
        (crate::secret::Guess::Sure { name, value }, _) | (crate::secret::Guess::Maybe { name, value }, Some(true)) => store(&name, &value),
        (crate::secret::Guess::Maybe { .. }, None) if can_ask => Ok(Intake::Ask),
        (crate::secret::Guess::Maybe { name, value }, None) => {
            let _ = (name, value);
            notify(app, "블랙홀", "비밀번호 같아 보여 보내지 않았습니다. 빠른 입력창에서 넣으면 비밀로 저장할지 묻습니다.");
            Ok(Intake::Ask)
        }
    }
}

/// Text: a link is looked up first (title, page text), anything else goes in as typed.
pub fn put_text(app: &AppHandle, text: String, via: &str) {
    let text = text.trim().to_string();
    if text.is_empty() || !matches!(intake(app, &text, None, false), Ok(Intake::Put)) {
        return;
    }
    if let Some(url) = single_url(&text) {
        let (app, via) = (app.clone(), via.to_string());
        std::thread::spawn(move || {
            let link = fetch_link(&url);
            emit_put(&app, Put { link: Some(link), via, ..Put::default() });
        });
        return;
    }
    emit_put(app, Put { text: Some(text), via: via.into(), ..Put::default() });
}

/// Formats the worker does not read, turned into ones it does with macOS's own tools:
/// voice memos (m4a, mp3, aac, caf, aiff) → 16 kHz WAV, HEIC/TIFF/GIF photos → PNG.
pub fn convert_for_worker(app: &AppHandle, path: &Path) -> PathBuf {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let audio = matches!(ext.as_str(), "m4a" | "mp3" | "aac" | "caf" | "aif" | "aiff" | "mp4");
    let image = matches!(ext.as_str(), "heic" | "heif" | "tif" | "tiff" | "gif" | "bmp");
    if !audio && !image {
        return path.to_path_buf();
    }
    let Ok(dir) = app.path().app_data_dir().map(|d| d.join(calendar::INPUT_DIR)) else { return path.to_path_buf() };
    let _ = std::fs::create_dir_all(&dir);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "입력".into());
    let out = dir.join(format!("{stem}-{}.{}", chrono::Local::now().format("%H%M%S"), if audio { "wav" } else { "png" }));
    let ok = if audio {
        Command::new("/usr/bin/afconvert").args(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1"]).arg(path).arg(&out).status()
    } else {
        Command::new("/usr/bin/sips").args(["-s", "format", "png"]).arg(path).arg("--out").arg(&out).stdout(std::process::Stdio::null()).status()
    }
    .map(|s| s.success())
    .unwrap_or(false);
    if ok && out.is_file() { out } else { path.to_path_buf() }
}

pub fn put_path(app: &AppHandle, path: &Path, via: &str) {
    let path = convert_for_worker(app, path);
    emit_put(app, Put { path: Some(path.to_string_lossy().into_owned()), via: via.into(), ..Put::default() });
}

pub fn put_bytes(app: &AppHandle, name: &str, bytes: &[u8], via: &str) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let kept = calendar::keep_input(&dir, name, bytes).map_err(|e| e.to_string())?;
    put_path(app, &kept, via);
    Ok(())
}

fn stamp_name(ext: &str) -> String {
    format!("{}.{ext}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
}

/// What is on the clipboard: copied files, an image, or text (JXA through osascript).
#[derive(Debug, Default, Deserialize)]
struct Clip {
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    image: bool,
    #[serde(default)]
    text: String,
}

const CLIP_JS: &str = r#"
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const out = {files: [], image: false, text: ''};
const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({NSPasteboardURLReadingFileURLsOnlyKey: true}));
if (urls && urls.count > 0) { for (let i = 0; i < urls.count; i++) out.files.push(urls.objectAtIndex(i).path.js); }
const dest = $.NSProcessInfo.processInfo.environment.objectForKey('BH_CLIP_IMAGE').js;
if (!out.files.length) {
  let png = pb.dataForType('public.png');
  if (!png || png.isNil()) {
    const tiff = pb.dataForType('public.tiff');
    if (tiff && !tiff.isNil()) png = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  }
  if (png && !png.isNil()) { png.writeToFileAtomically(dest, true); out.image = true; }
}
const s = pb.stringForType('public.utf8-plain-text');
if (s && !s.isNil()) out.text = s.js;
JSON.stringify(out);
"#;

pub fn send_clipboard(app: &AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(calendar::INPUT_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let image = dir.join(format!("클립보드-{}", stamp_name("png")));
    let out = Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", CLIP_JS]).env("BH_CLIP_IMAGE", &image).output().map_err(|e| e.to_string())?;
    let clip: Clip = serde_json::from_slice(&out.stdout).map_err(|_| format!("클립보드를 읽지 못했습니다: {}", String::from_utf8_lossy(&out.stderr).trim()))?;
    if !clip.files.is_empty() {
        for f in &clip.files {
            put_path(app, Path::new(f), "클립보드");
        }
        return Ok(format!("파일 {}개", clip.files.len()));
    }
    if clip.image && image.is_file() {
        put_path(app, &image, "클립보드");
        return Ok("이미지".into());
    }
    if !clip.text.trim().is_empty() {
        let link = single_url(&clip.text).is_some();
        put_text(app, clip.text, "클립보드");
        return Ok(if link { "링크".into() } else { "글".into() });
    }
    notify(app, "블랙홀", "클립보드가 비어 있습니다.");
    Err("클립보드가 비어 있습니다.".into())
}

/// macOS area capture (`screencapture -i`): the picked area goes in as a picture.
pub fn capture(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(dir) = app.path().app_data_dir().map(|d| d.join(calendar::INPUT_DIR)) else { return };
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(format!("화면-{}", stamp_name("png")));
        if let Some(w) = app.get_webview_window(QUICK) {
            let _ = w.hide();
        }
        let ok = Command::new("/usr/sbin/screencapture").arg("-i").arg("-x").arg(&file).status().map(|s| s.success()).unwrap_or(false);
        if ok && file.is_file() {
            put_path(&app, &file, "화면 캡처");
        }
    });
}

/* ---------- windows ---------- */

pub fn show_main(app: &AppHandle) {
    activate_app(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn toggle_quick(app: &AppHandle) {
    open_quick(app, None, true);
}

/// Show the quick window (optionally with a query typed in: Raycast 「블랙홀 찾기」).
pub fn open_quick(app: &AppHandle, query: Option<String>, toggle: bool) {
    if let Some(w) = app.get_webview_window(QUICK) {
        if toggle && query.is_none() && w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            activate_app(app);
            let _ = w.center();
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.emit("bh-quick-open", query.unwrap_or_default());
        }
        return;
    }
    activate_app(app);
    if let Some(q) = query {
        *app.state::<MacState>().quick_query.lock().unwrap() = q;
    }
    let built = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("index.html".into()))
        .initialization_script("window.__BH_WINDOW = 'quick';")
        .title("블랙홀 빠른 입력")
        .inner_size(640.0, 420.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(true)
        .center()
        .focused(true)
        .build();
    if let Ok(w) = built {
        raise_window(&w, false);
    }
}

/// Bring Blackhole to the front (the quick window opened from a shortcut, the menu bar or Raycast
/// must take the keyboard even while another app is active).
pub fn activate_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            #[allow(deprecated)]
            objc2_app_kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        }
    });
    let _ = app;
}

/// Put a window above everything: all Spaces, over full-screen apps (alarm: screen-saver level).
pub fn raise_window(w: &tauri::WebviewWindow, alarm: bool) {
    #[cfg(target_os = "macos")]
    {
        let w2 = w.clone();
        let _ = w.run_on_main_thread(move || {
            use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
            if let Ok(ptr) = w2.ns_window() {
                // SAFETY: Tauri hands out the live NSWindow of this webview window; we are on the main thread.
                let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                ns.setLevel(if alarm { 1000 } else { 8 });
                ns.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary | NSWindowCollectionBehavior::Stationary);
            }
        });
    }
    let _ = alarm;
}

fn ring(state: &MacState, once: bool) {
    let flag = state.ringing.clone();
    if flag.swap(true, Ordering::SeqCst) {
        return;
    }
    let sound = state.sound.lock().unwrap().clone();
    std::thread::spawn(move || {
        let file = format!("/System/Library/Sounds/{sound}.aiff");
        let started = Instant::now();
        while flag.load(Ordering::SeqCst) && started.elapsed() < RING_LIMIT {
            if cfg!(target_os = "macos") {
                // -v 1.6: louder than the system alert, still follows the output volume.
                let _ = Command::new("/usr/bin/afplay").args(["-v", "1.6", &file]).status();
            }
            if once {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        flag.store(false, Ordering::SeqCst);
    });
}

pub fn stop_ring(state: &MacState) {
    state.ringing.store(false, Ordering::SeqCst);
}

/// Show alarms in the full-screen alarm window (queued; the first one is on screen) and ring.
pub fn show_alarms(app: &AppHandle, alarms: Vec<AlarmSpec>) {
    if alarms.is_empty() {
        return;
    }
    let state = app.state::<MacState>();
    let all_missed = alarms.iter().all(|a| a.missed);
    {
        let mut showing = state.showing.lock().unwrap();
        for a in alarms.iter() {
            if !showing.iter().any(|x| x.key == a.key) {
                showing.push(a.clone());
            }
        }
    }
    for a in &alarms {
        let when = a.at.get(11..16).unwrap_or("");
        notify(app, &format!("{} {when}", if a.missed { "놓친 알람" } else { "블랙홀 알람" }), &a.title);
    }
    open_alarm_window(app);
    ring(&state, all_missed);
}

fn open_alarm_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(ALARM) {
        let _ = w.emit("bh-alarm-update", ());
        let _ = w.show();
        let _ = w.set_focus();
        raise_window(&w, true);
        return;
    }
    let (pos, size) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            (m.position().to_logical::<f64>(s), m.size().to_logical::<f64>(s))
        })
        .map(|(p, z)| ((p.x, p.y), (z.width, z.height)))
        .unwrap_or(((0.0, 0.0), (1440.0, 900.0)));
    let built = WebviewWindowBuilder::new(app, ALARM, WebviewUrl::App("index.html".into()))
        .initialization_script("window.__BH_WINDOW = 'alarm';")
        .title("블랙홀 알람")
        .position(pos.0, pos.1)
        .inner_size(size.0, size.1)
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(true)
        .build();
    if let Ok(w) = built {
        raise_window(&w, true);
        let _ = w.set_focus();
    }
}

/// The alarm window answered: drop it from the queue, close the window when none is left.
pub fn alarm_answered(app: &AppHandle, key: &str) -> Option<AlarmSpec> {
    let state = app.state::<MacState>();
    let (answered, left) = {
        let mut showing = state.showing.lock().unwrap();
        let i = showing.iter().position(|a| a.key == key);
        let answered = i.map(|i| showing.remove(i));
        (answered, showing.len())
    };
    if left == 0 {
        stop_ring(&state);
        if let Some(w) = app.get_webview_window(ALARM) {
            let _ = w.close();
        }
    } else if let Some(w) = app.get_webview_window(ALARM) {
        let _ = w.emit("bh-alarm-update", ());
    }
    answered
}

/* ---------- shortcuts ---------- */

pub fn register_shortcuts(app: &AppHandle, s: &Shortcuts) -> Vec<String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state = app.state::<MacState>();
    let mut map = state.shortcuts.lock().unwrap();
    map.clear();
    let mut problems = Vec::new();
    for (action, text) in [("quick", &s.quick), ("clipboard", &s.clipboard), ("capture", &s.capture)] {
        if text.trim().is_empty() {
            continue;
        }
        match text.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc) {
                Ok(()) => {
                    map.insert(sc.id(), action.to_string());
                }
                Err(e) => problems.push(format!("{} 단축키를 쓸 수 없습니다(다른 앱이 쓰는 중일 수 있음): {e}", pretty_shortcut(text))),
            },
            Err(_) => problems.push(format!("단축키 형식이 아닙니다: {text}")),
        }
    }
    problems
}

pub fn run_action(app: &AppHandle, action: &str) {
    match action {
        "quick" => toggle_quick(app),
        "clipboard" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = send_clipboard(&app);
            });
        }
        "capture" => capture(app),
        "open" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// The Mac menu bar, in Korean: 블랙홀 · 파일 · 편집 · 보기 · 윈도우 · 도움말. Items the page acts
/// on (설정, 새 항목, 실행 취소, 월/주/일 …) come to it as `bh-menu` with their id.
pub fn build_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let about = AboutMetadata {
        name: Some("블랙홀".into()),
        version: Some(app.package_info().version.to_string()),
        comments: Some("던져 두면 일정·할 일·기억으로 정리되는 개인 달력".into()),
        ..AboutMetadata::default()
    };
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(app, "블랙홀", true, &[
                &PredefinedMenuItem::about(app, Some("블랙홀 정보"), Some(about))?,
                &PredefinedMenuItem::separator(app)?,
                &item("m-settings", "설정…", Some("CmdOrCtrl+,"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some("블랙홀 가리기"))?,
                &PredefinedMenuItem::hide_others(app, Some("기타 가리기"))?,
                &PredefinedMenuItem::show_all(app, Some("모두 보기"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, Some("블랙홀 종료"))?,
            ])?,
            &Submenu::with_items(app, "파일", true, &[
                &item("m-new", "새 항목", Some("CmdOrCtrl+N"))?,
                &item("m-quick", "빠른 입력·찾기…", Some("CmdOrCtrl+F"))?,
                &item("m-clipboard", "클립보드 보내기", None)?,
                &item("m-capture", "화면 일부 캡처해 넣기", None)?,
                &PredefinedMenuItem::separator(app)?,
                &item("m-print", "출력…", Some("CmdOrCtrl+P"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, Some("창 닫기"))?,
            ])?,
            &Submenu::with_items(app, "편집", true, &[
                &item("m-undo", "실행 취소", Some("CmdOrCtrl+Z"))?,
                &PredefinedMenuItem::redo(app, Some("실행 복귀"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, Some("오려두기"))?,
                &PredefinedMenuItem::copy(app, Some("복사하기"))?,
                &PredefinedMenuItem::paste(app, Some("붙여넣기"))?,
                &PredefinedMenuItem::select_all(app, Some("전체 선택"))?,
            ])?,
            &Submenu::with_items(app, "보기", true, &[
                &item("m-month", "월", Some("CmdOrCtrl+1"))?,
                &item("m-week", "주", Some("CmdOrCtrl+2"))?,
                &item("m-day", "일", Some("CmdOrCtrl+3"))?,
                &PredefinedMenuItem::separator(app)?,
                &item("m-today", "오늘로 가기", Some("CmdOrCtrl+T"))?,
                &item("m-chat", "대화 기록", Some("CmdOrCtrl+L"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::fullscreen(app, Some("전체 화면"))?,
            ])?,
            &Submenu::with_items(app, "윈도우", true, &[
                &PredefinedMenuItem::minimize(app, Some("최소화"))?,
                &PredefinedMenuItem::maximize(app, Some("확대/축소"))?,
                &PredefinedMenuItem::separator(app)?,
                &item("m-open", "블랙홀 창", Some("CmdOrCtrl+0"))?,
            ])?,
            &Submenu::with_items(app, "도움말", true, &[&item("m-guide", "처음 쓰기 안내", None)?, &item("m-raycast", "Raycast 스크립트 만들기", None)?])?,
        ],
    )?;
    app.set_menu(menu)?;
    Ok(())
}

/// A menu-bar item: the Mac-side ones run here, the rest go to the page.
pub fn menu_event(app: &AppHandle, id: &str) {
    match id {
        "m-quick" => run_action(app, "quick"),
        "m-clipboard" => run_action(app, "clipboard"),
        "m-capture" => run_action(app, "capture"),
        "m-open" => show_main(app),
        "m-raycast" => {
            let _ = raycast_install();
        }
        id if id.starts_with("m-") => {
            show_main(app);
            let _ = app.emit_to("main", "bh-menu", id.trim_start_matches("m-"));
        }
        _ => {}
    }
}

pub fn build_tray(app: &AppHandle, s: &Shortcuts) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    let label = |name: &str, sc: &str| if sc.trim().is_empty() { name.to_string() } else { format!("{name}    {}", pretty_shortcut(sc)) };
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "quick", label("빠른 입력…", &s.quick), true, None::<&str>)?,
            &MenuItem::with_id(app, "clipboard", label("클립보드 보내기", &s.clipboard), true, None::<&str>)?,
            &MenuItem::with_id(app, "capture", label("화면 일부 캡처해 넣기", &s.capture), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "open", "블랙홀 열기", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "블랙홀 끝내기", true, None::<&str>)?,
        ],
    )?;
    if let Some(tray) = app.tray_by_id("bh") {
        return tray.set_menu(Some(menu));
    }
    let n = 44;
    TrayIconBuilder::with_id("bh")
        .icon(tauri::image::Image::new_owned(tray_rgba(n), n, n))
        .icon_as_template(true)
        .tooltip("블랙홀")
        .menu(&menu)
        // Click: the quick window (today + input + search). Right click: the menu.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, e| {
            if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = e {
                toggle_quick(tray.app_handle());
            }
        })
        .on_menu_event(|app, e| run_action(app, e.id().as_ref()))
        .build(app)?;
    Ok(())
}


/* ---------- blackhole:// (Raycast, scripts) ---------- */

fn query_param(url: &tauri::Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

/// `blackhole://put?text=…`, `blackhole://find?q=…`, `blackhole://memo?text=…`,
/// `blackhole://clipboard`, `blackhole://capture`, `blackhole://quick`, `blackhole://open`.
pub fn open_url(app: &AppHandle, url: &tauri::Url) {
    match url.host_str().unwrap_or("") {
        "put" => {
            if let Some(t) = query_param(url, "text") {
                put_text(app, t, "Raycast");
            }
        }
        "memo" => {
            if let Some(t) = query_param(url, "text") {
                let _ = quick_memo(app.clone(), t, None);
            }
        }
        "find" => open_quick(app, Some(query_param(url, "q").unwrap_or_default()), false),
        "clipboard" => run_action(app, "clipboard"),
        "capture" => run_action(app, "capture"),
        "quick" => open_quick(app, None, false),
        _ => show_main(app),
    }
}

fn raycast_script(title: &str, arg: Option<&str>, action: &str) -> String {
    let argument = arg.map(|p| format!("# @raycast.argument1 {{ \"type\": \"text\", \"placeholder\": \"{p}\" }}\n")).unwrap_or_default();
    let open = match arg {
        Some(_) => format!("q=$(/usr/bin/osascript -l JavaScript -e 'function run(a){{return encodeURIComponent(a[0])}}' \"$1\")\n/usr/bin/open \"blackhole://{action}$q\""),
        None => format!("/usr/bin/open \"blackhole://{action}\""),
    };
    format!("#!/bin/bash\n# Raycast Script Command: 블랙홀\n# @raycast.schemaVersion 1\n# @raycast.title {title}\n# @raycast.mode silent\n# @raycast.packageName 블랙홀\n# @raycast.icon 🌑\n{argument}\n{open}\n")
}

/// Raycast Script Commands (넣기·찾기·기억·클립보드·캡처) in `~/.local/share/blackhole/raycast/`.
/// In Raycast: Settings → Extensions → Script Commands → Add Directories → this folder.
pub fn write_raycast_scripts(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let scripts = [
        ("blackhole-put.sh", raycast_script("블랙홀 넣기", Some("내용"), "put?text=")),
        ("blackhole-find.sh", raycast_script("블랙홀 찾기", Some("검색어"), "find?q=")),
        ("blackhole-memo.sh", raycast_script("블랙홀 기억", Some("기억할 내용"), "memo?text=")),
        ("blackhole-clipboard.sh", raycast_script("블랙홀 클립보드 보내기", None, "clipboard")),
        ("blackhole-capture.sh", raycast_script("블랙홀 화면 캡처해 넣기", None, "capture")),
    ];
    for (name, body) in scripts {
        let path = dir.join(name);
        std::fs::write(&path, body).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

/* ---------- right ⌘ twice ---------- */

/// Watches the right ⌘ key (key code 54): two quick presses with nothing else in between open the
/// quick window. Global key watching needs 손쉬운 사용 (Accessibility) — without it nothing happens.
#[cfg(target_os = "macos")]
pub fn watch_right_cmd(app: &AppHandle) {
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::ptr::NonNull;
    static LAST: Mutex<(f64, bool)> = Mutex::new((0.0, false)); // (time of last clean release, ⌘ held clean)
    let handle = app.clone();
    let on_event = move |ev: &NSEvent| {
        let mut last = LAST.lock().unwrap();
        if ev.r#type() == NSEventType::KeyDown {
            *last = (0.0, false);
            return;
        }
        if ev.keyCode() != 54 {
            *last = (0.0, false);
            return;
        }
        let down = ev.modifierFlags().contains(NSEventModifierFlags::Command);
        let t = ev.timestamp();
        if down {
            last.1 = true;
        } else if last.1 {
            if last.0 > 0.0 && t - last.0 < 0.4 {
                *last = (0.0, false);
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if load_settings(&h.path().app_data_dir().unwrap_or_default()).right_cmd_twice {
                        toggle_quick(&h);
                    }
                });
            } else {
                *last = (t, false);
            }
        }
    };
    let on_event = std::sync::Arc::new(on_event);
    let global = {
        let f = on_event.clone();
        block2::RcBlock::new(move |ev: NonNull<NSEvent>| f(unsafe { ev.as_ref() }))
    };
    let local = {
        let f = on_event.clone();
        block2::RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
            f(unsafe { ev.as_ref() });
            ev.as_ptr()
        })
    };
    let mask = NSEventMask::FlagsChanged | NSEventMask::KeyDown;
    let g = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global);
    // SAFETY: the handler returns the event unchanged.
    let l = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) };
    // The monitors live as long as the app.
    std::mem::forget((g, l, global, local));
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// 손쉬운 사용 allowed (needed only for right ⌘ twice).
pub fn accessibility_ok() -> bool {
    #[cfg(target_os = "macos")]
    // SAFETY: a plain query without arguments.
    return unsafe { AXIsProcessTrusted() };
    #[cfg(not(target_os = "macos"))]
    false
}

/* ---------- commands ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskStatus {
    settings: DeskSettings,
    autostart_on: bool,
    /// Shortcuts as the Mac menu shows them (⌥⌘K …).
    pretty: Shortcuts,
    problems: Vec<String>,
    sounds: Vec<String>,
    accessibility: bool,
    raycast_dir: String,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn status_of(app: &AppHandle, problems: Vec<String>) -> Result<DeskStatus, String> {
    let settings = load_settings(&data_dir(app)?);
    let s = &settings.shortcuts;
    let pretty = Shortcuts { quick: pretty_shortcut(&s.quick), clipboard: pretty_shortcut(&s.clipboard), capture: pretty_shortcut(&s.capture) };
    let raycast_dir = crate::worker::claude::data_dir().join("raycast");
    Ok(DeskStatus { autostart_on: autostart_on(), pretty, settings, problems, sounds: SOUNDS.iter().map(|s| s.to_string()).collect(), accessibility: accessibility_ok(), raycast_dir: raycast_dir.to_string_lossy().into_owned() })
}

#[tauri::command]
pub fn desk_status(app: AppHandle) -> Result<DeskStatus, String> {
    status_of(&app, Vec::new())
}

/// Save 설정 (shortcuts, login item, alarm sound, guide closed) and apply it at once.
#[tauri::command]
pub fn desk_set(app: AppHandle, settings: DeskSettings) -> Result<DeskStatus, String> {
    let dir = data_dir(&app)?;
    let before = load_settings(&dir);
    let mut problems = Vec::new();
    if settings.autostart != autostart_on() {
        if let Err(e) = set_autostart(settings.autostart) {
            problems.push(e);
        }
    }
    let mut settings = settings;
    settings.autostart_offered = true;
    if !SOUNDS.contains(&settings.alarm_sound.as_str()) {
        settings.alarm_sound = "Glass".into();
    }
    *app.state::<MacState>().sound.lock().unwrap() = settings.alarm_sound.clone();
    if settings.shortcuts != before.shortcuts {
        problems.extend(register_shortcuts(&app, &settings.shortcuts));
        let _ = build_tray(&app, &settings.shortcuts);
    }
    save_settings(&dir, &settings)?;
    status_of(&app, problems)
}

/// Play the chosen alarm sound once (설정).
#[tauri::command]
pub fn alarm_sound_try(sound: String) {
    if SOUNDS.contains(&sound.as_str()) {
        std::thread::spawn(move || {
            let _ = Command::new("/usr/bin/afplay").args(["-v", "1.6", &format!("/System/Library/Sounds/{sound}.aiff")]).status();
        });
    }
}

/// The quick-input window puts in a sentence or link.
#[tauri::command]
pub fn quick_put_text(app: AppHandle, text: String, via: Option<String>, secret: Option<bool>) -> Result<Intake, String> {
    let text = text.trim().to_string();
    let result = intake(&app, &text, secret, true)?;
    if result == Intake::Put {
        // (checked above; put_text checks again and finds nothing to keep)
        if let Some(url) = single_url(&text) {
            let (app2, via2) = (app.clone(), via.clone().unwrap_or_else(|| "빠른 입력".into()));
            std::thread::spawn(move || {
                let link = fetch_link(&url);
                emit_put(&app2, Put { link: Some(link), via: via2, ..Put::default() });
            });
        } else if !text.is_empty() {
            emit_put(&app, Put { text: Some(text), via: via.unwrap_or_else(|| "빠른 입력".into()), ..Put::default() });
        }
    }
    if result != Intake::Ask {
        if let Some(w) = app.get_webview_window(QUICK) {
            let _ = w.hide();
        }
    }
    Ok(result)
}

/// The main page's own input: secrets are kept out of the calendar and the chat too.
#[tauri::command]
pub fn secret_intake(app: AppHandle, text: String, secret: Option<bool>) -> Result<Intake, String> {
    intake(&app, &text, secret, true)
}

/// ⌘Enter: keep as 기억 (no AI). Also an Obsidian note under 노트/기억/ when Drive 「블랙홀」 is here.
#[tauri::command]
pub fn quick_memo(app: AppHandle, text: String, secret: Option<bool>) -> Result<Intake, String> {
    let text = text.trim().to_string();
    let result = intake(&app, &text, secret, true)?;
    if result == Intake::Put && !text.is_empty() {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        if let Some(root) = calendar::find_drive_blackhole(&home) {
            let _ = crate::find::write_memo_note(&root, &text);
        }
        emit_put(&app, Put { memo: Some(text), via: "빠른 입력".into(), ..Put::default() });
    }
    if result != Intake::Ask {
        if let Some(w) = app.get_webview_window(QUICK) {
            let _ = w.hide();
        }
    }
    Ok(result)
}

fn saved_state(app: &AppHandle) -> Option<serde_json::Value> {
    calendar::load_state(&app.path().app_data_dir().ok()?).ok().flatten()
}

/// Search as you type: entries and secret names, on this Mac only (no API, no cost).
#[tauri::command]
pub fn quick_search(app: AppHandle, query: String) -> Vec<crate::find::Hit> {
    let dir = app.path().app_data_dir().unwrap_or_default();
    crate::find::search(saved_state(&app).as_ref(), &crate::secret::list(&dir), &query, 8)
}

/// The empty quick window: today's appointments and what is due (open to-dos up to today).
#[tauri::command]
pub fn quick_today(app: AppHandle) -> Vec<crate::find::Hit> {
    let Some(state) = saved_state(&app) else { return Vec::new() };
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut out: Vec<(String, crate::find::Hit)> = Vec::new();
    for x in crate::find::entries(&state) {
        let s = |k: &str| x[k].as_str().unwrap_or("").to_string();
        let hit = |kind: &str, sub: String| crate::find::Hit { id: s("id"), kind: kind.into(), title: s("title"), sub };
        match x["kind"].as_str() {
            Some("event") if s("date") == today => out.push((x["start"].as_str().unwrap_or("00:00").to_string(), hit("일정", x["start"].as_str().unwrap_or("종일").to_string()))),
            Some("task") if x["done"] != true && x["noDue"] != true && s("due") <= today => {
                let late = s("due") < today;
                out.push((format!("~{}", x["dueTime"].as_str().unwrap_or("99")), hit("할 일", if late { format!("{} 지남", s("due")) } else { format!("오늘{}", x["dueTime"].as_str().map(|t| format!(" {t}")).unwrap_or_default()) })));
            }
            _ => {}
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().take(10).map(|(_, h)| h).collect()
}

/// ⇧Enter: answer from the user's own records (one small Claude call).
#[tauri::command]
pub async fn quick_ask(app: AppHandle, question: String) -> Result<crate::find::Answer, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !matches!(crate::secret::guess(&question), crate::secret::Guess::None) {
        return Err("비밀 정보처럼 보이는 글은 AI에 보내지 않습니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || crate::find::ask(&dir, &question)).await.map_err(|e| e.to_string())?
}

/// What the local answer index needs besides the calendar: secret names (never values) and the
/// Obsidian notes under Drive 「블랙홀/노트/」.
#[derive(serde::Serialize)]
pub struct AskSources {
    secrets: Vec<crate::secret::SecretName>,
    notes: Vec<crate::find::NoteDoc>,
}

#[tauri::command]
pub async fn ask_sources(app: AppHandle) -> AskSources {
    let dir = app.path().app_data_dir().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let notes = calendar::find_drive_blackhole(&home).map(|root| crate::find::scan_notes(&root)).unwrap_or_default();
        AskSources { secrets: crate::secret::list(&dir), notes }
    })
    .await
    .unwrap_or(AskSources { secrets: Vec::new(), notes: Vec::new() })
}

#[derive(serde::Serialize)]
pub struct AskReply {
    answer: String,
    ids: Vec<String>,
}

/// A question the local index could not settle: the few lines it found go to Claude (short).
/// Lines that look like a secret value are dropped before sending.
#[tauri::command]
pub async fn ask_records(question: String, lines: Vec<String>) -> Result<AskReply, String> {
    if !matches!(crate::secret::guess(&question), crate::secret::Guess::None) {
        return Err("비밀 정보처럼 보이는 글은 AI에 보내지 않습니다.".into());
    }
    let lines: Vec<String> = lines.into_iter().filter(|l| matches!(crate::secret::guess(l), crate::secret::Guess::None)).take(12).map(|l| l.chars().take(400).collect()).collect();
    tauri::async_runtime::spawn_blocking(move || crate::find::ask_lines(&question, &lines).map(|(answer, ids)| AskReply { answer, ids }))
        .await
        .map_err(|e| e.to_string())?
}

/// Every 기억 made in the main window (a sentence with no day or time, 「메모 …」, the AI's NOTE,
/// a phone note) is also an Obsidian note under Drive 「블랙홀/노트/기억/」. No Drive → nothing.
#[tauri::command]
pub fn memo_note(text: String, via: Option<String>) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() || !matches!(crate::secret::guess(&text), crate::secret::Guess::None) {
        return Ok(());
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    if let Some(root) = calendar::find_drive_blackhole(&home) {
        crate::find::write_memo_note_from(&root, &text, &via.unwrap_or_else(|| "Mac".into()))?;
    }
    Ok(())
}

/// Open an Obsidian note from an answer card (only files under Drive 「블랙홀/노트/」).
#[tauri::command]
pub fn note_open(path: String) -> Result<(), String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let root = calendar::find_drive_blackhole(&home).ok_or("드라이브 「블랙홀」 폴더가 없습니다.")?.join("노트");
    let full = root.join(&path).canonicalize().map_err(|_| "노트를 찾지 못했습니다.".to_string())?;
    if !full.starts_with(root.canonicalize().map_err(|e| e.to_string())?) || full.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("노트 폴더 밖은 열 수 없습니다.".into());
    }
    Command::new("/usr/bin/open").arg(&full).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open a search result in the main window (its day).
#[tauri::command]
pub fn quick_open(app: AppHandle, id: String) {
    emit_put(&app, Put { open: Some(id), via: "찾기".into(), ..Put::default() });
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.hide();
    }
    show_main(&app);
}

#[tauri::command]
pub async fn secret_copy(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::secret::copy(&name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_reveal(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::secret::reveal(&name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn secret_remove(app: AppHandle, name: String) -> Result<(), String> {
    crate::secret::remove(&app.path().app_data_dir().map_err(|e| e.to_string())?, &name)
}

#[tauri::command]
pub fn secrets_list(app: AppHandle) -> Vec<crate::secret::SecretName> {
    crate::secret::list(&app.path().app_data_dir().unwrap_or_default())
}

/// A pasted or dropped picture/file as bytes (name in `x-file-name`, percent-encoded).
#[tauri::command]
pub fn quick_put_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("내용이 없습니다.".into()) };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let name = crate::desk::percent_decode(&header("x-file-name").unwrap_or_else(|| "붙여넣기.png".into()));
    let via = crate::desk::percent_decode(&header("x-via").unwrap_or_else(|| "빠른%20입력".into()));
    put_bytes(&app, &name, bytes, &via)?;
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.hide();
    }
    Ok(())
}

/// A dropped file path (quick window).
#[tauri::command]
pub fn quick_put_path(app: AppHandle, path: String, via: Option<String>) {
    put_path(&app, Path::new(&path), via.as_deref().unwrap_or("끌어 놓기"));
}

#[tauri::command]
pub fn quick_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn quick_action(app: AppHandle, action: String) {
    run_action(&app, &action);
}

/// 처음 안내: ask for speech recognition once (runs the helper on a short silent file).
#[tauri::command]
pub async fn speech_permission() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = std::env::temp_dir().join("blackhole-permission");
        let _ = std::fs::create_dir_all(&dir);
        let wav = dir.join("silence.wav");
        let _ = std::fs::write(&wav, crate::worker::source::pcm16_wav(16_000, &vec![0; 8_000]));
        let result = crate::worker::speech::MacSpeech.run(&wav);
        let _ = std::fs::remove_dir_all(&dir);
        match result {
            Err(e) if e.message.contains("NOT_AUTHORIZED") => Err("음성 인식이 꺼져 있습니다. 시스템 설정 → 개인정보 보호 → 음성 인식에서 블랙홀을 켜 주세요.".to_string()),
            Err(e) if e.message.contains("UNAVAILABLE") || e.message.contains("실행할 수 없습니다") => Err(e.message),
            // Silence gives 「no speech」: the permission itself is fine.
            _ => Ok("음성 인식 허용됨".to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a 개인정보 보호 page of System Settings (nothing is changed here).
#[tauri::command]
pub fn open_privacy(pane: String) -> Result<(), String> {
    let anchor = match pane.as_str() {
        "microphone" => "Privacy_Microphone",
        "speech" => "Privacy_SpeechRecognition",
        "screen" => "Privacy_ScreenCapture",
        "notifications" => "",
        "accessibility" => "Privacy_Accessibility",
        _ => return Err("알 수 없는 설정입니다.".into()),
    };
    let url = if anchor.is_empty() { "x-apple.systempreferences:com.apple.preference.notifications".to_string() } else { format!("x-apple.systempreferences:com.apple.preference.security?{anchor}") };
    Command::new("/usr/bin/open").arg(url).status().map(|_| ()).map_err(|e| e.to_string())
}

/// 설정: write the Raycast scripts and show their folder in Finder.
#[tauri::command]
pub fn raycast_install() -> Result<String, String> {
    let dir = crate::worker::claude::data_dir().join("raycast");
    write_raycast_scripts(&dir)?;
    let _ = Command::new("/usr/bin/open").arg(&dir).status();
    Ok(dir.to_string_lossy().into_owned())
}

/// The quick window, once loaded: a query that arrived before it (Raycast 「찾기」).
#[tauri::command]
pub fn quick_query_take(app: AppHandle) -> String {
    std::mem::take(&mut *app.state::<MacState>().quick_query.lock().unwrap())
}

#[tauri::command]
pub fn notify_test(app: AppHandle) {
    notify(&app, "블랙홀", "알림이 이렇게 뜹니다.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_read_like_the_mac_menu() {
        assert_eq!(pretty_shortcut("Alt+Super+K"), "⌥⌘K");
        assert_eq!(pretty_shortcut("Shift+Alt+Super+B"), "⌥⇧⌘B");
        assert_eq!(pretty_shortcut("Ctrl+Space"), "⌃Space");
    }

    #[test]
    fn links_and_pages() {
        assert_eq!(single_url(" https://example.com/a?b=1 "), Some("https://example.com/a?b=1".into()));
        assert_eq!(single_url("내일 https://example.com"), None);
        assert_eq!(single_url("ftp://x"), None);
        let (title, text) = page_text("<html><head><title> 가을 &amp; 축제 </title><meta name=\"description\" content=\"11월 3일 오후 2시\"><script>var x=1</script></head><body><h1>안내</h1><p>장소: 강당</p></body></html>");
        assert_eq!(title, "가을 & 축제");
        assert!(text.starts_with("11월 3일 오후 2시\n") && text.contains("안내 장소: 강당") && !text.contains("var x"), "{text}");
    }

    #[test]
    fn raycast_scripts_open_blackhole_urls() {
        let dir = tempfile::tempdir().unwrap();
        write_raycast_scripts(dir.path()).unwrap();
        let put = std::fs::read_to_string(dir.path().join("blackhole-put.sh")).unwrap();
        assert!(put.contains("@raycast.title 블랙홀 넣기") && put.contains("@raycast.argument1") && put.contains("blackhole://put?text=$q"));
        let clip = std::fs::read_to_string(dir.path().join("blackhole-clipboard.sh")).unwrap();
        assert!(clip.contains("/usr/bin/open \"blackhole://clipboard\"") && !clip.contains("argument1"));
        let u = tauri::Url::parse("blackhole://put?text=%EB%82%B4%EC%9D%BC%203%EC%8B%9C").unwrap();
        assert_eq!(u.host_str(), Some("put"));
        assert_eq!(query_param(&u, "text").as_deref(), Some("내일 3시"));
    }

    #[test]
    fn login_item_points_at_the_app() {
        let p = agent_plist(Path::new("/Applications/Blackhole.app/Contents/MacOS/blackhole-desktop"));
        assert!(p.contains("<string>/Applications/Blackhole.app/Contents/MacOS/blackhole-desktop</string><string>--login</string>"));
        assert!(p.contains("RunAtLoad"));
    }

    #[test]
    fn settings_default_and_tray_icon() {
        let d = DeskSettings::default();
        assert_eq!(d.shortcuts.clipboard, "Ctrl+Alt+Super+V");
        assert_eq!(pretty_shortcut(&d.shortcuts.quick), "⌃⌥⌘Space");
        assert!(d.right_cmd_twice);
        assert_eq!(d.alarm_sound, "Glass");
        let s: DeskSettings = serde_json::from_str(r#"{"autostart":true}"#).unwrap();
        assert!(s.autostart && s.shortcuts.quick == "Ctrl+Alt+Super+Space");
        let px = tray_rgba(44);
        assert_eq!(px.len(), 44 * 44 * 4);
        assert_eq!(px[(22 * 44 + 22) * 4 + 3], 0, "the middle is empty (the dark moon)");
        assert!(px.chunks(4).filter(|p| p[3] > 200).count() > 200, "a visible ring");
    }
}
