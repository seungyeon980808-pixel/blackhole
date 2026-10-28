//! Desktop-side pieces of the calendar app that do not need a window: the local state
//! file, saved inputs, the test-folder inbox and alarm bookkeeping. Commands in `desk.rs`
//! wrap these so they stay testable without Tauri.

use crate::worker::{error::WorkerError, queue::Job, queue::JobState};
use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const STATE_FILE: &str = "blackhole-calendar-v1.json";
pub const INPUT_DIR: &str = "입력";
pub const TEST_INBOX_DIR: &str = "시험-블랙홀";
/// Shared copy for the phone, at the top of the Drive 「블랙홀」 folder.
pub const SHARED_FILE: &str = "달력.json";

/// Load the calendar state. A file that is not JSON is moved aside (never deleted) and
/// `None` is returned, so the app starts fresh instead of crashing.
pub fn load_state(dir: &Path) -> io::Result<Option<serde_json::Value>> {
    let path = dir.join(STATE_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)?;
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(v) if v.get("schemaVersion").and_then(|x| x.as_u64()) == Some(1) => Ok(Some(v)),
        _ => {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            fs::rename(&path, dir.join(format!("{STATE_FILE}.corrupt-{stamp}")))?;
            Ok(None)
        }
    }
}

pub fn save_state(dir: &Path, state: &serde_json::Value) -> io::Result<()> {
    if state.get("schemaVersion").and_then(|x| x.as_u64()) != Some(1) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "schemaVersion 1만 저장합니다."));
    }
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    AtomicFile::new(dir.join(STATE_FILE), AllowOverwrite)
        .write(|f| {
            f.write_all(&bytes)?;
            f.sync_all()
        })
        .map_err(|e| io::Error::other(e.to_string()))
}

/// Keep only a plain file name: no folders, no leading dots, at most 80 characters.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim();
    let cleaned = if cleaned.is_empty() { "input" } else { cleaned };
    cleaned.chars().rev().take(80).collect::<Vec<_>>().into_iter().rev().collect()
}

/// Photos, recordings and files sent from the app are kept as `입력/<sha8>-<name>` so the
/// worker reads a stable original. Same bytes are written once.
pub fn keep_input(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let sha = format!("{:x}", Sha256::digest(bytes));
    let folder = dir.join(INPUT_DIR);
    fs::create_dir_all(&folder)?;
    let path = folder.join(format!("{}-{}", &sha[..8], safe_file_name(name)));
    if !path.exists() {
        AtomicFile::new(&path, AllowOverwrite)
            .write(|f| f.write_all(bytes))
            .map_err(|e| io::Error::other(e.to_string()))?;
    }
    Ok(path)
}

/// Is `root` the 「블랙홀」 folder in the Google Drive for desktop mount
/// (`~/Library/CloudStorage/GoogleDrive-*/내 드라이브|My Drive/블랙홀`)?
pub fn is_drive_blackhole(root: &Path) -> bool {
    let parts: Vec<String> = root.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let n = parts.len();
    n >= 4
        && parts[n - 1] == "블랙홀"
        && matches!(parts[n - 2].as_str(), "내 드라이브" | "My Drive")
        && parts[n - 3].starts_with("GoogleDrive-")
        && parts[n - 4] == "CloudStorage"
}

/// Folders the inbox may scan: the local test folder, or (since the phone created it,
/// 2026-10-25) the Drive 「블랙홀」 folder itself. Other synced folders are refused.
/// The scanner only adds 원본/ copies and 노트/; it never deletes or moves inbox originals.
pub fn check_inbox_root(root: &Path) -> Result<(), String> {
    let text = root.to_string_lossy();
    if !root.is_absolute() {
        return Err(format!("절대 경로가 필요합니다: {text}"));
    }
    if is_drive_blackhole(root) {
        return if root.is_dir() { Ok(()) } else { Err(format!("드라이브 「블랙홀」 폴더가 없습니다(휴대폰이 먼저 만듭니다): {text}")) };
    }
    let lower = text.to_lowercase();
    if ["cloudstorage", "google drive", "googledrive", "내 드라이브", "my drive", "icloud", "mobile documents", "dropbox", "onedrive"].iter().any(|k| lower.contains(k)) {
        return Err(format!("동기화 폴더는 드라이브 「블랙홀」 폴더만 씁니다: {text}"));
    }
    Ok(())
}

/// The Drive 「블랙홀」 folder, when Google Drive for desktop is mounted and the phone made it.
pub fn find_drive_blackhole(home: &Path) -> Option<PathBuf> {
    let cloud = home.join("Library").join("CloudStorage");
    let mut found: Vec<PathBuf> = fs::read_dir(&cloud)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("GoogleDrive-")))
        .flat_map(|p| ["내 드라이브", "My Drive"].map(|d| p.join(d).join("블랙홀")))
        .filter(|p| p.is_dir())
        .collect();
    found.sort();
    found.into_iter().next()
}

/// Write the shared calendar copy into `<root>/달력.json`, but only into a file that already
/// exists: the phone creates it, because its Drive permission (drive.file) only reaches files it
/// made itself. Written in place (same Drive file), never created or renamed here.
/// Returns false when the file already holds the same content (ignoring `exportedAt`): every
/// write makes Google Drive upload the file again, so an unchanged copy is never rewritten.
pub fn write_shared(root: &Path, shared: &serde_json::Value) -> Result<bool, String> {
    if shared.get("kind").and_then(|k| k.as_str()) != Some("blackhole-calendar") {
        return Err("공유 사본 형식이 아닙니다.".into());
    }
    let path = root.join(SHARED_FILE);
    if !path.is_file() {
        return Err("휴대폰이 아직 「달력.json」을 만들지 않았습니다. 휴대폰에서 블랙홀 달력을 한 번 열어 주세요.".into());
    }
    let without_stamp = |v: &serde_json::Value| {
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut() {
            o.remove("exportedAt");
        }
        v
    };
    if let Ok(old) = fs::read(&path).map_err(|_| ()).and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).map_err(|_| ())) {
        if without_stamp(&old) == without_stamp(shared) {
            return Ok(false);
        }
    }
    let bytes = serde_json::to_vec(shared).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new().write(true).truncate(true).open(&path).map_err(|e| format!("「달력.json」을 열 수 없습니다: {e}"))?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("「달력.json」을 쓰지 못했습니다: {e}"))?;
    Ok(true)
}

/// Days a phone action file is still read. Files are never deleted and the app remembers only
/// the last 2,000 applied action ids, so an old 「체크」 read again after it was forgotten would
/// flip the to-do back; 60 days stays far inside those 2,000.
pub const PHONE_ACTION_DAYS: i64 = 60;

/// Phone actions: every `인박스/*.bhact` file (one JSON action or a list) from the last
/// `PHONE_ACTION_DAYS` days. Read only.
pub fn read_phone_actions(root: &Path) -> Vec<serde_json::Value> {
    let since = (chrono::Local::now() - chrono::Duration::days(PHONE_ACTION_DAYS)).format("%Y%m%d").to_string();
    read_phone_actions_since(root, &since)
}

/// `since` is a `yyyymmdd` day: files named from an earlier day (the phone names them
/// `yyyymmdd-hhmmss-…`) are skipped; a name without a day is still read.
pub fn read_phone_actions_since(root: &Path, since: &str) -> Vec<serde_json::Value> {
    let Ok(entries) = fs::read_dir(root.join("인박스")) else { return Vec::new() };
    let old = |p: &Path| {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let day: String = name.chars().take(8).collect();
        day.len() == 8 && day.chars().all(|c| c.is_ascii_digit()) && day.as_str() < since
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == crate::worker::inbox::PHONE_ACTION_EXT) && !old(p))
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        let Ok(bytes) = fs::read(&path) else { continue };
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(serde_json::Value::Array(list)) => out.extend(list),
            Ok(v @ serde_json::Value::Object(_)) => out.push(v),
            _ => {}
        }
    }
    out.retain(|a| a.get("id").and_then(|v| v.as_str()).is_some() && a.get("type").and_then(|v| v.as_str()).is_some());
    out
}

/// An inbox file whose words are already known, drafted before the worker gets to it:
/// a `.txt` (typed on the phone, a messenger line) or a phone recording's `.bhstt` transcript.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxDraft {
    /// The worker's job id for the original ("job-" + first 16 hex of its SHA-256).
    pub job_id: String,
    pub file_name: String,
    pub text: String,
    /// "text" or "voice".
    pub kind: String,
    /// When the phone made it (epoch ms), if the file says.
    pub at: Option<i64>,
}

/// Phone transcript beside a recording (`인박스/<…>.bhstt`): the phone's own on-device speech
/// recognition, so the Mac can draft without waiting for whisper.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhoneTranscript {
    kind: String,
    sha256: String,
    text: String,
    #[serde(default)]
    at: Option<i64>,
}

/// Remembers the job id of each small file by (name, size, modified), so polling every few
/// seconds does not re-hash anything.
#[derive(Default)]
pub struct DraftScan {
    seen: std::collections::HashMap<PathBuf, (u64, SystemTime, Option<InboxDraft>)>,
}

/// Small text inputs only; anything larger is left to the worker.
const DRAFT_MAX_BYTES: u64 = 64 * 1024;

impl DraftScan {
    /// Drafts for `<root>/인박스` files modified after `since`. Reads only `.txt`/`.md` and
    /// `.bhstt`; never writes, moves or deletes anything.
    pub fn scan(&mut self, root: &Path, since: SystemTime) -> Vec<InboxDraft> {
        let Ok(entries) = fs::read_dir(root.join("인박스")) else { return Vec::new() };
        let mut paths: Vec<(PathBuf, fs::Metadata)> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok().map(|m| (e.path(), m)))
            .filter(|(p, m)| {
                m.is_file()
                    && m.len() > 0
                    && m.len() <= DRAFT_MAX_BYTES
                    && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
                    && m.modified().is_ok_and(|t| t >= since)
                    && p.extension().is_some_and(|e| {
                        let e = e.to_string_lossy().to_lowercase();
                        e == "txt" || e == "md" || e == crate::worker::inbox::PHONE_STT_EXT
                    })
            })
            .collect();
        paths.sort_by(|a, b| a.0.cmp(&b.0));
        let mut out = Vec::new();
        for (path, meta) in paths {
            let modified = meta.modified().unwrap_or(UNIX_EPOCH);
            if let Some((len, at, draft)) = self.seen.get(&path) {
                if *len == meta.len() && *at == modified {
                    out.extend(draft.clone());
                    continue;
                }
            }
            let draft = fs::read(&path).ok().and_then(|bytes| draft_of(&path, &bytes));
            self.seen.insert(path, (meta.len(), modified, draft.clone()));
            out.extend(draft);
        }
        out
    }
}

fn draft_of(path: &Path, bytes: &[u8]) -> Option<InboxDraft> {
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    if path.extension().is_some_and(|e| e == crate::worker::inbox::PHONE_STT_EXT) {
        let t: PhoneTranscript = serde_json::from_slice(bytes).ok()?;
        let ok = t.kind == "blackhole-stt" && t.sha256.len() >= 16 && t.sha256.chars().all(|c| c.is_ascii_hexdigit());
        if !ok || t.text.trim().is_empty() {
            return None;
        }
        return Some(InboxDraft { job_id: format!("job-{}", &t.sha256[..16].to_lowercase()), file_name, text: t.text.trim().to_string(), kind: "voice".into(), at: t.at });
    }
    let text = std::str::from_utf8(bytes).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    let sha = crate::worker::source::sha256_hex(bytes);
    Some(InboxDraft { job_id: format!("job-{}", &sha[..16]), file_name, text: text.to_string(), kind: "text".into(), at: None })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxResult {
    pub job_id: String,
    pub file_name: String,
    pub proposal: Option<crate::worker::proposal::Proposal>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct QueueFileView {
    jobs: Vec<Job>,
}

/// Finished inbox jobs, read straight from the queue file. Read-only on purpose: opening
/// the queue with `Queue::open` would mark a job the scanner is analyzing as interrupted.
/// Failed jobs are reported only after the scanner gave up (MAX_ATTEMPTS). Jobs last changed
/// more than `RESULT_DAYS` ago are left out: the page took them long ago (the scanner runs only
/// while the app does), and the list is polled every 5 s while the queue file only grows.
pub fn inbox_results(state_dir: &Path) -> io::Result<Vec<InboxResult>> {
    inbox_results_since(state_dir, chrono::Local::now().fixed_offset() - chrono::Duration::days(RESULT_DAYS))
}

pub const RESULT_DAYS: i64 = 14;

/// `inbox_results` for jobs changed after `since` (a job without a readable time is kept).
pub fn inbox_results_since(state_dir: &Path, since: chrono::DateTime<chrono::FixedOffset>) -> io::Result<Vec<InboxResult>> {
    let path = state_dir.join("jobs-v1.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file: QueueFileView = serde_json::from_slice(&fs::read(path)?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(file
        .jobs
        .into_iter()
        .filter(|job| chrono::DateTime::parse_from_rfc3339(&job.updated_at).map_or(true, |t| t >= since))
        .filter_map(|job| {
            let file_name = Path::new(&job.source_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "입력".into());
            // 원본 copies are named <sha8>-<name>; show the original name.
            let file_name = match file_name.split_once('-') {
                Some((h, rest)) if h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit()) => rest.to_string(),
                _ => file_name,
            };
            match job.state {
                JobState::HasResult => Some(InboxResult { job_id: job.job_id, file_name, proposal: job.proposal, error: None }),
                // Waiting for the analyzer (off, missing) is not a final failure.
                JobState::Failed if job.last_error.as_ref().is_some_and(|e| e.code.is_waiting()) => None,
                JobState::Failed if job.attempts >= crate::worker::inbox::MAX_ATTEMPTS => Some(InboxResult {
                    job_id: job.job_id,
                    file_name,
                    proposal: None,
                    error: Some(job.last_error.map(|e: WorkerError| e.message).unwrap_or_else(|| "실패".into())),
                }),
                _ => None,
            }
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlarmSpec {
    pub key: String,
    pub at_ms: i64,
    pub title: String,
    /// What the alarm window shows and sends back (the page's Alarm, as is).
    #[serde(default)]
    pub body: String,
    /// "event" | "task"
    #[serde(default)]
    pub kind: String,
    /// Entry id ("" for a test alarm).
    #[serde(default, rename = "ref")]
    pub entry: String,
    /// "YYYY-MM-DDTHH:MM"
    #[serde(default)]
    pub at: String,
    /// Passed while the app was not running: shown once, rung once.
    #[serde(default)]
    pub missed: bool,
}

/// Remove and return the alarms due at `now_ms`.
pub fn take_due(alarms: &mut Vec<AlarmSpec>, now_ms: i64) -> Vec<AlarmSpec> {
    let (due, rest): (Vec<_>, Vec<_>) = alarms.drain(..).partition(|a| a.at_ms <= now_ms);
    *alarms = rest;
    due
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> AlarmSpec {
        serde_json::from_value(serde_json::json!({"key":"","atMs":0,"title":""})).unwrap()
    }
    use serde_json::json;

    #[test]
    fn state_roundtrip_and_corrupt_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_state(dir.path()).unwrap(), None);
        let state = json!({"schemaVersion": 1, "events": [{"id": "e-1", "title": "회의"}]});
        save_state(dir.path(), &state).unwrap();
        assert_eq!(load_state(dir.path()).unwrap(), Some(state));
        assert!(save_state(dir.path(), &json!({"schemaVersion": 9})).is_err());

        fs::write(dir.path().join(STATE_FILE), b"{not json").unwrap();
        assert_eq!(load_state(dir.path()).unwrap(), None);
        let kept: Vec<_> = fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(kept.iter().any(|n| n.starts_with("blackhole-calendar-v1.json.corrupt-")), "{kept:?}");
    }

    #[test]
    fn inputs_are_kept_once_with_safe_names() {
        let dir = tempfile::tempdir().unwrap();
        let a = keep_input(dir.path(), "../../etc/가정통신문.png", b"png-bytes").unwrap();
        let b = keep_input(dir.path(), "다른이름.png", b"png-bytes").unwrap();
        assert!(a.starts_with(dir.path().join(INPUT_DIR)));
        assert!(a.file_name().unwrap().to_string_lossy().ends_with("-가정통신문.png"));
        assert_ne!(a, b);
        assert_eq!(fs::read(&a).unwrap(), b"png-bytes");
        assert_eq!(safe_file_name(".hidden"), "hidden");
        assert_eq!(safe_file_name(""), "input");
        assert_eq!(safe_file_name("a:b?.txt"), "a_b_.txt");
    }

    #[test]
    fn only_the_drive_blackhole_folder_is_allowed_among_synced_folders() {
        let home = tempfile::tempdir().unwrap();
        let drive = home.path().join("Library/CloudStorage/GoogleDrive-owner@example.invalid/내 드라이브/블랙홀");
        assert!(is_drive_blackhole(&drive));
        assert!(check_inbox_root(&drive).is_err(), "missing folder is refused");
        assert_eq!(find_drive_blackhole(home.path()), None);
        fs::create_dir_all(&drive).unwrap();
        assert!(check_inbox_root(&drive).is_ok());
        assert_eq!(find_drive_blackhole(home.path()), Some(drive.clone()));
        let other = drive.parent().unwrap().join("다른폴더");
        fs::create_dir_all(&other).unwrap();
        assert!(check_inbox_root(&other).is_err());
        assert!(check_inbox_root(&drive.join("인박스")).is_err());
    }

    #[test]
    fn shared_copy_is_written_only_into_the_phone_made_file_and_actions_are_read_only() {
        let root = tempfile::tempdir().unwrap();
        let shared = json!({"kind": "blackhole-calendar", "schemaVersion": 1, "events": []});
        assert!(write_shared(root.path(), &shared).unwrap_err().contains("휴대폰이 아직"));
        assert!(!root.path().join(SHARED_FILE).exists(), "never created here");
        fs::write(root.path().join(SHARED_FILE), b"{}").unwrap();
        assert!(write_shared(root.path(), &shared).unwrap());
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(root.path().join(SHARED_FILE)).unwrap()).unwrap(), shared);
        // Same content with a new exportedAt: not written again (Google Drive would re-upload it).
        let modified = fs::metadata(root.path().join(SHARED_FILE)).unwrap().modified().unwrap();
        let mut later = shared.clone();
        later["exportedAt"] = json!("2026-10-26T15:01");
        assert!(!write_shared(root.path(), &later).unwrap());
        assert_eq!(fs::metadata(root.path().join(SHARED_FILE)).unwrap().modified().unwrap(), modified);
        later["events"] = json!([{"id": "e-1"}]);
        assert!(write_shared(root.path(), &later).unwrap());
        assert!(write_shared(root.path(), &json!({"x": 1})).is_err());

        let inbox = root.path().join("인박스");
        fs::create_dir_all(&inbox).unwrap();
        fs::write(inbox.join("20261025-1-폰-a-동작.bhact"), br#"{"id":"a1","type":"confirm","ref":"e-1","at":"x"}"#).unwrap();
        fs::write(inbox.join("20261025-2-폰-b-동작.bhact"), br#"[{"id":"a2","type":"toggleTask","ref":"t-1","at":"x"},{"bad":1}]"#).unwrap();
        fs::write(inbox.join("메모.txt"), b"x").unwrap();
        fs::write(inbox.join("20260801-1-폰-c-동작.bhact"), br#"{"id":"a0","type":"toggleTask","ref":"t-1","at":"x"}"#).unwrap();
        let actions = read_phone_actions_since(root.path(), "20260901");
        assert_eq!(actions.iter().map(|a| a["id"].as_str().unwrap()).collect::<Vec<_>>(), ["a1", "a2"], "an action file older than the window is not read again");
        assert!(inbox.join("20261025-1-폰-a-동작.bhact").exists(), "action files stay");
    }

    #[test]
    fn inbox_drafts_read_phone_text_and_transcripts_without_touching_them() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("인박스");
        fs::create_dir_all(&inbox).unwrap();
        let text = "내일 오후 3시에 학부모 상담\n";
        fs::write(inbox.join("20261026-144221-폰-d9b148fe.txt"), text).unwrap();
        let wav = b"RIFF....WAVEfmt fake";
        let wav_sha = crate::worker::source::sha256_hex(wav);
        fs::write(inbox.join("20261026-144200-폰-59ea29b6.wav"), wav).unwrap();
        let stt = serde_json::json!({"kind":"blackhole-stt","sha256":wav_sha,"text":" 금요일까지 보고서 제출 ","at":1761457320000_i64});
        fs::write(inbox.join("20261026-144200-폰-59ea29b6.bhstt"), stt.to_string()).unwrap();
        fs::write(inbox.join("20261026-1-폰-a-동작.bhact"), br#"{"id":"a"}"#).unwrap();
        fs::write(inbox.join("broken.bhstt"), b"{not json").unwrap();

        let mut scan = DraftScan::default();
        let drafts = scan.scan(dir.path(), UNIX_EPOCH);
        assert_eq!(drafts.len(), 2, "{drafts:?}");
        let voice = drafts.iter().find(|d| d.kind == "voice").unwrap();
        assert_eq!(voice.job_id, format!("job-{}", &wav_sha[..16]));
        assert_eq!(voice.text, "금요일까지 보고서 제출");
        assert_eq!(voice.at, Some(1761457320000));
        let typed = drafts.iter().find(|d| d.kind == "text").unwrap();
        // Same job id the worker queue gives the same bytes.
        assert_eq!(typed.job_id, format!("job-{}", &crate::worker::source::sha256_hex(text.as_bytes())[..16]));
        assert_eq!(typed.text, "내일 오후 3시에 학부모 상담");
        // Cached: same answer, files untouched.
        assert_eq!(scan.scan(dir.path(), UNIX_EPOCH), drafts);
        assert_eq!(fs::read_to_string(inbox.join("20261026-144221-폰-d9b148fe.txt")).unwrap(), text);
        // Old files are skipped.
        assert!(scan.scan(dir.path(), SystemTime::now() + std::time::Duration::from_secs(60)).is_empty());
    }

    #[test]
    fn synced_folders_are_refused() {
        assert!(check_inbox_root(Path::new("/Users/me/Google Drive/블랙홀")).is_err());
        assert!(check_inbox_root(Path::new("relative/블랙홀")).is_err());
        assert!(check_inbox_root(Path::new("/Users/me/Library/Application Support/x/시험-블랙홀")).is_ok());
    }

    #[test]
    fn due_alarms_are_taken_once() {
        let mut list = vec![
            AlarmSpec { key: "a".into(), at_ms: 100, title: "A".into(), ..spec() },
            AlarmSpec { key: "b".into(), at_ms: 300, title: "B".into(), ..spec() },
        ];
        assert!(take_due(&mut list, 50).is_empty());
        assert_eq!(take_due(&mut list, 200).iter().map(|a| a.key.as_str()).collect::<Vec<_>>(), ["a"]);
        assert!(take_due(&mut list, 200).is_empty());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn inbox_results_reads_finished_jobs_without_touching_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        assert!(inbox_results(dir.path()).unwrap().is_empty());
        let proposal: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/proposal-sample.json")).unwrap();
        let queue = json!({"schemaVersion": 1, "jobs": [
            {"jobId": "job-1", "sourceSha256": "a", "sourcePath": "/x/원본/2026/10/0123abcd-공문.hwp", "sourceText": "", "engine": "A", "state": "HAS_RESULT", "attempts": 1, "lastError": null, "proposal": proposal, "createdAt": "", "updatedAt": ""},
            {"jobId": "job-2", "sourceSha256": "b", "sourcePath": "/x/b.png", "sourceText": "", "engine": "A", "state": "ANALYZING", "attempts": 1, "lastError": null, "proposal": null, "createdAt": "", "updatedAt": ""},
            {"jobId": "job-3", "sourceSha256": "c", "sourcePath": "/x/c.png", "sourceText": "", "engine": "A", "state": "FAILED", "attempts": 1, "lastError": {"code": "RUNNER_UNAVAILABLE", "message": "꺼짐"}, "proposal": null, "createdAt": "", "updatedAt": ""},
            {"jobId": "job-5", "sourceSha256": "e", "sourcePath": "/x/e.png", "sourceText": "", "engine": "A", "state": "FAILED", "attempts": 3, "lastError": {"code": "RUNNER_UNAVAILABLE", "message": "꺼짐"}, "proposal": null, "createdAt": "", "updatedAt": ""},
            {"jobId": "job-4", "sourceSha256": "d", "sourcePath": "/x/d.png", "sourceText": "", "engine": "A", "state": "FAILED", "attempts": 3, "lastError": {"code": "RUNNER_FAILED", "message": "꺼짐"}, "proposal": null, "createdAt": "", "updatedAt": ""}
        ]});
        let path = dir.path().join("jobs-v1.json");
        fs::write(&path, serde_json::to_vec(&queue).unwrap()).unwrap();
        let before = fs::read(&path).unwrap();
        let results = inbox_results(dir.path()).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].file_name, "공문.hwp");
        assert!(results[0].proposal.is_some());
        assert_eq!(results[1].job_id, "job-4");
        assert_eq!(results[1].error.as_deref(), Some("꺼짐"));
        assert_eq!(fs::read(&path).unwrap(), before, "queue file must stay untouched");

        let mut queue = queue;
        queue["jobs"][0]["updatedAt"] = json!("2026-09-01T10:00:00+09:00");
        queue["jobs"][4]["updatedAt"] = json!("2026-10-27T10:00:00+09:00");
        fs::write(&path, serde_json::to_vec(&queue).unwrap()).unwrap();
        let since = chrono::DateTime::parse_from_rfc3339("2026-10-14T00:00:00+09:00").unwrap();
        let ids: Vec<String> = inbox_results_since(dir.path(), since).unwrap().into_iter().map(|r| r.job_id).collect();
        assert_eq!(ids, ["job-4"], "a job finished weeks ago is not handed out again");
    }
}
