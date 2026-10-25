//! Durable job queue: 받음(RECEIVED) → 분석 중(ANALYZING) → 결과 있음(HAS_RESULT) / 실패(FAILED).
//!
//! Stored as one JSON file written atomically. Jobs only point at originals;
//! the queue never copies, moves or deletes them, and never deletes a job.
//! A job is keyed by the SHA-256 of its original, so the same input is not analysed twice.

use super::{
    error::{ErrorCode, WorkerError},
    pipeline::{input_hash, Input},
    proposal::{EngineId, Proposal},
};
use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const QUEUE_SCHEMA_VERSION: u32 = 1;
const QUEUE_FILE: &str = "jobs-v1.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobState {
    Received,
    Analyzing,
    HasResult,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// "job-" + first 16 hex chars of the original's SHA-256.
    pub job_id: String,
    pub source_sha256: String,
    /// Absolute path of a file original, or "" for inline text.
    pub source_path: String,
    /// Inline text input, kept so text jobs can be retried. Empty for files.
    pub source_text: String,
    pub engine: EngineId,
    pub state: JobState,
    pub attempts: u32,
    pub last_error: Option<WorkerError>,
    pub proposal: Option<Proposal>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueFile {
    schema_version: u32,
    jobs: Vec<Job>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Enqueued {
    New(Job),
    /// Same original already queued; nothing new was created.
    Duplicate(Job),
}

pub struct Queue {
    dir: PathBuf,
    jobs: Vec<Job>,
}

fn now() -> String {
    chrono::Local::now().fixed_offset().to_rfc3339()
}

impl Queue {
    /// Opens (or creates) the queue. Jobs left ANALYZING by a crash become FAILED/INTERRUPTED so they can be retried.
    pub fn open(dir: &Path) -> Result<Self, WorkerError> {
        fs::create_dir_all(dir)?;
        let path = dir.join(QUEUE_FILE);
        let mut jobs = if path.exists() {
            let file: QueueFile = serde_json::from_slice(&fs::read(&path)?)
                .map_err(|e| WorkerError::new(ErrorCode::Io, format!("대기열 파일을 읽을 수 없습니다: {e}")))?;
            if file.schema_version != QUEUE_SCHEMA_VERSION {
                return Err(WorkerError::new(ErrorCode::Io, format!("모르는 대기열 버전: {}", file.schema_version)));
            }
            file.jobs
        } else {
            Vec::new()
        };
        let mut recovered = false;
        for job in jobs.iter_mut().filter(|j| j.state == JobState::Analyzing) {
            job.state = JobState::Failed;
            job.last_error = Some(WorkerError::new(ErrorCode::Interrupted, "분석 도중 작업기가 멈췄습니다. 다시 시도할 수 있습니다."));
            job.updated_at = now();
            recovered = true;
        }
        let queue = Self { dir: dir.to_path_buf(), jobs };
        if recovered {
            queue.save()?;
        }
        Ok(queue)
    }

    fn save(&self) -> Result<(), WorkerError> {
        let bytes = serde_json::to_vec_pretty(&QueueFile { schema_version: QUEUE_SCHEMA_VERSION, jobs: self.jobs.clone() })
            .map_err(|e| WorkerError::new(ErrorCode::Io, e.to_string()))?;
        AtomicFile::new(self.dir.join(QUEUE_FILE), AllowOverwrite)
            .write(|file| {
                file.write_all(&bytes)?;
                file.sync_all()
            })
            .map_err(|e| WorkerError::new(ErrorCode::Io, format!("대기열 저장 실패: {e}")))
    }

    pub fn jobs(&self) -> &[Job] {
        &self.jobs
    }

    pub fn get(&self, job_id: &str) -> Option<&Job> {
        self.jobs.iter().find(|j| j.job_id == job_id)
    }

    pub fn enqueue(&mut self, input: &Input, engine: EngineId) -> Result<Enqueued, WorkerError> {
        let (sha, _) = input_hash(input)?;
        if let Some(existing) = self.jobs.iter().find(|j| j.source_sha256 == sha) {
            return Ok(Enqueued::Duplicate(existing.clone()));
        }
        let (source_path, source_text) = match input {
            Input::File(path) => (fs::canonicalize(path)?.to_string_lossy().into_owned(), String::new()),
            Input::Text(text) => (String::new(), text.to_string()),
        };
        let stamp = now();
        let job = Job {
            job_id: format!("job-{}", &sha[..16]),
            source_sha256: sha,
            source_path,
            source_text,
            engine,
            state: JobState::Received,
            attempts: 0,
            last_error: None,
            proposal: None,
            created_at: stamp.clone(),
            updated_at: stamp,
        };
        self.jobs.push(job.clone());
        self.save()?;
        Ok(Enqueued::New(job))
    }

    /// Moves a FAILED job back to RECEIVED. Other states are left alone.
    pub fn retry(&mut self, job_id: &str) -> Result<Job, WorkerError> {
        let job = self
            .jobs
            .iter_mut()
            .find(|j| j.job_id == job_id)
            .ok_or_else(|| WorkerError::new(ErrorCode::InputMissing, format!("작업이 없습니다: {job_id}")))?;
        if job.state != JobState::Failed {
            return Err(WorkerError::new(ErrorCode::Io, format!("실패한 작업만 다시 시도할 수 있습니다(현재 {:?}).", job.state)));
        }
        job.state = JobState::Received;
        job.updated_at = now();
        let job = job.clone();
        self.save()?;
        Ok(job)
    }

    /// Analyses every RECEIVED job with `analyze`. The state is saved before and after each job.
    pub fn run_pending<F>(&mut self, mut analyze: F) -> Result<Vec<Job>, WorkerError>
    where
        F: FnMut(&Input, EngineId) -> Result<Proposal, WorkerError>,
    {
        let mut processed = Vec::new();
        let pending: Vec<usize> = (0..self.jobs.len()).filter(|&i| self.jobs[i].state == JobState::Received).collect();
        for index in pending {
            self.jobs[index].state = JobState::Analyzing;
            self.jobs[index].attempts += 1;
            self.jobs[index].updated_at = now();
            self.save()?;

            let job = self.jobs[index].clone();
            let result = if job.source_path.is_empty() {
                analyze(&Input::Text(&job.source_text), job.engine)
            } else {
                let path = PathBuf::from(&job.source_path);
                // The original must still be the same bytes we queued.
                match input_hash(&Input::File(&path)) {
                    Ok((sha, _)) if sha != job.source_sha256 => {
                        Err(WorkerError::new(ErrorCode::InputChanged, "대기열에 넣은 뒤 원본 파일 내용이 바뀌었습니다."))
                    }
                    Ok(_) => analyze(&Input::File(&path), job.engine),
                    Err(error) => Err(error),
                }
            };

            let job = &mut self.jobs[index];
            match result {
                Ok(proposal) => {
                    job.state = JobState::HasResult;
                    job.proposal = Some(proposal);
                    job.last_error = None;
                }
                Err(error) => {
                    job.state = JobState::Failed;
                    job.last_error = Some(error);
                }
            }
            job.updated_at = now();
            processed.push(job.clone());
            self.save()?;
        }
        Ok(processed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::proposal::{EngineInfo, ProposalSource, SourceType, Timings};

    fn proposal() -> Proposal {
        Proposal {
            schema_version: 1,
            source: ProposalSource { source_type: SourceType::Text, format: "txt".into(), sha256: "x".into(), bytes: 1 },
            reference_time: "2026-10-21T09:00:00+09:00".into(),
            engine: EngineInfo { id: EngineId::TextFirst, reader: String::new(), llm_model: "fake".into(), prompt_version: "p".into(), worker_version: "w".into() },
            source_text: "가".into(),
            summary: String::new(),
            items: vec![],
            needs_review: true,
            review_reasons: vec![],
            timings: Timings::default(),
        }
    }

    #[test]
    fn duplicate_input_is_not_queued_twice() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("a.wav");
        std::fs::write(&wav, b"same bytes").unwrap();
        let copy = dir.path().join("copy-of-a.wav");
        std::fs::write(&copy, b"same bytes").unwrap();

        let mut queue = Queue::open(&dir.path().join("q")).unwrap();
        assert!(matches!(queue.enqueue(&Input::File(&wav), EngineId::TextFirst).unwrap(), Enqueued::New(_)));
        assert!(matches!(queue.enqueue(&Input::File(&wav), EngineId::TextFirst).unwrap(), Enqueued::Duplicate(_)));
        // Same bytes under another name is the same original.
        assert!(matches!(queue.enqueue(&Input::File(&copy), EngineId::Direct).unwrap(), Enqueued::Duplicate(_)));
        assert!(matches!(queue.enqueue(&Input::Text("내일 회의"), EngineId::TextFirst).unwrap(), Enqueued::New(_)));
        assert!(matches!(queue.enqueue(&Input::Text("내일 회의"), EngineId::TextFirst).unwrap(), Enqueued::Duplicate(_)));
        assert_eq!(queue.jobs().len(), 2);

        // Persisted across reopen; a finished job is not analysed again.
        let mut calls = 0;
        queue.run_pending(|_, _| { calls += 1; Ok(proposal()) }).unwrap();
        let mut reopened = Queue::open(&dir.path().join("q")).unwrap();
        assert!(matches!(reopened.enqueue(&Input::File(&wav), EngineId::TextFirst).unwrap(), Enqueued::Duplicate(_)));
        reopened.run_pending(|_, _| { calls += 1; Ok(proposal()) }).unwrap();
        assert_eq!(calls, 2);
    }

    #[test]
    fn failure_then_retry_keeps_original() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("a.wav");
        std::fs::write(&wav, b"original bytes").unwrap();
        let mut queue = Queue::open(&dir.path().join("q")).unwrap();
        let Enqueued::New(job) = queue.enqueue(&Input::File(&wav), EngineId::TextFirst).unwrap() else { panic!() };

        let done = queue.run_pending(|_, _| Err(WorkerError::new(ErrorCode::RunnerUnavailable, "down"))).unwrap();
        assert_eq!(done[0].state, JobState::Failed);
        assert_eq!(done[0].last_error.as_ref().unwrap().code, ErrorCode::RunnerUnavailable);
        assert!(wav.exists());

        // Only failed jobs can be retried, and retry goes back to RECEIVED.
        let retried = queue.retry(&job.job_id).unwrap();
        assert_eq!(retried.state, JobState::Received);
        let done = queue.run_pending(|_, _| Ok(proposal())).unwrap();
        assert_eq!(done[0].state, JobState::HasResult);
        assert_eq!(done[0].attempts, 2);
        assert!(done[0].last_error.is_none());
        assert!(queue.retry(&job.job_id).is_err());
        assert_eq!(std::fs::read(&wav).unwrap(), b"original bytes");
    }

    #[test]
    fn missing_or_changed_original_fails_without_analysis() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("a.wav");
        std::fs::write(&wav, b"v1").unwrap();
        let mut queue = Queue::open(&dir.path().join("q")).unwrap();
        queue.enqueue(&Input::File(&wav), EngineId::TextFirst).unwrap();
        std::fs::write(&wav, b"v2").unwrap();
        let mut calls = 0;
        let done = queue.run_pending(|_, _| { calls += 1; Ok(proposal()) }).unwrap();
        assert_eq!(done[0].last_error.as_ref().unwrap().code, ErrorCode::InputChanged);
        assert_eq!(calls, 0);
        assert_eq!(std::fs::read(&wav).unwrap(), b"v2", "worker never rewrites originals");
    }

    #[test]
    fn interrupted_analysis_becomes_retryable_failure() {
        let dir = tempfile::tempdir().unwrap();
        let qdir = dir.path().join("q");
        {
            let mut queue = Queue::open(&qdir).unwrap();
            queue.enqueue(&Input::Text("모레 병원"), EngineId::TextFirst).unwrap();
            queue.jobs[0].state = JobState::Analyzing;
            queue.save().unwrap();
        }
        let mut queue = Queue::open(&qdir).unwrap();
        assert_eq!(queue.jobs()[0].state, JobState::Failed);
        assert_eq!(queue.jobs()[0].last_error.as_ref().unwrap().code, ErrorCode::Interrupted);
        let id = queue.jobs()[0].job_id.clone();
        assert_eq!(queue.retry(&id).unwrap().state, JobState::Received);
    }

    #[test]
    fn missing_original_cannot_be_enqueued() {
        let dir = tempfile::tempdir().unwrap();
        let mut queue = Queue::open(dir.path()).unwrap();
        let err = queue.enqueue(&Input::File(&dir.path().join("gone.wav")), EngineId::TextFirst).unwrap_err();
        assert_eq!(err.code, ErrorCode::InputMissing);
    }
}
