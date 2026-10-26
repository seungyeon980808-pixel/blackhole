//! `blackhole-worker`: run the local analysis worker without the desktop app.
//!
//! blackhole-worker analyze (--file PATH | --text TEXT) [--engine A|B] [--now ISO8601]
//! blackhole-worker enqueue --queue DIR (--file PATH | --text TEXT) [--engine A|B]
//! blackhole-worker run     --queue DIR [--now ISO8601]
//! blackhole-worker retry   --queue DIR JOB_ID
//! blackhole-worker list    --queue DIR
//!
//! JSON goes to stdout. Failures print a JSON error to stderr and exit with 2.

use chrono::{DateTime, FixedOffset};
use serde_json::json;
use std::{path::PathBuf, process::ExitCode};
use blackhole_desktop_lib::worker::{
    config::WorkerConfig,
    error::{ErrorCode, WorkerError},
    pipeline::Input,
    proposal::EngineId,
    inbox::{scan_once, Layout},
    messenger::{poll, MessengerConfig},
    queue::{Enqueued, Queue},
};

const USAGE: &str = "사용법:
  blackhole-worker analyze (--file 경로 | --text 문장) [--engine A|B] [--now 2026-10-21T09:00:00+09:00]
  blackhole-worker enqueue --queue 폴더 (--file 경로 | --text 문장) [--engine A|B]
  blackhole-worker run     --queue 폴더 [--now ISO8601]
  blackhole-worker retry   --queue 폴더 작업ID
  blackhole-worker list    --queue 폴더
  blackhole-worker inbox   --root 블랙홀폴더 [--engine A|B] [--watch 초] [--settle 초]
  blackhole-worker messenger --root 블랙홀폴더 [--watch 초]   (디스코드·슬랙 → 인박스, ~/.config/blackhole/messenger.json)
환경 변수: BLACKHOLE_OLLAMA_URL, BLACKHOLE_TEXT_MODEL, BLACKHOLE_DIRECT_MODEL, BLACKHOLE_WHISPER_BIN, BLACKHOLE_WHISPER_MODEL, BLACKHOLE_KORDOC_BIN, BLACKHOLE_MODELS_DIR,
  BLACKHOLE_WORKER_CONFIG(설정 파일, off), BLACKHOLE_DOCUMENT_MODEL, BLACKHOLE_FILL_MISSING, BLACKHOLE_RECHECK_BELOW, BLACKHOLE_IMAGE_OCR_HINT, BLACKHOLE_WHISPER_PROMPT, BLACKHOLE_WORD_LISTS=off";

#[derive(Default)]
struct Args {
    command: String,
    file: Option<PathBuf>,
    text: Option<String>,
    engine: Option<String>,
    now: Option<String>,
    queue: Option<PathBuf>,
    root: Option<PathBuf>,
    watch: Option<u64>,
    settle: Option<u64>,
    positional: Vec<String>,
}

fn usage_error(message: impl Into<String>) -> WorkerError {
    WorkerError::new(ErrorCode::UnsupportedInput, format!("{}\n{USAGE}", message.into()))
}

fn parse_args() -> Result<Args, WorkerError> {
    let mut iter = std::env::args().skip(1);
    let mut args = Args { command: iter.next().unwrap_or_default(), ..Args::default() };
    while let Some(arg) = iter.next() {
        let mut value = || iter.next().ok_or_else(|| usage_error(format!("{arg} 뒤에 값이 필요합니다.")));
        match arg.as_str() {
            "--file" => args.file = Some(PathBuf::from(value()?)),
            "--text" => args.text = Some(value()?),
            "--engine" => args.engine = Some(value()?),
            "--now" => args.now = Some(value()?),
            "--queue" => args.queue = Some(PathBuf::from(value()?)),
            "--root" => args.root = Some(PathBuf::from(value()?)),
            "--watch" => args.watch = Some(value()?.parse().map_err(|_| usage_error("--watch는 초 단위 숫자입니다."))?),
            "--settle" => args.settle = Some(value()?.parse().map_err(|_| usage_error("--settle은 초 단위 숫자입니다."))?),
            other if other.starts_with("--") => return Err(usage_error(format!("모르는 옵션: {other}"))),
            other => args.positional.push(other.to_string()),
        }
    }
    Ok(args)
}

fn engine(args: &Args) -> Result<EngineId, WorkerError> {
    match args.engine.as_deref().unwrap_or("A") {
        "A" | "a" => Ok(EngineId::TextFirst),
        "B" | "b" => Ok(EngineId::Direct),
        other => Err(usage_error(format!("엔진은 A 또는 B입니다: {other}"))),
    }
}

fn reference(args: &Args) -> Result<DateTime<FixedOffset>, WorkerError> {
    match &args.now {
        Some(now) => DateTime::parse_from_rfc3339(now).map_err(|e| usage_error(format!("--now 형식 오류({now}): {e}"))),
        None => Ok(chrono::Local::now().fixed_offset()),
    }
}

fn input(args: &Args) -> Result<Input<'_>, WorkerError> {
    match (&args.file, &args.text) {
        (Some(path), None) => Ok(Input::File(path)),
        (None, Some(text)) => Ok(Input::Text(text)),
        _ => Err(usage_error("--file과 --text 중 하나만 주세요.")),
    }
}

fn queue_dir(args: &Args) -> Result<&PathBuf, WorkerError> {
    args.queue.as_ref().ok_or_else(|| usage_error("--queue 폴더가 필요합니다."))
}

fn run() -> Result<serde_json::Value, WorkerError> {
    let args = parse_args()?;
    let config = WorkerConfig::from_env()?;
    // Claude by default; BLACKHOLE_ANALYZER=local (or "analyzer": "local") for whisper + Ollama.
    let inbox = args.root.as_ref().map(|r| r.join("인박스"));
    let analyze_one = |input: &Input, engine: EngineId, reference: DateTime<FixedOffset>| config.analyze(input, engine, reference, inbox.as_deref());

    match args.command.as_str() {
        "analyze" => Ok(to_json(&analyze_one(&input(&args)?, engine(&args)?, reference(&args)?)?)),
        "enqueue" => {
            let mut queue = Queue::open(queue_dir(&args)?)?;
            Ok(match queue.enqueue(&input(&args)?, engine(&args)?)? {
                Enqueued::New(job) => json!({"result": "new", "job": to_json(&job)}),
                Enqueued::Duplicate(job) => json!({"result": "duplicate", "job": to_json(&job)}),
            })
        }
        "run" => {
            let reference = reference(&args)?;
            let mut queue = Queue::open(queue_dir(&args)?)?;
            let done = queue.run_pending(|input, engine| analyze_one(input, engine, reference))?;
            Ok(to_json(&done))
        }
        "retry" => {
            let id = args.positional.first().ok_or_else(|| usage_error("작업ID가 필요합니다."))?;
            let mut queue = Queue::open(queue_dir(&args)?)?;
            Ok(to_json(&queue.retry(id)?))
        }
        "list" => Ok(to_json(&Queue::open(queue_dir(&args)?)?.jobs().to_vec())),
        "inbox" => {
            let root = args.root.as_ref().ok_or_else(|| usage_error("--root 블랙홀 폴더가 필요합니다."))?;
            let layout = Layout::new(root);
            let engine = engine(&args)?;
            let settle = std::time::Duration::from_secs(args.settle.unwrap_or(5));
            loop {
                let now = reference(&args)?;
                let report = scan_once(&layout, engine, now, settle, |input, engine| analyze_one(input, engine, now))?;
                let Some(seconds) = args.watch else { return Ok(to_json(&report)) };
                if !report.received.is_empty() || !report.notes.is_empty() || !report.failed.is_empty() {
                    println!("{}", serde_json::to_string(&report).unwrap_or_default());
                }
                std::thread::sleep(std::time::Duration::from_secs(seconds.max(1)));
            }
        }
        "messenger" => {
            let root = args.root.as_ref().ok_or_else(|| usage_error("--root 블랙홀 폴더가 필요합니다."))?;
            let config = MessengerConfig::load()?
                .ok_or_else(|| WorkerError::new(ErrorCode::Io, format!("메신저 설정 파일이 없습니다: {}", MessengerConfig::path().display())))?;
            loop {
                let report = poll(root, &config)?;
                let Some(seconds) = args.watch else { return Ok(to_json(&report)) };
                if !report.written.is_empty() || !report.errors.is_empty() {
                    println!("{}", serde_json::to_string(&report).unwrap_or_default());
                }
                std::thread::sleep(std::time::Duration::from_secs(seconds.max(10)));
            }
        }
        _ => Err(usage_error("명령을 고르세요.")),
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}", serde_json::to_string_pretty(&json!({"error": error})).unwrap_or_default());
            ExitCode::from(2)
        }
    }
}
