//! `ya-worker`: run the local analysis worker without the desktop app.
//!
//! ya-worker analyze (--file PATH | --text TEXT) [--engine A|B] [--now ISO8601]
//! ya-worker enqueue --queue DIR (--file PATH | --text TEXT) [--engine A|B]
//! ya-worker run     --queue DIR [--now ISO8601]
//! ya-worker retry   --queue DIR JOB_ID
//! ya-worker list    --queue DIR
//!
//! JSON goes to stdout. Failures print a JSON error to stderr and exit with 2.

use chrono::{DateTime, FixedOffset};
use serde_json::json;
use std::{path::PathBuf, process::ExitCode};
use ya_desktop_lib::worker::{
    config::WorkerConfig,
    error::{ErrorCode, WorkerError},
    pipeline::{analyze, Engines, Input},
    proposal::EngineId,
    queue::{Enqueued, Queue},
};

const USAGE: &str = "사용법:
  ya-worker analyze (--file 경로 | --text 문장) [--engine A|B] [--now 2026-10-21T09:00:00+09:00]
  ya-worker enqueue --queue 폴더 (--file 경로 | --text 문장) [--engine A|B]
  ya-worker run     --queue 폴더 [--now ISO8601]
  ya-worker retry   --queue 폴더 작업ID
  ya-worker list    --queue 폴더
환경 변수: YA_OLLAMA_URL, YA_TEXT_MODEL, YA_DIRECT_MODEL, YA_WHISPER_BIN, YA_WHISPER_MODEL, YA_KORDOC_BIN, YA_MODELS_DIR";

#[derive(Default)]
struct Args {
    command: String,
    file: Option<PathBuf>,
    text: Option<String>,
    engine: Option<String>,
    now: Option<String>,
    queue: Option<PathBuf>,
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
    let config = WorkerConfig::from_env();
    let (whisper, kordoc, text_chat, direct_chat) = (config.whisper(), config.kordoc(), config.text_chat(), config.direct_chat());
    let engines = Engines { transcriber: &whisper, reader: &kordoc, text_model: &text_chat, direct_model: &direct_chat };

    match args.command.as_str() {
        "analyze" => Ok(to_json(&analyze(&input(&args)?, engine(&args)?, reference(&args)?, &engines)?)),
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
            let done = queue.run_pending(|input, engine| analyze(input, engine, reference, &engines))?;
            Ok(to_json(&done))
        }
        "retry" => {
            let id = args.positional.first().ok_or_else(|| usage_error("작업ID가 필요합니다."))?;
            let mut queue = Queue::open(queue_dir(&args)?)?;
            Ok(to_json(&queue.retry(id)?))
        }
        "list" => Ok(to_json(&Queue::open(queue_dir(&args)?)?.jobs().to_vec())),
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
