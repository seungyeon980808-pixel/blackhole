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
/// Failed jobs are reported only after the scanner gave up (MAX_ATTEMPTS).
pub fn inbox_results(state_dir: &Path) -> io::Result<Vec<InboxResult>> {
    let path = state_dir.join("jobs-v1.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file: QueueFileView = serde_json::from_slice(&fs::read(path)?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(file
        .jobs
        .into_iter()
        .filter_map(|job| {
            let file_name = Path::new(&job.source_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "입력".into());
            // 원본 copies are named <sha8>-<name>; show the original name.
            let file_name = match file_name.split_once('-') {
                Some((h, rest)) if h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit()) => rest.to_string(),
                _ => file_name,
            };
            match job.state {
                JobState::HasResult => Some(InboxResult { job_id: job.job_id, file_name, proposal: job.proposal, error: None }),
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
    fn synced_folders_are_refused() {
        assert!(check_inbox_root(Path::new("/Users/me/Google Drive/블랙홀")).is_err());
        assert!(check_inbox_root(Path::new("relative/블랙홀")).is_err());
        assert!(check_inbox_root(Path::new("/Users/me/Library/Application Support/x/시험-블랙홀")).is_ok());
    }

    #[test]
    fn due_alarms_are_taken_once() {
        let mut list = vec![
            AlarmSpec { key: "a".into(), at_ms: 100, title: "A".into() },
            AlarmSpec { key: "b".into(), at_ms: 300, title: "B".into() },
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
            {"jobId": "job-4", "sourceSha256": "d", "sourcePath": "/x/d.png", "sourceText": "", "engine": "A", "state": "FAILED", "attempts": 3, "lastError": {"code": "RUNNER_UNAVAILABLE", "message": "꺼짐"}, "proposal": null, "createdAt": "", "updatedAt": ""}
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
    }
}
