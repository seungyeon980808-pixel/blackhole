//! 블랙홀 폴더 처리: `인박스/`에 들어온 파일마다 원본 사본을 `원본/연/월/`에 남기고,
//! 대기열로 분석한 뒤 `노트/`에 옵시디언 원본 노트를 쓴다.
//!
//! The inbox is never emptied or rewritten: originals stay where they were put and a
//! copy is kept under `원본/`. The SHA-256 of the bytes decides whether a file was seen.
//! Failed analyses are retried on later scans, up to `MAX_ATTEMPTS`.

use super::{
    error::{ErrorCode, WorkerError},
    notes::{note_relative_path, render_note},
    pipeline::{source_type_for, Input},
    proposal::{EngineId, Proposal},
    queue::{Enqueued, JobState, Queue},
    source::sha256_hex,
};
use atomicwrites::{AllowOverwrite, AtomicFile};
use chrono::{DateTime, Datelike, FixedOffset};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const MAX_ATTEMPTS: u32 = 3;
/// Extension of phone action files in 인박스/ (read by the desktop app, skipped by the scanner).
pub const PHONE_ACTION_EXT: &str = "bhact";
/// Extension of the phone's own transcript beside a recording (read by the desktop app for a
/// quick draft, skipped by the scanner: the recording itself is analyzed).
pub const PHONE_STT_EXT: &str = "bhstt";

/// The 블랙홀 folder (e.g. on the synced Google Drive).
#[derive(Debug, Clone)]
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn inbox(&self) -> PathBuf {
        self.root.join("인박스")
    }
    pub fn originals(&self) -> PathBuf {
        self.root.join("원본")
    }
    pub fn notes(&self) -> PathBuf {
        self.root.join("노트")
    }
    /// Queue state. Dot folder, so Obsidian does not index it.
    pub fn state(&self) -> PathBuf {
        self.root.join(".블랙홀")
    }
    pub fn ensure(&self) -> Result<(), WorkerError> {
        for dir in [self.inbox(), self.originals(), self.notes(), self.state()] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Inbox file names queued for the first time on this scan.
    pub received: Vec<String>,
    /// Already-seen originals (same bytes) that were left alone.
    pub already_seen: usize,
    /// Files still being written or of an unsupported type, left for later.
    pub waiting: Vec<String>,
    pub unsupported: Vec<String>,
    /// Notes written on this scan, relative to the root.
    pub notes: Vec<String>,
    /// Inputs that failed this scan, with the reason.
    pub failed: Vec<FailedInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedInput {
    pub original: String,
    pub attempts: u32,
    pub error: WorkerError,
}

fn relative(root: &Path, path: &Path) -> String {
    let canonical = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    path.strip_prefix(root)
        .or_else(|_| path.strip_prefix(&canonical))
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

/// Copy kept as `원본/YYYY/MM/<sha8>-<file name>`; written once, never overwritten.
fn keep_original(layout: &Layout, from: &Path, sha: &str, received: DateTime<FixedOffset>) -> Result<PathBuf, WorkerError> {
    let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "input".into());
    let dir = layout.originals().join(format!("{:04}", received.year())).join(format!("{:02}", received.month()));
    fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{}-{name}", &sha[..8]));
    if !target.exists() {
        fs::copy(from, &target)?;
    }
    Ok(target)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), WorkerError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    AtomicFile::new(path, AllowOverwrite)
        .write(|f| f.write_all(text.as_bytes()))
        .map_err(|e| WorkerError::new(ErrorCode::Io, format!("노트를 쓰지 못했습니다: {e}")))
}

/// One pass over the inbox. `settle` skips files modified more recently than that (a
/// Drive upload still in progress). `analyze` is the same closure the CLI uses.
pub fn scan_once<F>(layout: &Layout, engine: EngineId, now: DateTime<FixedOffset>, settle: Duration, mut analyze: F) -> Result<ScanReport, WorkerError>
where
    F: FnMut(&Input, EngineId) -> Result<Proposal, WorkerError>,
{
    layout.ensure()?;
    let mut queue = Queue::open(&layout.state())?;
    let mut report = ScanReport::default();

    // 1. New files: keep a copy under 원본/ and queue the copy.
    let mut entries: Vec<PathBuf> = fs::read_dir(layout.inbox())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // Phone actions (확정·체크…) for the desktop app: not analyzed, never touched.
        if path.extension().is_some_and(|e| e == PHONE_ACTION_EXT || e == PHONE_STT_EXT) {
            continue;
        }
        if source_type_for(&path).is_err() {
            report.unsupported.push(name);
            continue;
        }
        let fresh = fs::metadata(&path)?
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_some_and(|age| age < settle);
        if fresh {
            report.waiting.push(name);
            continue;
        }
        let bytes = fs::read(&path)?;
        let sha = sha256_hex(&bytes);
        if queue.jobs().iter().any(|j| j.source_sha256 == sha) {
            report.already_seen += 1;
            continue;
        }
        let kept = keep_original(layout, &path, &sha, now)?;
        if let Enqueued::New(_) = queue.enqueue(&Input::File(&kept), engine)? {
            report.received.push(name);
        }
    }

    // 2. Earlier failures get another try, a few times at most.
    let retry: Vec<String> = queue
        .jobs()
        .iter()
        .filter(|j| j.state == JobState::Failed && j.attempts < MAX_ATTEMPTS)
        .map(|j| j.job_id.clone())
        .collect();
    for id in retry {
        queue.retry(&id)?;
    }

    // 3. Analyse.
    for job in queue.run_pending(|input, engine| analyze(input, engine))? {
        if job.state == JobState::Failed {
            if let Some(error) = job.last_error.clone() {
                report.failed.push(FailedInput { original: relative(&layout.root, Path::new(&job.source_path)), attempts: job.attempts, error });
            }
        }
    }

    // 4. A note for every result that does not have one yet.
    for job in queue.jobs().iter().filter(|j| j.state == JobState::HasResult) {
        let Some(proposal) = &job.proposal else { continue };
        let received = DateTime::parse_from_rfc3339(&job.created_at).unwrap_or(now);
        let original = Path::new(&job.source_path);
        let file_name = original.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let fallback = file_name.split_once('-').map(|(_, rest)| rest.to_string()).unwrap_or(file_name.clone());
        let rel = note_relative_path(proposal, received, &fallback);
        let path = layout.root.join(&rel);
        if path.exists() {
            continue;
        }
        let origin = format!("인박스 · {}", proposal.source.format);
        write_atomic(&path, &render_note(proposal, &relative(&layout.root, original), received, &origin))?;
        report.notes.push(rel.to_string_lossy().into_owned());
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::{
        pipeline::{analyze, fakes::*, Engines},
    };
    use serde_json::json;

    fn now() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-10-21T09:00:00+09:00").unwrap()
    }

    fn answer() -> String {
        json!({"summary":"상담과 보고서","items":[
            {"kind":"SCHEDULE","area":"SCHOOL","title":"학부모 상담","details":"","dateText":"내일","timeText":"오후 3시","endDateText":"","subtasks":[],"reminderText":"","evidence":"내일 오후 3시에 학부모 상담","confidence":0.9},
            {"kind":"TODO","area":"SCHOOL","title":"연수 보고서 제출","details":"","dateText":"금요일","timeText":"","endDateText":"","subtasks":["자료 정리","결재"],"reminderText":"","evidence":"금요일까지 연수 보고서 제출","confidence":0.9}]}).to_string()
    }

    const MEMO: &str = "내일 오후 3시에 학부모 상담. 금요일까지 연수 보고서 제출: 자료 정리, 결재";

    #[test]
    fn inbox_file_becomes_kept_original_and_note_once() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("블랙홀"));
        layout.ensure().unwrap();
        fs::write(layout.inbox().join("메모.txt"), MEMO).unwrap();
        let chat = FakeChat::new(vec![Ok(answer())]);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        let run = |l: &Layout| scan_once(l, EngineId::TextFirst, now(), Duration::ZERO, |i, e| analyze(i, e, now(), &engines)).unwrap();

        let first = run(&layout);
        assert_eq!(first.received, vec!["메모.txt"]);
        assert_eq!(first.notes.len(), 1, "{first:?}");
        let note = fs::read_to_string(layout.root.join(&first.notes[0])).unwrap();
        assert!(note.contains("**학부모 상담**") && note.contains("    - [ ] 자료 정리"), "{note}");
        assert!(first.notes[0].starts_with("노트/학교/") && first.notes[0].contains(" 학부모 상담 ("), "{}", first.notes[0]);
        let kept: Vec<_> = fs::read_dir(layout.originals().join("2026").join("10")).unwrap().collect();
        assert_eq!(kept.len(), 1);
        // The inbox original is left exactly as it was.
        assert_eq!(fs::read_to_string(layout.inbox().join("메모.txt")).unwrap(), MEMO);

        // Second scan: same bytes, nothing new, no second model call, no duplicate note.
        let second = run(&layout);
        assert_eq!(second.already_seen, 1);
        assert!(second.received.is_empty() && second.notes.is_empty());
        assert_eq!(*chat.calls.borrow(), 1);
    }

    #[test]
    fn failure_is_retried_on_later_scans_then_noted() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        layout.ensure().unwrap();
        fs::write(layout.inbox().join("a.txt"), MEMO).unwrap();
        let chat = FakeChat::new(vec![Err(WorkerError::new(ErrorCode::RunnerUnavailable, "down")), Ok(answer())]);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        let run = || scan_once(&layout, EngineId::TextFirst, now(), Duration::ZERO, |i, e| analyze(i, e, now(), &engines)).unwrap();

        let first = run();
        assert_eq!(first.failed.len(), 1);
        assert_eq!(first.failed[0].error.code, ErrorCode::RunnerUnavailable);
        assert!(first.notes.is_empty());
        let second = run();
        assert!(second.failed.is_empty());
        assert_eq!(second.notes.len(), 1);
    }

    #[test]
    fn retries_stop_after_max_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        layout.ensure().unwrap();
        fs::write(layout.inbox().join("a.txt"), MEMO).unwrap();
        let chat = FakeChat::new(vec![]); // always fails
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        for _ in 0..5 {
            scan_once(&layout, EngineId::TextFirst, now(), Duration::ZERO, |i, e| analyze(i, e, now(), &engines)).unwrap();
        }
        assert_eq!(*chat.calls.borrow(), MAX_ATTEMPTS as usize);
    }

    #[test]
    fn hidden_unsupported_and_still_uploading_files_wait() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        layout.ensure().unwrap();
        fs::write(layout.inbox().join(".DS_Store"), "x").unwrap();
        fs::write(layout.inbox().join("setup.exe"), "x").unwrap();
        fs::write(layout.inbox().join("new.txt"), MEMO).unwrap();
        let chat = FakeChat::new(vec![]);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        let report = scan_once(&layout, EngineId::TextFirst, now(), Duration::from_secs(60), |i, e| analyze(i, e, now(), &engines)).unwrap();
        assert_eq!(report.unsupported, vec!["setup.exe"]);
        assert_eq!(report.waiting, vec!["new.txt"]);
        assert!(report.received.is_empty());
        assert_eq!(*chat.calls.borrow(), 0);
    }
}
