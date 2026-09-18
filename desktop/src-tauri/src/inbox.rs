use serde::Serialize;
use std::{
    env, fs,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const DRIVE_PREFIX: &str = "GoogleDrive-";
const DRIVE_RELATIVE: [&str; 3] = ["내 드라이브", "1. 개인작업", "Inbox"];
const MAX_MESSAGE_CHARS: usize = 20_000;

#[derive(Serialize)]
pub struct InboxStatus {
    pub state: &'static str,
    pub path: Option<String>,
    pub detail: String,
}

#[derive(Serialize)]
pub struct InboxCaptureResult {
    pub filename: String,
}

fn configured_inbox() -> Result<Option<PathBuf>, String> {
    let Some(value) = env::var_os("YA_INBOX_PATH") else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if path.is_dir() {
        Ok(Some(path))
    } else {
        Err(format!(
            "YA_INBOX_PATH가 폴더가 아닙니다: {}",
            path.display()
        ))
    }
}

fn resolve_inbox() -> Result<PathBuf, String> {
    if let Some(path) = configured_inbox()? {
        return Ok(path);
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "사용자 홈 폴더를 찾을 수 없습니다.".to_owned())?;
    let cloud_storage = home.join("Library").join("CloudStorage");
    let entries = fs::read_dir(&cloud_storage)
        .map_err(|error| format!("Google Drive 동기화 폴더를 읽을 수 없습니다: {error}"))?;
    let mut matches = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Drive 폴더 항목을 읽을 수 없습니다: {error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(DRIVE_PREFIX) {
            let candidate = DRIVE_RELATIVE
                .iter()
                .fold(entry.path(), |path, part| path.join(part));
            if candidate.is_dir() {
                matches.push(candidate);
            }
        }
    }
    match matches.as_slice() {
        [path] => Ok(path.clone()),
        [] => Err("Google Drive의 1. 개인작업/Inbox 폴더를 찾을 수 없습니다.".to_owned()),
        _ => {
            Err("Google Drive 인박스 후보가 여러 개입니다. YA_INBOX_PATH를 지정하세요.".to_owned())
        }
    }
}

fn capture_message_at(root: &Path, message: &str) -> Result<InboxCaptureResult, String> {
    let content = message.trim();
    if content.is_empty() {
        return Err("저장할 내용을 입력하세요.".to_owned());
    }
    if content.chars().count() > MAX_MESSAGE_CHARS {
        return Err(format!("기록은 {MAX_MESSAGE_CHARS}자 이내여야 합니다."));
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("Inbox 폴더를 준비할 수 없습니다: {error}"))?;
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("시각을 만들 수 없습니다: {error}"))?;
    let filename = format!(
        "ya-capture-{}-{}.md",
        elapsed.as_millis(),
        std::process::id()
    );
    let temporary = root.join(format!(".{filename}.tmp"));
    let destination = root.join(&filename);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("임시 기록 파일을 만들 수 없습니다: {error}"))?;
    let body = format!(
        "---\nsource: ya-desktop\ncaptured_at_epoch_ms: {}\nstatus: raw\n---\n\n{content}\n",
        elapsed.as_millis()
    );
    write_and_sync(&mut file, body.as_bytes())?;
    drop(file);
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Inbox 기록을 완료할 수 없습니다: {error}"))?;
    Ok(InboxCaptureResult { filename })
}

fn write_and_sync(file: &mut File, content: &[u8]) -> Result<(), String> {
    file.write_all(content)
        .map_err(|error| format!("기록 파일을 쓸 수 없습니다: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("기록 파일을 저장할 수 없습니다: {error}"))
}

#[tauri::command]
pub fn get_inbox_status() -> InboxStatus {
    match resolve_inbox() {
        Ok(path) => InboxStatus {
            state: "connected",
            path: Some(path.display().to_string()),
            detail: "Google Drive 동기화 Inbox에 저장합니다.".to_owned(),
        },
        Err(detail) => InboxStatus {
            state: "unavailable",
            path: None,
            detail,
        },
    }
}

#[tauri::command]
pub fn capture_inbox_message(message: String) -> Result<InboxCaptureResult, String> {
    let root = resolve_inbox()?;
    capture_message_at(&root, &message)
}

#[cfg(test)]
mod tests {
    use super::{capture_message_at, MAX_MESSAGE_CHARS};
    use tempfile::tempdir;

    #[test]
    fn capture_message_writes_markdown_with_raw_status() {
        let directory = tempdir().expect("temporary directory");
        let result = capture_message_at(directory.path(), "회의 메모").expect("capture succeeds");
        let body =
            std::fs::read_to_string(directory.path().join(result.filename)).expect("read capture");
        assert!(body.contains("source: ya-desktop"));
        assert!(body.contains("status: raw"));
        assert!(body.ends_with("회의 메모\n"));
    }

    #[test]
    fn capture_message_rejects_empty_and_oversized_input() {
        let directory = tempdir().expect("temporary directory");
        assert!(capture_message_at(directory.path(), " \n").is_err());
        let oversized = "가".repeat(MAX_MESSAGE_CHARS + 1);
        assert!(capture_message_at(directory.path(), &oversized).is_err());
    }
}
