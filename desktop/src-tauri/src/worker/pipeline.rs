//! One input in, one proposal out. Reads the original, never modifies it.

use super::{
    error::{ErrorCode, WorkerError},
    extract::{chunk_text, direct_messages_with, looks_invented, output_schema, recheck_messages, text_messages_with, validate_with, ExtractOptions, Extraction},
    proposal::{EngineId, EngineInfo, Proposal, ProposalItem, ProposalSource, SourceType, Timings, PROMPT_VERSION, PROPOSAL_SCHEMA_VERSION, WORKER_VERSION},
    runners::{ChatModel, DocumentReader, Transcriber},
    runners::split_words,
    source::{inspect_wav, read_original, sha256_hex, WavInfo},
};
use chrono::{DateTime, FixedOffset};
use std::{path::Path, time::Instant};

/// Document chunks sent to the LLM per call.
const CHUNK_CHARS: usize = 2_400;
/// A very long text (a pasted book, a log) is read only up to here: at most ~10 model calls.
pub const MAX_TEXT_CHARS: usize = 24_000;
pub const TOO_LONG_REASON: &str = "글이 아주 길어 앞부분(약 2만 4천 자)만 읽었어요 · 필요한 부분만 나눠 넣어 주세요";
/// Recordings shorter than this, or quieter than WEAK_RMS, make no items (only a review
/// note): whisper turns near-silence into the hint words (2026-10-25, real 0.6 s memo).
pub const MIN_SPEECH_MS: u64 = 1_000;
pub const WEAK_RMS: f64 = 300.0;
/// Below this length the recognizer gets no vocabulary hint.
pub const HINT_MIN_MS: u64 = 3_000;
pub const WEAK_AUDIO_REASON: &str = "음성이 너무 짧거나 약함";
pub const HINT_ONLY_REASON: &str = "받아쓴 글이 힌트 낱말뿐이라 지어낸 것으로 봄";
pub const TOO_SHORT_REASON: &str = "내용이 너무 짧아 AI를 부르지 않음";

/// Fewer than two letters or digits: not worth a model call.
pub fn too_short(text: &str) -> bool {
    text.chars().filter(|c| c.is_alphanumeric()).count() < 2
}

fn weak_audio(info: &WavInfo) -> bool {
    info.duration_ms < MIN_SPEECH_MS || info.rms < WEAK_RMS
}

/// True when every word of the transcript is (a variant of) a hint word: the recognizer
/// repeated its prompt instead of hearing speech. "수행평회" counts as a variant of "수행평가".
pub fn only_hint_words(transcript: &str, hints: &[String]) -> bool {
    let words: Vec<String> = split_words(transcript)
        .into_iter()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() || hints.is_empty() {
        return false;
    }
    let prefix = |a: &str, b: &str| a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    words.iter().all(|w| {
        hints.iter().any(|h| h.contains(w.as_str()) || w.contains(h.as_str()) || prefix(w, h) >= 2)
    })
}

pub enum Input<'a> {
    File(&'a Path),
    Text(&'a str),
}

pub struct Engines<'a> {
    pub transcriber: &'a dyn Transcriber,
    pub reader: &'a dyn DocumentReader,
    /// Gemma text model for engine A.
    pub text_model: &'a dyn ChatModel,
    /// Multimodal Gemma (audio + image) for engine B.
    pub direct_model: &'a dyn ChatModel,
}

/// Accuracy switches (see docs/worker-eval-results.md). `Default` = stage-1 behaviour.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnalyzeOptions {
    pub extract: ExtractOptions,
    /// Ask the model once more when an item's confidence is below this, an item needs
    /// review, or nothing was found. The answer with fewer review reasons wins.
    pub recheck_below: Option<f64>,
    /// Engine B for images: also run OCR and give its text to the model as a hint.
    pub image_ocr_hint: bool,
    /// Claude analyzer: images and PDFs go to the model directly (image / document blocks);
    /// no OCR model is run.
    pub claude: bool,
}

fn review_count(extraction: &Extraction) -> usize {
    extraction.items.iter().map(|i| i.review_reasons.len()).sum::<usize>() + usize::from(extraction.items.is_empty())
}

/// One structured call, plus an optional self-check turn.
fn extract_once(
    model: &dyn ChatModel,
    messages: Vec<serde_json::Value>,
    with_transcript: bool,
    source_text: Option<&str>,
    reference: DateTime<FixedOffset>,
    options: &AnalyzeOptions,
) -> Result<Extraction, WorkerError> {
    let schema = output_schema(with_transcript);
    let raw = model.chat_json(messages.clone(), &schema)?;
    let first = validate_with(&raw, source_text, reference, &options.extract)?;
    let Some(threshold) = options.recheck_below else { return Ok(first) };
    let doubtful = first.items.is_empty() || first.items.iter().any(|i| i.needs_review || i.confidence < threshold);
    if !doubtful {
        return Ok(first);
    }
    // A failed second answer never replaces a valid first one.
    match model.chat_json(recheck_messages(messages, &raw), &schema).and_then(|raw2| validate_with(&raw2, source_text, reference, &options.extract)) {
        Ok(second) if review_count(&second) <= review_count(&first) => Ok(second),
        _ => Ok(first),
    }
}

pub fn source_type_for(path: &Path) -> Result<(SourceType, String), WorkerError> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind = match ext.as_str() {
        "wav" => SourceType::Audio,
        "txt" | "md" => SourceType::Text,
        "pdf" | "hwp" | "hwpx" | "hwpml" | "docx" | "xlsx" | "xls" => SourceType::Document,
        "png" | "jpg" | "jpeg" | "webp" => SourceType::Image,
        _ => {
            return Err(WorkerError::new(
                ErrorCode::UnsupportedInput,
                format!("지원하지 않는 파일 형식입니다: .{ext} (WAV, PDF, HWP, HWPX, DOCX, XLSX, PNG, JPG, WebP, TXT)"),
            ))
        }
    };
    Ok((kind, ext))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Hash of what will be analysed: file bytes, or the UTF-8 text.
pub fn input_hash(input: &Input) -> Result<(String, u64), WorkerError> {
    match input {
        Input::File(path) => {
            let bytes = read_original(path)?;
            Ok((sha256_hex(&bytes), bytes.len() as u64))
        }
        Input::Text(text) => Ok((sha256_hex(text.as_bytes()), text.len() as u64)),
    }
}

pub const RULE_ONLY_SUMMARY: &str = "규칙 초안 그대로(AI 생략)";

/// A job whose rule draft the app already took as final: no reading, no model call. The note
/// still gets the original text; the app sees no items and keeps its own entry.
pub fn rule_only_proposal(input: &Input, reference: DateTime<FixedOffset>) -> Result<Proposal, WorkerError> {
    let (source_type, format, bytes) = match input {
        Input::File(path) => {
            let (kind, ext) = source_type_for(path)?;
            (kind, ext, read_original(path)?)
        }
        Input::Text(text) => (SourceType::Text, "txt".to_string(), text.as_bytes().to_vec()),
    };
    let source_text = if source_type == SourceType::Text { decode_text(&bytes)? } else { String::new() };
    Ok(Proposal {
        schema_version: PROPOSAL_SCHEMA_VERSION,
        source: ProposalSource { source_type, format, sha256: sha256_hex(&bytes), bytes: bytes.len() as u64 },
        reference_time: reference.to_rfc3339(),
        engine: EngineInfo { id: EngineId::TextFirst, reader: String::new(), llm_model: "rules".into(), prompt_version: PROMPT_VERSION.to_string(), worker_version: WORKER_VERSION.to_string() },
        source_text,
        summary: RULE_ONLY_SUMMARY.into(),
        items: Vec::new(),
        needs_review: false,
        review_reasons: Vec::new(),
        timings: Timings::default(),
    })
}

pub fn analyze(input: &Input, engine: EngineId, reference: DateTime<FixedOffset>, engines: &Engines) -> Result<Proposal, WorkerError> {
    analyze_with(input, engine, reference, engines, &AnalyzeOptions::default())
}

/// 「상담 전에 성적표 출력」 「그 전에 학습지 인쇄」: a to-do with no day of its own, said to be done
/// before an appointment found in the same input, is due when that appointment starts.
pub fn before_the_event(mut items: Vec<ProposalItem>) -> Vec<ProposalItem> {
    let events: Vec<(String, String, String)> = items.iter().filter(|i| i.kind == "SCHEDULE" && !i.start_at.is_empty()).map(|i| (i.title.clone(), i.start_at.clone(), i.evidence.sentence.clone())).collect();
    let Some(first) = events.first().cloned() else { return items };
    for item in items.iter_mut().filter(|i| i.kind == "TODO" && i.start_at.is_empty()) {
        let said = format!("{} {}", item.evidence.sentence, item.title);
        if !(said.contains("전에") || said.contains("전까지") || said.contains("앞서") || said.contains("그 전")) {
            continue;
        }
        // The appointment named in its sentence, else the first one.
        let (title, start, _) = events.iter().find(|(t, _, _)| !t.is_empty() && said.contains(t.split_whitespace().last().unwrap_or(t))).cloned().unwrap_or(first.clone());
        item.start_at = start;
        item.needs_review = true;
        item.review_reasons.push(format!("「{title}」 전까지로 둠"));
    }
    items
}

/// The first bytes say what a file really is: a broken or renamed file is caught here, in Korean,
/// before it costs a model call (it used to come back as 「HTTP 400 (invalid_request_error)」).
pub const UNREADABLE_TEXT: &str = "글자가 깨진 텍스트 파일이에요(UTF-8·EUC-KR·UTF-16이 아님) · 메모장에서 「UTF-8」로 다시 저장해 넣어 주세요";

/// A .txt/.md as text: UTF-8 (with or without BOM), UTF-16 with BOM (Windows 메모장 「유니코드」), or
/// EUC-KR/CP949 (old 메모장 「ANSI」 on a Korean PC). Read before as UTF-8 only: the AI got 「11�� 5��」 and made
/// up 「상담회」 (2026-10-28 밤샘). Anything else is refused rather than sent garbled.
pub fn decode_text(bytes: &[u8]) -> Result<String, WorkerError> {
    let utf16 = |be: bool| {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) }).collect();
        String::from_utf16(&units).ok()
    };
    let text = if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        std::str::from_utf8(rest).ok().map(str::to_string)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        utf16(false)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        utf16(true)
    } else if let Ok(t) = std::str::from_utf8(bytes) {
        Some(t.to_string())
    } else {
        cp949(bytes)
    };
    text.ok_or_else(|| WorkerError::new(ErrorCode::UnsupportedInput, UNREADABLE_TEXT))
}

/// EUC-KR/CP949 through the system iconv (macOS has it; no extra crate). None when it is not that either.
fn cp949(bytes: &[u8]) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("iconv").args(["-f", "CP949", "-t", "UTF-8"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let data = bytes.to_vec();
    // Written from another thread: a large file would otherwise fill the pipe both ways.
    let writer = std::thread::spawn(move || stdin.write_all(&data));
    let out = child.wait_with_output().ok()?;
    let _ = writer.join();
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

pub fn check_file_bytes(ext: &str, bytes: &[u8]) -> Result<(), WorkerError> {
    let ok = match ext {
        "pdf" => bytes.starts_with(b"%PDF"),
        "png" => bytes.starts_with(b"\x89PNG"),
        "jpg" | "jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]) && bytes.len() >= 100 && bytes[bytes.len().saturating_sub(4096)..].windows(2).any(|w| w == [0xFF, 0xD9]),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "docx" | "xlsx" | "hwpx" => bytes.starts_with(b"PK"),
        "hwp" | "xls" => bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]),
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err(WorkerError::new(ErrorCode::UnsupportedInput, format!("파일이 깨져서 읽을 수 없어요(.{ext}) · 다시 저장하거나 사진으로 찍어 넣어 주세요")))
    }
}

pub fn analyze_with(input: &Input, engine: EngineId, reference: DateTime<FixedOffset>, engines: &Engines, options: &AnalyzeOptions) -> Result<Proposal, WorkerError> {
    let started = Instant::now();
    let (source_type, format, bytes) = match input {
        Input::File(path) => {
            let (kind, ext) = source_type_for(path)?;
            let bytes = read_original(path)?;
            check_file_bytes(&ext, &bytes)?;
            (kind, ext, bytes)
        }
        Input::Text(text) => (SourceType::Text, "txt".to_string(), text.as_bytes().to_vec()),
    };
    let source = ProposalSource { source_type, format, sha256: sha256_hex(&bytes), bytes: bytes.len() as u64 };

    // Too short or too quiet: no model call, no items, only a review note.
    let wav = if source_type == SourceType::Audio { Some(inspect_wav(&bytes)?) } else { None };
    let empty = |reason: String, engine: EngineId, source_text: String, reader: String| Proposal {
        schema_version: PROPOSAL_SCHEMA_VERSION,
        source: source.clone(),
        reference_time: reference.to_rfc3339(),
        engine: EngineInfo { id: engine, reader, llm_model: String::new(), prompt_version: PROMPT_VERSION.to_string(), worker_version: WORKER_VERSION.to_string() },
        source_text,
        summary: String::new(),
        items: Vec::new(),
        needs_review: true,
        review_reasons: vec![reason],
        timings: Timings { total_ms: started.elapsed().as_millis() as u64, ..Timings::default() },
    };
    if let Some(info) = wav.filter(weak_audio) {
        return Ok(empty(format!("{WEAK_AUDIO_REASON} (길이 {}ms, 음량 {:.0})", info.duration_ms, info.rms), engine, String::new(), String::new()));
    }
    // Text and documents have nothing to read directly; they always use engine A. With the
    // OCR hint on, images always go to the model directly (the hint only exists there).
    let pdf = matches!(input, Input::File(p) if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")));
    let engine = match source_type {
        SourceType::Image if options.claude => EngineId::Direct,
        SourceType::Document if options.claude && pdf => EngineId::Direct,
        SourceType::Audio if options.claude => EngineId::TextFirst,
        SourceType::Image if options.image_ocr_hint => EngineId::Direct,
        SourceType::Audio | SourceType::Image => engine,
        SourceType::Text | SourceType::Document => EngineId::TextFirst,
    };

    let mut timings = Timings::default();
    let read_started = Instant::now();
    let (source_text, mut reader) = match (engine, source_type, input) {
        (EngineId::Direct, _, _) => (None, String::new()),
        (_, SourceType::Audio, Input::File(path)) => {
            let short = wav.is_some_and(|w| w.duration_ms < HINT_MIN_MS);
            let text = if short { engines.transcriber.transcribe_plain(path)? } else { engines.transcriber.transcribe(path)? };
            (Some(text), engines.transcriber.model_name())
        }
        (_, SourceType::Document | SourceType::Image, Input::File(path)) => (Some(engines.reader.read(path)?), engines.reader.reader_name()),
        (_, _, _) => (Some(decode_text(&bytes)?), String::new()),
    };
    timings.read_ms = read_started.elapsed().as_millis() as u64;

    if let (Some(text), SourceType::Audio) = (&source_text, source_type) {
        if looks_invented(text) {
            return Err(WorkerError::new(ErrorCode::EmptyAudio, format!("음성에서 알아들은 말이 없습니다(인식기가 지어낸 문장: 「{}」).", text.trim())));
        }
    }
    if let (Some(text), SourceType::Audio) = (&source_text, source_type) {
        let mut hints = engines.transcriber.hint_words();
        for w in options.extract.school_words.iter().chain(&options.extract.personal_words) {
            hints.extend(split_words(w));
        }
        if only_hint_words(text, &hints) {
            return Ok(empty(format!("{HINT_ONLY_REASON}: 「{}」", text.trim()), engine, text.clone(), reader));
        }
    }
    if let Some(text) = &source_text {
        if text.trim().is_empty() {
            return Err(match source_type {
                SourceType::Audio => WorkerError::new(ErrorCode::EmptyAudio, "음성에서 받아 적은 말이 없습니다."),
                _ => WorkerError::new(ErrorCode::EmptyDocument, "입력에서 읽은 글자가 없습니다."),
            });
        }
    }

    // A word or less (「ㅇㅇ」, 「.」, an empty transcript of a tap): nothing to organise, no API call.
    if let Some(text) = &source_text {
        if too_short(text) {
            if options.claude && !cfg!(test) {
                super::claude::log_skip(&super::claude::usage_log_path(), "short", "text");
            }
            return Ok(empty(TOO_SHORT_REASON.to_string(), engine, text.clone(), reader));
        }
    }

    let llm_started = Instant::now();
    let mut cut = false;
    let (source_text, summary, items, llm_model) = match source_text {
        Some(text) => {
            let mut summaries = Vec::new();
            let mut items = Vec::new();
            let read: String = text.chars().take(MAX_TEXT_CHARS).collect();
            if read.len() < text.len() {
                cut = true;
            }
            for chunk in chunk_text(&read, CHUNK_CHARS) {
                let messages = text_messages_with(&chunk, &options.extract);
                let extraction = extract_once(engines.text_model, messages, false, Some(&chunk), reference, options)?;
                if !extraction.summary.is_empty() {
                    summaries.push(extraction.summary);
                }
                items.extend(extraction.items);
            }
            (text, summaries.join(" / "), items, engines.text_model.model_name())
        }
        None => {
            let media = match source_type {
                SourceType::Audio => "음성",
                SourceType::Document => "문서",
                _ => "이미지",
            };
            // An OCR failure only removes the hint; the model still reads the image.
            let hint = match input {
                Input::File(path) if options.image_ocr_hint && source_type == SourceType::Image => engines.reader.read(path).ok(),
                _ => None,
            };
            if hint.is_some() {
                reader = engines.reader.reader_name();
            }
            let mut messages = direct_messages_with(media, base64(&bytes), hint.as_deref(), &options.extract);
            if source_type == SourceType::Document {
                // A PDF goes to Claude as a document block, not an image.
                if let Some(last) = messages.last_mut() {
                    last["documents"] = last["images"].take();
                    last.as_object_mut().map(|o| o.remove("images"));
                }
            }
            let extraction = extract_once(engines.direct_model, messages, true, None, reference, options)?;
            (extraction.transcript.unwrap_or_default(), extraction.summary, extraction.items, engines.direct_model.model_name())
        }
    };
    timings.llm_ms = llm_started.elapsed().as_millis() as u64;
    timings.total_ms = started.elapsed().as_millis() as u64;

    // The same thing found twice (in two chunks, or a pasted text repeated): once.
    let mut seen = std::collections::HashSet::new();
    let items: Vec<_> = items.into_iter().filter(|i| seen.insert((i.kind.clone(), i.title.trim().to_string(), i.start_at.clone(), i.end_at.clone()))).collect();
    let items = before_the_event(items);
    let mut review_reasons = Vec::new();
    if items.is_empty() {
        review_reasons.push("정리할 일정·할 일·기억할 내용을 찾지 못함".to_string());
    }
    if cut {
        review_reasons.push(TOO_LONG_REASON.to_string());
    }
    let needs_review = !review_reasons.is_empty() || items.iter().any(|item| item.needs_review);
    Ok(Proposal {
        schema_version: PROPOSAL_SCHEMA_VERSION,
        source,
        reference_time: reference.to_rfc3339(),
        engine: EngineInfo {
            id: engine,
            reader,
            llm_model,
            prompt_version: PROMPT_VERSION.to_string(),
            worker_version: WORKER_VERSION.to_string(),
        },
        source_text,
        summary,
        items,
        needs_review,
        review_reasons,
        timings,
    })
}

#[cfg(test)]
pub(crate) mod fakes {
    use super::*;
    use serde_json::Value;
    use std::cell::RefCell;

    pub struct FakeStt(pub Result<String, WorkerError>);
    impl Transcriber for FakeStt {
        fn model_name(&self) -> String {
            "fake-stt".into()
        }
        fn transcribe(&self, _: &Path) -> Result<String, WorkerError> {
            self.0.clone()
        }
    }

    pub struct FakeReader(pub Result<String, WorkerError>);
    impl DocumentReader for FakeReader {
        fn reader_name(&self) -> String {
            "fake-reader".into()
        }
        fn read(&self, _: &Path) -> Result<String, WorkerError> {
            self.0.clone()
        }
    }

    /// Returns queued answers in order; records how many calls were made.
    pub struct FakeChat {
        pub answers: RefCell<Vec<Result<String, WorkerError>>>,
        pub calls: RefCell<usize>,
    }
    impl FakeChat {
        pub fn new(answers: Vec<Result<String, WorkerError>>) -> Self {
            Self { answers: RefCell::new(answers), calls: RefCell::new(0) }
        }
    }
    impl ChatModel for FakeChat {
        fn model_name(&self) -> String {
            "fake-gemma".into()
        }
        fn chat_json(&self, _: Vec<Value>, _: &Value) -> Result<String, WorkerError> {
            *self.calls.borrow_mut() += 1;
            let mut answers = self.answers.borrow_mut();
            if answers.is_empty() {
                Err(WorkerError::new(ErrorCode::RunnerUnavailable, "fake runner exhausted"))
            } else {
                answers.remove(0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fakes::*, *};
    use crate::worker::source::pcm16_wav;
    use std::cell::RefCell;
    use serde_json::json;

    fn reference() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-10-21T09:00:00+09:00").unwrap()
    }

    fn answer() -> String {
        json!({"summary":"상담","items":[{"kind":"SCHEDULE","area":"SCHOOL","title":"학부모 상담","details":"","dateText":"내일","timeText":"오후 3시","evidence":"학부모 상담","confidence":0.9}]}).to_string()
    }

    fn speech_wav() -> Vec<u8> {
        pcm16_wav(16_000, &(0..16_000).map(|i| ((i as f64 * 0.05).sin() * 6000.0) as i16).collect::<Vec<_>>())
    }

    #[test]
    fn wav_through_engine_a_gives_proposal() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("memo.wav");
        std::fs::write(&wav, speech_wav()).unwrap();
        let stt = FakeStt(Ok("내일 오후 3시에 학부모 상담".into()));
        let chat = FakeChat::new(vec![Ok(answer())]);
        let engines = Engines { transcriber: &stt, reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        let p = analyze(&Input::File(&wav), EngineId::TextFirst, reference(), &engines).unwrap();
        assert_eq!(p.source.source_type, SourceType::Audio);
        assert_eq!(p.source.sha256, sha256_hex(&speech_wav()));
        assert_eq!(p.items[0].start_at, "2026-10-22T15:00:00+09:00");
        assert_eq!(p.engine.reader, "fake-stt");
        assert!(!p.needs_review);
        // The original is untouched.
        assert_eq!(std::fs::read(&wav).unwrap(), speech_wav());
    }

    #[test]
    fn rule_only_job_reads_nothing_but_the_text() {
        let p = rule_only_proposal(&Input::Text("내일 오후 3시 치과"), reference()).unwrap();
        assert!(p.items.is_empty() && !p.needs_review && p.summary == RULE_ONLY_SUMMARY && p.engine.llm_model == "rules");
        assert_eq!(p.source.sha256, sha256_hex("내일 오후 3시 치과".as_bytes()));
        assert_eq!(p.source_text, "내일 오후 3시 치과");
    }

    #[test]
    fn a_word_or_less_makes_no_model_call() {
        let chat = FakeChat::new(vec![]);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        for text in ["ㅇ", " . ", "?!", "a"] {
            let p = analyze(&Input::Text(text), EngineId::TextFirst, reference(), &engines).unwrap();
            assert!(p.items.is_empty() && p.review_reasons == vec![TOO_SHORT_REASON.to_string()], "{text}");
        }
        assert_eq!(*chat.calls.borrow(), 0);
        assert!(!too_short("내일") && too_short("ㅋ"));
    }

    #[test]
    fn silent_or_short_wav_makes_no_items_and_no_model_call() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            ("silence.wav", pcm16_wav(16_000, &vec![0; 16_000])),
            // 2026-10-25 regression: 0.5 s of near-silence became hint-word to-dos.
            ("half-second.wav", pcm16_wav(16_000, &vec![3; 8_000])),
            // Loud but only 0.6 s long.
            ("short.wav", pcm16_wav(16_000, &(0..9_600).map(|i| ((i as f64 * 0.05).sin() * 6000.0) as i16).collect::<Vec<_>>())),
            // Long enough but very weak.
            ("weak.wav", pcm16_wav(16_000, &(0..32_000).map(|i| ((i as f64 * 0.05).sin() * 200.0) as i16).collect::<Vec<_>>())),
        ];
        let stt = FakeStt(Ok("수행평회, 교직원 연수, 방과후 수행평가".into()));
        let chat = FakeChat::new(vec![]);
        let engines = Engines { transcriber: &stt, reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        for (name, bytes) in cases {
            let wav = dir.path().join(name);
            std::fs::write(&wav, bytes).unwrap();
            for engine in [EngineId::TextFirst, EngineId::Direct] {
                let p = analyze(&Input::File(&wav), engine, reference(), &engines).unwrap();
                assert!(p.items.is_empty(), "{name}");
                assert!(p.needs_review);
                assert!(p.review_reasons[0].starts_with(WEAK_AUDIO_REASON), "{name}: {:?}", p.review_reasons);
            }
        }
        assert_eq!(*chat.calls.borrow(), 0);
    }

    /// Records which transcription path was used.
    struct HintStt {
        hint: Vec<String>,
        text: String,
        plain_calls: RefCell<usize>,
    }
    impl Transcriber for HintStt {
        fn model_name(&self) -> String {
            "hint-stt".into()
        }
        fn transcribe(&self, _: &Path) -> Result<String, WorkerError> {
            Ok(self.text.clone())
        }
        fn transcribe_plain(&self, _: &Path) -> Result<String, WorkerError> {
            *self.plain_calls.borrow_mut() += 1;
            Ok(self.text.clone())
        }
        fn hint_words(&self) -> Vec<String> {
            self.hint.clone()
        }
    }

    #[test]
    fn transcript_made_only_of_hint_words_is_treated_as_invented() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("memo.wav");
        std::fs::write(&wav, speech_wav()).unwrap();
        let stt = HintStt { hint: split_words("수행평가, 교직원 연수, 방과후"), text: "수행평회, 교직원 연수, 방과후 수행평가".into(), plain_calls: RefCell::new(0) };
        let chat = FakeChat::new(vec![Ok(answer())]);
        let engines = Engines { transcriber: &stt, reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        let p = analyze(&Input::File(&wav), EngineId::TextFirst, reference(), &engines).unwrap();
        assert!(p.items.is_empty());
        assert!(p.review_reasons[0].starts_with(HINT_ONLY_REASON));
        assert_eq!(*chat.calls.borrow(), 0);
        // 1 s clip (< 3 s): transcribed without the hint.
        assert_eq!(*stt.plain_calls.borrow(), 1);
    }

    #[test]
    fn real_speech_with_hint_words_still_goes_through() {
        assert!(!only_hint_words("내일 교직원 연수 있어", &split_words("교직원 연수, 수행평가")));
        assert!(only_hint_words("수행평회 교직원", &split_words("교직원 연수, 수행평가")));
        assert!(!only_hint_words("수행평가", &[]));
    }

    #[test]
    fn whisper_noise_hallucination_is_empty_audio() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("noise.wav");
        std::fs::write(&wav, speech_wav()).unwrap();
        let chat = FakeChat::new(vec![Ok(answer())]);
        let engines = Engines { transcriber: &FakeStt(Ok("시청해주셔서 감사합니다.".into())), reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        assert_eq!(analyze(&Input::File(&wav), EngineId::TextFirst, reference(), &engines).unwrap_err().code, ErrorCode::EmptyAudio);
        assert_eq!(*chat.calls.borrow(), 0);
    }

    #[test]
    fn engine_b_uses_model_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("memo.wav");
        std::fs::write(&wav, speech_wav()).unwrap();
        let mut b = serde_json::from_str::<serde_json::Value>(&answer()).unwrap();
        b["transcript"] = json!("내일 오후 3시에 학부모 상담");
        let direct = FakeChat::new(vec![Ok(b.to_string())]);
        let unused = FakeChat::new(vec![]);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(String::new())), text_model: &unused, direct_model: &direct };
        let p = analyze(&Input::File(&wav), EngineId::Direct, reference(), &engines).unwrap();
        assert_eq!(p.engine.id, EngineId::Direct);
        assert_eq!(p.source_text, "내일 오후 3시에 학부모 상담");
        assert_eq!(*unused.calls.borrow(), 0);
    }

    #[test]
    fn a_to_do_said_before_an_appointment_is_due_then() {
        let mk = |kind: &str, title: &str, start: &str, sentence: &str| {
            let mut i: ProposalItem = serde_json::from_value(json!({"kind":kind,"area":"SCHOOL","title":title,"details":"","startAt":start,"endAt":"","reminderAt":"","reminders":[],"subtasks":[],
                "evidence":{"sentence":sentence,"dateText":"","timeText":"","endDateText":"","reminderText":""},"confidence":0.9,"needsReview":false,"reviewReasons":[]})).unwrap();
            i.title = title.into();
            i
        };
        let out = before_the_event(vec![
            mk("SCHEDULE", "학부모 상담", "2026-10-28T16:00:00+09:00", "학부모님께서 내일 오후 4시에 오시기로 하셨고"),
            mk("TODO", "성적표 출력", "", "상담 전에 성적표 출력해야 함"),
            mk("TODO", "도서 반납", "", "도서 반납"),
        ]);
        assert_eq!(out[1].start_at, "2026-10-28T16:00:00+09:00");
        assert!(out[1].review_reasons[0].contains("학부모 상담"));
        assert_eq!(out[2].start_at, "");
    }

    #[test]
    fn text_files_in_old_korean_and_windows_encodings_are_read() {
        let t = "11월 5일 3시 학년 협의회";
        let mut le = vec![0xFF, 0xFE];
        le.extend(t.encode_utf16().flat_map(u16::to_le_bytes));
        let mut be = vec![0xFE, 0xFF];
        be.extend(t.encode_utf16().flat_map(u16::to_be_bytes));
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend(t.as_bytes());
        // 「11월 5일」 in CP949.
        let euc: &[u8] = &[0x31, 0x31, 0xBF, 0xF9, 0x20, 0x35, 0xC0, 0xCF];
        assert_eq!(decode_text(&le).unwrap(), t);
        assert_eq!(decode_text(&be).unwrap(), t);
        assert_eq!(decode_text(&bom).unwrap(), t);
        assert_eq!(decode_text(t.as_bytes()).unwrap(), t);
        if cfg!(target_os = "macos") {
            assert_eq!(decode_text(euc).unwrap(), "11월 5일");
            assert_eq!(decode_text(&[0xFF, 0xFF, 0x80, 0xFF]).unwrap_err().message, UNREADABLE_TEXT);
        }
    }

    #[test]
    fn broken_or_renamed_files_are_caught_before_the_model() {
        for (ext, bytes) in [("pdf", &b"garbage"[..]), ("png", &b"GIF89a"[..]), ("jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0][..]), ("docx", &b"%PDF"[..]), ("hwp", &b"PK.."[..])] {
            let e = check_file_bytes(ext, bytes).unwrap_err();
            assert_eq!(e.code, ErrorCode::UnsupportedInput, "{ext}");
            assert!(e.message.contains("깨져서"), "{ext}");
        }
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpg.extend(vec![1u8; 200]);
        jpg.extend([0xFF, 0xD9]);
        for (ext, bytes) in [("pdf", &b"%PDF-1.7"[..]), ("png", &b"\x89PNG\r\n"[..]), ("jpg", &jpg[..]), ("docx", &b"PK\x03\x04"[..]), ("txt", &b"x"[..])] {
            assert!(check_file_bytes(ext, bytes).is_ok(), "{ext}");
        }
    }

    #[test]
    fn a_very_long_text_is_read_only_in_front_and_repeats_count_once() {
        // 2026-10-27 밤 안정화: a 3 MB pasted text made ~690 model calls and 693 identical items.
        let long = "내일 오후 3시에 학부모 상담\n".repeat(MAX_TEXT_CHARS / 8);
        let read: String = long.chars().take(MAX_TEXT_CHARS).collect();
        let chunks = chunk_text(&read, CHUNK_CHARS).len();
        let chat = FakeChat::new(vec![Ok(answer()); chunks]);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(String::new())), text_model: &chat, direct_model: &chat };
        let p = analyze(&Input::Text(&long), EngineId::TextFirst, reference(), &engines).unwrap();
        assert!(*chat.calls.borrow() <= MAX_TEXT_CHARS / CHUNK_CHARS + 1);
        assert_eq!(p.items.len(), 1);
        assert!(p.review_reasons.contains(&TOO_LONG_REASON.to_string()));
    }

    #[test]
    fn documents_are_read_then_chunked() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("notice.pdf");
        std::fs::write(&pdf, b"%PDF-fake").unwrap();
        let long = format!("{}\n내일 오후 3시에 학부모 상담", "가상 안내문 줄입니다.\n".repeat(400));
        let chunks = chunk_text(&long, CHUNK_CHARS).len();
        assert!(chunks > 1);
        let mut answers = vec![Ok(json!({"summary":"","items":[]}).to_string()); chunks - 1];
        answers.push(Ok(answer()));
        let chat = FakeChat::new(answers);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok(long)), text_model: &chat, direct_model: &chat };
        // Engine B is ignored for documents.
        let p = analyze(&Input::File(&pdf), EngineId::Direct, reference(), &engines).unwrap();
        assert_eq!(p.engine.id, EngineId::TextFirst);
        assert_eq!(p.source.source_type, SourceType::Document);
        assert_eq!(*chat.calls.borrow(), chunks);
        assert_eq!(p.items.len(), 1);
    }

    #[test]
    fn empty_document_and_unknown_format_fail() {
        let dir = tempfile::tempdir().unwrap();
        let hwp = dir.path().join("blank.hwp");
        std::fs::write(&hwp, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).unwrap();
        let chat = FakeChat::new(vec![]);
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok("  ".into())), text_model: &chat, direct_model: &chat };
        assert_eq!(analyze(&Input::File(&hwp), EngineId::TextFirst, reference(), &engines).unwrap_err().code, ErrorCode::EmptyDocument);
        let exe = dir.path().join("a.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(analyze(&Input::File(&exe), EngineId::TextFirst, reference(), &engines).unwrap_err().code, ErrorCode::UnsupportedInput);
    }

    #[test]
    fn model_errors_propagate() {
        let engines_with = |chat: &FakeChat| {
            let p = analyze(&Input::Text("내일 오후 3시에 학부모 상담"), EngineId::TextFirst, reference(), &Engines {
                transcriber: &FakeStt(Ok(String::new())),
                reader: &FakeReader(Ok(String::new())),
                text_model: chat,
                direct_model: chat,
            });
            p.unwrap_err().code
        };
        assert_eq!(engines_with(&FakeChat::new(vec![Ok("{oops".into())])), ErrorCode::InvalidModelOutput);
        assert_eq!(engines_with(&FakeChat::new(vec![Err(WorkerError::new(ErrorCode::ModelMissing, "x"))])), ErrorCode::ModelMissing);
    }

    #[test]
    fn nothing_found_is_reviewed_not_invented() {
        let chat = FakeChat::new(vec![Ok(json!({"summary":"인사","items":[]}).to_string())]);
        let p = analyze(&Input::Text("안녕"), EngineId::TextFirst, reference(), &Engines {
            transcriber: &FakeStt(Ok(String::new())),
            reader: &FakeReader(Ok(String::new())),
            text_model: &chat,
            direct_model: &chat,
        })
        .unwrap();
        assert!(p.items.is_empty() && p.needs_review);
    }

    #[test]
    fn recheck_runs_only_when_doubtful_and_keeps_the_better_answer() {
        let opts = AnalyzeOptions { recheck_below: Some(0.7), ..Default::default() };
        let run = |chat: &FakeChat| {
            analyze_with(&Input::Text("내일 오후 3시에 학부모 상담"), EngineId::TextFirst, reference(), &Engines {
                transcriber: &FakeStt(Ok(String::new())),
                reader: &FakeReader(Ok(String::new())),
                text_model: chat,
                direct_model: chat,
            }, &opts)
        };
        // Confident first answer: one call.
        let sure = FakeChat::new(vec![Ok(answer())]);
        run(&sure).unwrap();
        assert_eq!(*sure.calls.borrow(), 1);
        // Doubtful first answer (missed date), corrected second answer wins.
        let missed = json!({"summary":"","items":[{"kind":"SCHEDULE","area":"SCHOOL","title":"학부모 상담","details":"","dateText":"","timeText":"","evidence":"학부모 상담","confidence":0.4}]}).to_string();
        let fixed = FakeChat::new(vec![Ok(missed.clone()), Ok(answer())]);
        let p = run(&fixed).unwrap();
        assert_eq!(*fixed.calls.borrow(), 2);
        assert_eq!(p.items[0].start_at, "2026-10-22T15:00:00+09:00");
        // A broken second answer keeps the first.
        let broken = FakeChat::new(vec![Ok(missed), Ok("not json".into())]);
        let p = run(&broken).unwrap();
        assert_eq!(p.items[0].start_at, "");
    }

    #[test]
    fn image_hint_reads_ocr_but_survives_its_failure() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("notice.png");
        std::fs::write(&png, b"\x89PNG fake png").unwrap();
        let mut b = serde_json::from_str::<serde_json::Value>(&answer()).unwrap();
        b["transcript"] = json!("내일 오후 3시에 학부모 상담");
        let opts = AnalyzeOptions { image_ocr_hint: true, ..Default::default() };
        for reader in [FakeReader(Ok("내일 오후 3시 학부모 상담".into())), FakeReader(Err(WorkerError::new(ErrorCode::ReaderFailed, "x")))] {
            let direct = FakeChat::new(vec![Ok(b.to_string())]);
            let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &reader, text_model: &direct, direct_model: &direct };
            // Engine A was asked for; the hint switches images to the direct path.
            let p = analyze_with(&Input::File(&png), EngineId::TextFirst, reference(), &engines, &opts).unwrap();
            assert_eq!(p.items.len(), 1);
            assert_eq!(p.engine.id, EngineId::Direct);
        }
    }

    #[test]
    fn base64_matches_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    struct Recorder(std::cell::RefCell<Vec<Vec<serde_json::Value>>>, String);
    impl ChatModel for Recorder {
        fn model_name(&self) -> String {
            "claude/test".into()
        }
        fn chat_json(&self, messages: Vec<serde_json::Value>, _: &serde_json::Value) -> Result<String, WorkerError> {
            self.0.borrow_mut().push(messages);
            Ok(self.1.clone())
        }
    }

    #[test]
    fn claude_reads_images_and_pdfs_directly_and_documents_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let answer = serde_json::json!({"transcript":"11월 3일 운동회","summary":"운동회","items":[]}).to_string();
        let opts = AnalyzeOptions { claude: true, ..Default::default() };
        for (name, bytes, key) in [("a.png", &b"\x89PNG fake"[..], "images"), ("b.pdf", &b"%PDF-1.4 fake"[..], "documents")] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            let chat = Recorder(Default::default(), answer.clone());
            let reader = FakeReader(Err(WorkerError::new(ErrorCode::ReaderFailed, "OCR must not run")));
            let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &reader, text_model: &chat, direct_model: &chat };
            analyze_with(&Input::File(&path), EngineId::TextFirst, reference(), &engines, &opts).unwrap();
            let sent = chat.0.borrow();
            let last = sent[0].last().unwrap();
            assert!(last[key].is_array(), "{name}: {last}");
            assert!(last.get(if key == "images" { "documents" } else { "images" }).is_none());
        }
        // HWPX is read to text locally (kordoc), then sent as text.
        let path = dir.path().join("c.hwpx");
        std::fs::write(&path, b"PK fake").unwrap();
        let chat = Recorder(Default::default(), serde_json::json!({"summary":"","items":[]}).to_string());
        let engines = Engines { transcriber: &FakeStt(Ok(String::new())), reader: &FakeReader(Ok("공문 본문".into())), text_model: &chat, direct_model: &chat };
        analyze_with(&Input::File(&path), EngineId::TextFirst, reference(), &engines, &opts).unwrap();
        assert_eq!(chat.0.borrow()[0].last().unwrap()["content"], "공문 본문");
    }
}
