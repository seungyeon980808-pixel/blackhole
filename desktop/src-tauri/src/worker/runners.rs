//! Local model runners: whisper.cpp (`whisper-cli`) for speech recognition and
//! Ollama on loopback for Gemma. Nothing here talks to a non-local host.

use super::error::{ErrorCode, WorkerError};
use serde_json::{json, Value};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

/// Speech recognition: WAV path in, transcript out.
pub trait Transcriber {
    fn model_name(&self) -> String;
    fn transcribe(&self, wav: &Path) -> Result<String, WorkerError>;
    /// Without any vocabulary hint. Short recordings use this: with almost no sound the
    /// recognizer otherwise "hears" the hint words themselves.
    fn transcribe_plain(&self, wav: &Path) -> Result<String, WorkerError> {
        self.transcribe(wav)
    }
    /// Words given to the recognizer as a hint (empty when none).
    fn hint_words(&self) -> Vec<String> {
        Vec::new()
    }
}

/// One chat call to a local LLM that must answer with JSON matching `schema`.
pub trait ChatModel {
    fn model_name(&self) -> String;
    fn chat_json(&self, messages: Vec<Value>, schema: &Value) -> Result<String, WorkerError>;
}

/// Document or image to text (Markdown). Images are OCR'd.
pub trait DocumentReader {
    fn reader_name(&self) -> String;
    fn read(&self, path: &Path) -> Result<String, WorkerError>;
}

/// kordoc CLI (MIT, runs locally). OCR models must be prefetched by
/// `tools/setup-local-models.sh`; analysis itself does not download anything.
pub struct KordocCli {
    pub binary: PathBuf,
}

impl DocumentReader for KordocCli {
    fn reader_name(&self) -> String {
        let version = Command::new(&self.binary)
            .arg("--version")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        format!("kordoc/{version}")
    }

    fn read(&self, path: &Path) -> Result<String, WorkerError> {
        let output = Command::new(&self.binary)
            .arg(path)
            .output()
            .map_err(|error| match error.kind() {
                ErrorKind::NotFound => WorkerError::new(
                    ErrorCode::ReaderUnavailable,
                    format!("문서 읽기 도구(kordoc)를 찾을 수 없습니다: {}", self.binary.display()),
                ),
                _ => WorkerError::new(ErrorCode::ReaderFailed, format!("문서 읽기 실행 실패: {error}")),
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
            return Err(WorkerError::new(ErrorCode::ReaderFailed, format!("문서를 읽지 못했습니다({}): {tail}", output.status)));
        }
        // kordoc escapes Markdown tildes ("\~"); unescape so evidence matches the source wording.
        Ok(String::from_utf8_lossy(&output.stdout).replace("\\~", "~").trim().to_string())
    }
}

pub struct WhisperCli {
    pub binary: PathBuf,
    pub model: PathBuf,
    pub language: String,
    /// Vocabulary hint passed as whisper's initial prompt (`--prompt`).
    pub prompt: Option<String>,
}

impl Transcriber for WhisperCli {
    fn model_name(&self) -> String {
        let file = self.model.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        format!("whisper.cpp/{file}")
    }

    fn transcribe(&self, wav: &Path) -> Result<String, WorkerError> {
        self.run(wav, self.prompt.as_deref())
    }

    fn transcribe_plain(&self, wav: &Path) -> Result<String, WorkerError> {
        self.run(wav, None)
    }

    fn hint_words(&self) -> Vec<String> {
        self.prompt.as_deref().map(split_words).unwrap_or_default()
    }
}

/// Split a hint ("수행평가, 교직원 연수 / 방과후") into single words.
pub fn split_words(text: &str) -> Vec<String> {
    text.split(|c: char| c.is_whitespace() || matches!(c, ',' | '.' | '·' | '/' | ';' | ':' | '、' | '，'))
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

impl WhisperCli {
    fn run(&self, wav: &Path, prompt: Option<&str>) -> Result<String, WorkerError> {
        if !self.model.is_file() {
            return Err(WorkerError::new(
                ErrorCode::SttModelMissing,
                format!("음성 인식 모델 파일이 없습니다: {}", self.model.display()),
            ));
        }
        let mut command = Command::new(&self.binary);
        command.args(["-l", &self.language, "-nt", "-np", "-m"]).arg(&self.model).arg("-f").arg(wav);
        if let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) {
            command.arg("--prompt").arg(prompt);
        }
        let output = command
            .output()
            .map_err(|error| match error.kind() {
                ErrorKind::NotFound => WorkerError::new(
                    ErrorCode::SttUnavailable,
                    format!("음성 인식 실행기를 찾을 수 없습니다: {}", self.binary.display()),
                ),
                _ => WorkerError::new(ErrorCode::SttFailed, format!("음성 인식 실행 실패: {error}")),
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
            return Err(WorkerError::new(ErrorCode::SttFailed, format!("음성 인식 실패({}): {tail}", output.status)));
        }
        let text = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        Ok(text)
    }
}

pub struct OllamaChat {
    /// Must be a loopback URL such as `http://127.0.0.1:11434`.
    pub base_url: String,
    pub model: String,
    pub timeout: Duration,
}

pub fn ensure_loopback(url: &str) -> Result<(), WorkerError> {
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        WorkerError::new(ErrorCode::RunnerUnavailable, "모델 실행기 주소는 http://127.0.0.1 또는 localhost만 허용합니다.")
    })?;
    let host = rest.split(['/', ':']).next().unwrap_or("");
    if rest.starts_with("[::1]") || matches!(host, "127.0.0.1" | "localhost") {
        Ok(())
    } else {
        Err(WorkerError::new(
            ErrorCode::RunnerUnavailable,
            format!("로컬이 아닌 모델 실행기 주소는 쓰지 않습니다: {host}"),
        ))
    }
}

impl ChatModel for OllamaChat {
    fn model_name(&self) -> String {
        format!("ollama/{}", self.model)
    }

    fn chat_json(&self, messages: Vec<Value>, schema: &Value) -> Result<String, WorkerError> {
        ensure_loopback(&self.base_url)?;
        let body = json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
            "think": false,
            "format": schema,
            "keep_alive": "10m",
            "options": { "temperature": 0, "seed": 7, "num_ctx": 4096 }
        });
        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));
        let started = Instant::now();
        let response = ureq::post(&url).timeout(self.timeout).send_json(body);
        let value: Value = match response {
            Ok(ok) => ok.into_json().map_err(|e| {
                WorkerError::new(ErrorCode::RunnerFailed, format!("모델 실행기 응답을 읽지 못했습니다: {e}"))
            })?,
            Err(ureq::Error::Status(404, resp)) => {
                let detail = resp.into_string().unwrap_or_default();
                return Err(WorkerError::new(
                    ErrorCode::ModelMissing,
                    format!("모델이 설치되어 있지 않습니다({}): {detail}", self.model),
                ));
            }
            Err(ureq::Error::Status(code, resp)) => {
                let detail = resp.into_string().unwrap_or_default();
                return Err(WorkerError::new(ErrorCode::RunnerFailed, format!("모델 실행 실패 HTTP {code}: {detail}")));
            }
            Err(ureq::Error::Transport(t)) => {
                return Err(WorkerError::new(
                    ErrorCode::RunnerUnavailable,
                    format!("모델 실행기(Ollama)에 연결할 수 없습니다({:?} 후): {t}", started.elapsed()),
                ));
            }
        };
        value["message"]["content"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| WorkerError::new(ErrorCode::InvalidModelOutput, "모델 응답에 본문이 없습니다."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_runner_urls_are_allowed() {
        assert!(ensure_loopback("http://127.0.0.1:11434").is_ok());
        assert!(ensure_loopback("http://localhost:11434/").is_ok());
        assert!(ensure_loopback("http://[::1]:11434").is_ok());
        assert!(ensure_loopback("https://api.example.com").is_err());
        assert!(ensure_loopback("http://192.168.0.2:11434").is_err());
        assert!(ensure_loopback("http://localhost.example.com:11434").is_err());
    }

    #[test]
    fn missing_whisper_binary_and_model_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("a.wav");
        std::fs::write(&wav, b"x").unwrap();
        let no_model = WhisperCli { binary: "whisper-cli".into(), model: dir.path().join("none.bin"), language: "ko".into(), prompt: None };
        assert_eq!(no_model.transcribe(&wav).unwrap_err().code, ErrorCode::SttModelMissing);

        let model = dir.path().join("model.bin");
        std::fs::write(&model, b"x").unwrap();
        let no_binary = WhisperCli { binary: dir.path().join("no-such-whisper"), model, language: "ko".into(), prompt: None };
        assert_eq!(no_binary.transcribe(&wav).unwrap_err().code, ErrorCode::SttUnavailable);
    }

    #[test]
    fn missing_kordoc_is_reader_unavailable() {
        let reader = KordocCli { binary: "/nonexistent/kordoc".into() };
        assert_eq!(reader.read(Path::new("a.pdf")).unwrap_err().code, ErrorCode::ReaderUnavailable);
    }

    #[test]
    fn unreachable_runner_is_runner_unavailable() {
        // Port 9 (discard) on loopback is closed on a normal machine; no external traffic.
        let chat = OllamaChat { base_url: "http://127.0.0.1:9".into(), model: "gemma3:1b".into(), timeout: Duration::from_secs(2) };
        let err = chat.chat_json(vec![], &json!({})).unwrap_err();
        assert_eq!(err.code, ErrorCode::RunnerUnavailable);
    }
}
