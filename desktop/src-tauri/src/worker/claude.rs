//! Claude API analyzer (raw HTTP: Rust has no official Anthropic SDK).
//!
//! The same structured proposal as before: the model only copies date/time phrases, the code
//! computes dates. One fixed system prompt + few-shot turns are cached (prompt caching); the
//! answer is constrained with `output_config.format` (JSON schema). The API key lives only in
//! the macOS keychain (never in a file, log, Drive or the repository). Token counts (no content)
//! go to a local usage log for the 「이번 달 대략 사용액」 line.

use super::{
    error::{ErrorCode, WorkerError},
    runners::ChatModel,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

pub const DEFAULT_MODEL: &str = "claude-haiku-5-5";
pub const DEFAULT_URL: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2023-06-01";
/// Claude Haiku 5.5 prices per million tokens (prompts up to 100K tokens), USD.
pub const PRICE_INPUT: f64 = 0.10;
pub const PRICE_OUTPUT: f64 = 0.50;
const KEYCHAIN_SERVICE: &str = "com.malhaedwo.blackhole.claude";
const KEYCHAIN_ACCOUNT: &str = "api-key";
const RETRIES: u32 = 3;

pub struct ClaudeChat {
    pub base_url: String,
    pub model: String,
    pub effort: String,
    pub max_tokens: u32,
    pub timeout: Duration,
    /// None: read the key when called (keychain); tests pass one.
    pub api_key: Option<String>,
    pub usage_log: Option<PathBuf>,
}

impl ClaudeChat {
    pub fn new(model: &str, effort: &str) -> Self {
        Self {
            base_url: std::env::var("BLACKHOLE_CLAUDE_URL").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.into()),
            model: model.into(),
            effort: effort.into(),
            max_tokens: 8192,
            timeout: Duration::from_secs(120),
            api_key: None,
            usage_log: Some(usage_log_path()),
        }
    }
}

/// Structured outputs need `additionalProperties: false` on every object.
pub fn strict_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if matches!(k.as_str(), "minimum" | "maximum" | "minLength" | "maxLength" | "minItems" | "maxItems" | "multipleOf") {
                    continue;
                }
                out.insert(k.clone(), strict_schema(v));
            }
            if out.get("type").and_then(Value::as_str) == Some("object") {
                out.insert("additionalProperties".into(), Value::Bool(false));
            }
            Value::Object(out)
        }
        Value::Array(list) => Value::Array(list.iter().map(strict_schema).collect()),
        other => other.clone(),
    }
}

fn media_type(b64: &str) -> &'static str {
    if b64.starts_with("iVBOR") {
        "image/png"
    } else if b64.starts_with("UklGR") {
        "image/webp"
    } else if b64.starts_with("R0lGOD") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}

/// The worker's chat messages (system / few-shot / user with `images` or `documents`) as a
/// Messages API request body. The stable prefix (system + few-shot) carries cache breakpoints.
pub fn request_body(model: &str, effort: &str, max_tokens: u32, messages: &[Value], schema: &Value) -> Value {
    let system: Vec<&str> = messages.iter().filter(|m| m["role"] == "system").filter_map(|m| m["content"].as_str()).collect();
    let turns: Vec<&Value> = messages.iter().filter(|m| m["role"] != "system").collect();
    let last_fixed = turns.len().saturating_sub(1); // everything before the final user turn is fixed
    let mut out = Vec::new();
    for (i, m) in turns.iter().enumerate() {
        let mut content = Vec::new();
        for d in m["documents"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            content.push(json!({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": d}}));
        }
        for img in m["images"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            content.push(json!({"type": "image", "source": {"type": "base64", "media_type": media_type(img), "data": img}}));
        }
        let mut text = json!({"type": "text", "text": m["content"].as_str().unwrap_or("")});
        if i + 1 == last_fixed {
            text["cache_control"] = json!({"type": "ephemeral"});
        }
        content.push(text);
        out.push(json!({"role": m["role"], "content": content}));
    }
    json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": [{"type": "text", "text": system.join("\n"), "cache_control": {"type": "ephemeral"}}],
        "messages": out,
        "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": strict_schema(schema)}}
    })
}

/// The JSON text of a successful response, or a worker error that says what to do.
pub fn read_response(value: &Value) -> Result<String, WorkerError> {
    match value["stop_reason"].as_str() {
        Some("refusal") => {
            return Err(WorkerError::new(ErrorCode::RunnerFailed, "AI가 이 내용의 정리를 거절했습니다(안전 기준). 초안만 남겨 둡니다."));
        }
        Some("max_tokens") => {
            return Err(WorkerError::new(ErrorCode::InvalidModelOutput, "AI 답이 길이 제한에서 끊겼습니다."));
        }
        _ => {}
    }
    value["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text").and_then(|b| b["text"].as_str()))
        .map(str::to_owned)
        .ok_or_else(|| WorkerError::new(ErrorCode::InvalidModelOutput, "AI 응답에 본문이 없습니다."))
}

/// HTTP status → error. Missing key, billing and limits are 「waiting」 codes (the job is kept).
pub fn status_error(code: u16, body: &str) -> WorkerError {
    let kind = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["type"].as_str().map(str::to_owned)).unwrap_or_default();
    match code {
        401 | 403 => WorkerError::new(ErrorCode::ApiKeyMissing, "Claude API 키가 올바르지 않거나 권한이 없습니다. 설정에서 키를 확인해 주세요."),
        402 => WorkerError::new(ErrorCode::ApiBilling, "Claude API 잔액이 부족하거나 결제 문제가 있습니다. 콘솔에서 결제를 확인해 주세요."),
        404 => WorkerError::new(ErrorCode::ModelMissing, format!("Claude 모델을 찾지 못했습니다({kind}).")),
        429 => WorkerError::new(ErrorCode::RunnerUnavailable, "Claude API 사용 한도에 걸렸습니다. 잠시 뒤 다시 합니다."),
        500..=599 => WorkerError::new(ErrorCode::RunnerUnavailable, format!("Claude API가 잠시 응답하지 않습니다(HTTP {code}). 잠시 뒤 다시 합니다.")),
        _ if body.contains("credit balance") => WorkerError::new(ErrorCode::ApiBilling, "Claude API 잔액이 부족합니다. 콘솔에서 충전해 주세요."),
        _ => WorkerError::new(ErrorCode::RunnerFailed, format!("Claude API 요청 실패 HTTP {code} ({kind})")),
    }
}

fn retryable(code: u16) -> bool {
    code == 429 || code == 529 || (500..=599).contains(&code)
}

impl ChatModel for ClaudeChat {
    fn model_name(&self) -> String {
        format!("claude/{}", self.model)
    }

    fn chat_json(&self, messages: Vec<Value>, schema: &Value) -> Result<String, WorkerError> {
        let key = match &self.api_key {
            Some(k) => k.clone(),
            None => api_key()?.ok_or_else(|| WorkerError::new(ErrorCode::ApiKeyMissing, "Claude API 키가 없습니다. 설정에서 키를 넣으면 AI 다듬기를 시작합니다(초안은 그대로 들어갑니다)."))?,
        };
        let body = request_body(&self.model, &self.effort, self.max_tokens, &messages, schema);
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let mut last = WorkerError::new(ErrorCode::RunnerUnavailable, "Claude API에 연결할 수 없습니다.");
        for attempt in 0..RETRIES {
            let response = ureq::post(&url)
                .timeout(self.timeout)
                .set("x-api-key", &key)
                .set("anthropic-version", API_VERSION)
                .set("content-type", "application/json")
                .send_json(body.clone());
            let wait = match response {
                Ok(ok) => {
                    let value: Value = ok.into_json().map_err(|e| WorkerError::new(ErrorCode::RunnerFailed, format!("Claude API 응답을 읽지 못했습니다: {e}")))?;
                    if let Some(path) = &self.usage_log {
                        log_usage(path, &self.model, &value["usage"]);
                    }
                    return read_response(&value);
                }
                Err(ureq::Error::Status(code, resp)) => {
                    let after = resp.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok());
                    let text = resp.into_string().unwrap_or_default();
                    last = status_error(code, &text);
                    if !retryable(code) {
                        return Err(last);
                    }
                    after.unwrap_or(1 << attempt).min(30)
                }
                Err(ureq::Error::Transport(t)) => {
                    last = WorkerError::new(ErrorCode::RunnerUnavailable, format!("Claude API에 연결할 수 없습니다(인터넷 확인): {t}"));
                    1 << attempt
                }
            };
            if attempt + 1 < RETRIES {
                std::thread::sleep(Duration::from_secs(wait));
            }
        }
        Err(last)
    }
}

/* ---------- key: macOS keychain only ---------- */

/// The API key: `BLACKHOLE_CLAUDE_API_KEY` (tests, CLI) or the macOS keychain.
pub fn api_key() -> Result<Option<String>, WorkerError> {
    if let Ok(k) = std::env::var("BLACKHOLE_CLAUDE_API_KEY") {
        if !k.trim().is_empty() {
            return Ok(Some(k.trim().to_string()));
        }
    }
    if !cfg!(target_os = "macos") {
        return Ok(None);
    }
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"])
        .stderr(Stdio::null())
        .output()
        .map_err(|e| WorkerError::new(ErrorCode::Io, format!("키체인을 열 수 없습니다: {e}")))?;
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if out.status.success() && !key.is_empty() { Some(key) } else { None })
}

/// Rough check before storing: Anthropic keys start with `sk-ant-` and contain no spaces.
pub fn looks_like_key(key: &str) -> bool {
    let k = key.trim();
    k.starts_with("sk-ant-") && k.len() > 20 && !k.chars().any(|c| c.is_whitespace() || c == '"' || c == '\\')
}

/// Store the key in the keychain. It goes through `security -i`'s standard input, so it never
/// appears in a process list or a file.
pub fn store_key(key: &str) -> Result<(), WorkerError> {
    let key = key.trim();
    if !looks_like_key(key) {
        return Err(WorkerError::new(ErrorCode::ApiKeyMissing, "Claude API 키 형식이 아닙니다(sk-ant-로 시작)."));
    }
    if !cfg!(target_os = "macos") {
        return Err(WorkerError::new(ErrorCode::Io, "키체인은 macOS에서만 씁니다."));
    }
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| WorkerError::new(ErrorCode::Io, format!("키체인을 열 수 없습니다: {e}")))?;
    {
        let stdin = child.stdin.as_mut().ok_or_else(|| WorkerError::new(ErrorCode::Io, "키체인 입력을 열 수 없습니다."))?;
        writeln!(stdin, "add-generic-password -U -s {KEYCHAIN_SERVICE} -a {KEYCHAIN_ACCOUNT} -l 블랙홀-Claude-API -w {key}")
            .map_err(|e| WorkerError::new(ErrorCode::Io, format!("키체인에 쓰지 못했습니다: {e}")))?;
    }
    let out = child.wait_with_output().map_err(|e| WorkerError::new(ErrorCode::Io, e.to_string()))?;
    let err = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || err.contains("error") {
        return Err(WorkerError::new(ErrorCode::Io, "키체인에 저장하지 못했습니다."));
    }
    Ok(())
}

pub fn clear_key() -> Result<(), WorkerError> {
    if cfg!(target_os = "macos") {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    Ok(())
}

/// 「연결 확인」: reads the model's description (no tokens are spent).
pub fn check_key(base_url: &str, key: &str, model: &str) -> Result<(), WorkerError> {
    let url = format!("{}/v1/models/{model}", base_url.trim_end_matches('/'));
    match ureq::get(&url).timeout(Duration::from_secs(20)).set("x-api-key", key).set("anthropic-version", API_VERSION).call() {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, resp)) => Err(status_error(code, &resp.into_string().unwrap_or_default())),
        Err(ureq::Error::Transport(t)) => Err(WorkerError::new(ErrorCode::RunnerUnavailable, format!("Claude API에 연결할 수 없습니다: {t}"))),
    }
}

/* ---------- usage log (token counts only) ---------- */

pub fn usage_log_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local").join("share").join("blackhole").join("claude-usage.jsonl")
}

fn log_usage(path: &PathBuf, model: &str, usage: &Value) {
    let n = |k: &str| usage[k].as_u64().unwrap_or(0);
    let line = json!({
        "at": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        "model": model,
        "input": n("input_tokens"),
        "output": n("output_tokens"),
        "cacheRead": n("cache_read_input_tokens"),
        "cacheWrite": n("cache_creation_input_tokens")
    });
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Cost of one logged line (USD): cache reads 0.1×, cache writes 1.25× the input price.
pub fn line_cost(v: &Value) -> f64 {
    let n = |k: &str| v[k].as_u64().unwrap_or(0) as f64;
    (n("input") * PRICE_INPUT + n("cacheRead") * PRICE_INPUT * 0.1 + n("cacheWrite") * PRICE_INPUT * 1.25 + n("output") * PRICE_OUTPUT) / 1_000_000.0
}

/// (requests, USD) for the month `yyyy_mm` ("2026-10").
pub fn month_usage(path: &PathBuf, yyyy_mm: &str) -> (u64, f64) {
    let Ok(text) = fs::read_to_string(path) else { return (0, 0.0) };
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["at"].as_str().is_some_and(|a| a.starts_with(yyyy_mm)))
        .fold((0, 0.0), |(n, usd), v| (n + 1, usd + line_cost(&v)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpListener, sync::mpsc, thread};

    fn schema() -> Value {
        crate::worker::extract::output_schema(false)
    }

    /// One-request-per-connection fake API on 127.0.0.1: replies with the queued responses.
    fn fake_api(replies: Vec<(u16, String)>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for (code, body) in replies {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 1 << 20];
                let mut got = Vec::new();
                loop {
                    let n = s.read(&mut buf).unwrap();
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got);
                    if let Some(h) = text.find("\r\n\r\n") {
                        let len = text[..h].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if got.len() >= h + 4 + len {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                tx.send(String::from_utf8_lossy(&got).into_owned()).unwrap();
                let resp = format!("HTTP/1.1 {code} X\r\ncontent-type: application/json\r\nretry-after: 0\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                s.write_all(resp.as_bytes()).unwrap();
            }
        });
        (url, rx)
    }

    fn chat(url: &str, log: Option<PathBuf>) -> ClaudeChat {
        ClaudeChat { base_url: url.into(), model: DEFAULT_MODEL.into(), effort: "low".into(), max_tokens: 8192, timeout: Duration::from_secs(5), api_key: Some("sk-ant-test-0000000000000000".into()), usage_log: log }
    }

    const ANSWER: &str = r#"{"summary":"상담","items":[]}"#;

    fn ok_body() -> String {
        json!({"type":"message","stop_reason":"end_turn","content":[{"type":"thinking","thinking":""},{"type":"text","text":ANSWER}],
            "usage":{"input_tokens":120,"output_tokens":40,"cache_read_input_tokens":1500,"cache_creation_input_tokens":0}}).to_string()
    }

    #[test]
    fn request_is_cached_structured_and_carries_images_and_pdfs() {
        let mut messages = crate::worker::extract::text_messages("내일 3시 상담");
        let body = request_body(DEFAULT_MODEL, "low", 8192, &messages, &schema());
        assert_eq!(body["model"], "claude-haiku-5-5");
        assert_eq!(body["output_config"]["effort"], "low");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(body["output_config"]["format"]["schema"]["additionalProperties"], false);
        assert_eq!(body["output_config"]["format"]["schema"]["properties"]["items"]["items"]["additionalProperties"], false);
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        let turns = body["messages"].as_array().unwrap();
        // The last few-shot turn carries the second breakpoint; the user's own words come after it.
        assert_eq!(turns[turns.len() - 2]["content"][0]["cache_control"]["type"], "ephemeral");
        assert!(turns.last().unwrap()["content"][0].get("cache_control").is_none());
        assert!(body.get("temperature").is_none() && body.get("thinking").is_none());
        messages.last_mut().unwrap()["images"] = json!(["iVBORw0KGgo="]);
        messages.last_mut().unwrap()["documents"] = json!(["JVBERi0x"]);
        let body = request_body(DEFAULT_MODEL, "low", 8192, &messages, &schema());
        let last = &body["messages"].as_array().unwrap().last().unwrap()["content"];
        assert_eq!(last[0]["type"], "document");
        assert_eq!(last[1]["source"]["media_type"], "image/png");
        assert_eq!(last[2]["type"], "text");
    }

    #[test]
    fn answers_retries_and_logs_tokens_only() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("usage.jsonl");
        let (url, rx) = fake_api(vec![(529, r#"{"type":"error","error":{"type":"overloaded_error"}}"#.into()), (200, ok_body())]);
        let got = chat(&url, Some(log.clone())).chat_json(crate::worker::extract::text_messages("내일 3시 상담"), &schema()).unwrap();
        assert_eq!(got, ANSWER);
        let first = rx.recv().unwrap();
        assert!(first.contains("x-api-key: sk-ant-test") && first.contains("anthropic-version: 2023-06-01"));
        let _second = rx.recv().unwrap();
        let line = fs::read_to_string(&log).unwrap();
        assert!(line.contains("\"input\":120") && line.contains("\"cacheRead\":1500"));
        assert!(!line.contains("상담") && !line.contains("sk-ant"), "no content, no key in the log");
        let month = chrono::Local::now().format("%Y-%m").to_string();
        let (n, usd) = month_usage(&log, &month);
        assert_eq!(n, 1);
        assert!((usd - (120.0 * 0.10 + 1500.0 * 0.01 + 40.0 * 0.50) / 1e6).abs() < 1e-12);
    }

    #[test]
    fn key_billing_and_limits_are_waiting_errors() {
        let (url, _rx) = fake_api(vec![(401, r#"{"error":{"type":"authentication_error"}}"#.into())]);
        let e = chat(&url, None).chat_json(crate::worker::extract::text_messages("x"), &schema()).unwrap_err();
        assert_eq!(e.code, ErrorCode::ApiKeyMissing);
        assert!(e.code.is_waiting());
        assert_eq!(status_error(402, "{}").code, ErrorCode::ApiBilling);
        assert!(status_error(429, "{}").code.is_waiting());
        assert!(!status_error(400, r#"{"error":{"type":"invalid_request_error"}}"#).code.is_waiting());
        assert_eq!(status_error(400, r#"{"error":{"message":"Your credit balance is too low"}}"#).code, ErrorCode::ApiBilling);
        let mut no_key = chat(&url, None);
        no_key.api_key = None;
        std::env::remove_var("BLACKHOLE_CLAUDE_API_KEY");
        // (With no keychain entry either, the job waits for a key.)
        if api_key().unwrap().is_none() {
            assert_eq!(no_key.chat_json(vec![], &schema()).unwrap_err().code, ErrorCode::ApiKeyMissing);
        }
    }

    #[test]
    fn refusal_and_cut_answers_are_not_guessed() {
        assert_eq!(read_response(&json!({"stop_reason":"refusal","content":[]})).unwrap_err().code, ErrorCode::RunnerFailed);
        assert_eq!(read_response(&json!({"stop_reason":"max_tokens","content":[{"type":"text","text":"{"}]})).unwrap_err().code, ErrorCode::InvalidModelOutput);
        assert!(looks_like_key("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"));
        assert!(!looks_like_key("sk-ant-x y") && !looks_like_key("hello"));
    }
}
