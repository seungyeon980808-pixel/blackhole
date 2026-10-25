//! Where the worker finds its local runners and models. Every value can be
//! overridden with an environment variable; nothing here is a personal path.

use super::{
    error::{ErrorCode, WorkerError},
    extract::ExtractOptions,
    pipeline::AnalyzeOptions,
    proposal::SourceType,
    runners::{KordocCli, OllamaChat, WhisperCli},
};
use serde::Deserialize;
use std::{env, path::{Path, PathBuf}, time::Duration};

pub const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";
/// Chosen by tools/worker-eval (docs/worker-eval-results.md): best accuracy, and the same
/// file as the direct model, so one 4.6GB download serves engines A and B.
pub const DEFAULT_TEXT_MODEL: &str = "gemma4:e2b-it-q4_K_M";
pub const DEFAULT_DIRECT_MODEL: &str = "gemma4:e2b-it-q4_K_M";
pub const DEFAULT_WHISPER_MODEL_FILE: &str = "ggml-large-v3-turbo-q5_0.bin";

#[derive(Debug, Clone, PartialEq)]
pub struct WorkerConfig {
    pub ollama_url: String,
    pub text_model: String,
    pub direct_model: String,
    pub whisper_bin: PathBuf,
    pub whisper_model: PathBuf,
    pub kordoc_bin: PathBuf,
    pub llm_timeout: Duration,
    pub whisper_prompt: Option<String>,
    /// Larger model for documents and images only (`BLACKHOLE_DOCUMENT_MODEL` / `documentModel`).
    pub document_model: Option<String>,
    pub options: AnalyzeOptions,
}

/// Optional JSON file (`$BLACKHOLE_WORKER_CONFIG`, else `<models dir>/worker-config.json`).
/// Example: tools/worker-config.example.json. Personal word lists stay outside the repo.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerFileConfig {
    #[serde(default)]
    pub whisper_prompt: Option<String>,
    #[serde(default)]
    pub school_words: Vec<String>,
    #[serde(default)]
    pub personal_words: Vec<String>,
    #[serde(default)]
    pub fill_missing: Option<bool>,
    #[serde(default)]
    pub recheck_below: Option<f64>,
    #[serde(default)]
    pub image_ocr_hint: Option<bool>,
    #[serde(default)]
    pub document_model: Option<String>,
    /// Part-of-day defaults, e.g. {"저녁": "19:00"} (see dates::DEFAULT_DAYPARTS).
    #[serde(default)]
    pub dayparts: std::collections::BTreeMap<String, String>,
}

pub fn read_file_config(path: &Path) -> Result<WorkerFileConfig, WorkerError> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| WorkerError::new(ErrorCode::Io, format!("작업기 설정 파일 형식 오류({}): {e}", path.display())))
}

fn switch(name: &str) -> Option<bool> {
    env::var(name).ok().map(|v| matches!(v.trim(), "1" | "true" | "on"))
}

/// `~/.local/share/blackhole-models` on macOS/Linux, `%LOCALAPPDATA%\blackhole-models` on Windows.
pub fn models_dir() -> PathBuf {
    if let Some(dir) = env::var_os("BLACKHOLE_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local).join("blackhole-models");
        }
    }
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local").join("share").join("blackhole-models")
}

fn var_or(name: &str, default: impl Into<String>) -> String {
    env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.into())
}

impl WorkerConfig {
    /// Defaults, then the optional config file, then environment variables (used by the
    /// evaluation to switch single experiments on and off).
    pub fn from_env() -> Result<Self, WorkerError> {
        let models = models_dir();
        let file = match env::var_os("BLACKHOLE_WORKER_CONFIG") {
            Some(v) if v == "off" => WorkerFileConfig::default(),
            Some(path) => read_file_config(Path::new(&path))?,
            None => {
                let path = models.join("worker-config.json");
                if path.is_file() { read_file_config(&path)? } else { WorkerFileConfig::default() }
            }
        };
        super::dates::set_dayparts(&file.dayparts.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>());
        let words_on = env::var("BLACKHOLE_WORD_LISTS").map(|v| v != "off").unwrap_or(true);
        let options = AnalyzeOptions {
            extract: ExtractOptions {
                fill_missing: switch("BLACKHOLE_FILL_MISSING").or(file.fill_missing).unwrap_or(false),
                school_words: if words_on { file.school_words.clone() } else { Vec::new() },
                personal_words: if words_on { file.personal_words.clone() } else { Vec::new() },
            },
            recheck_below: match env::var("BLACKHOLE_RECHECK_BELOW") {
                Ok(v) if v == "off" => None,
                Ok(v) => v.parse().ok(),
                Err(_) => file.recheck_below,
            },
            image_ocr_hint: switch("BLACKHOLE_IMAGE_OCR_HINT").or(file.image_ocr_hint).unwrap_or(false),
        };
        let whisper_prompt = match env::var("BLACKHOLE_WHISPER_PROMPT") {
            Ok(v) if v == "off" || v.trim().is_empty() => None,
            Ok(v) => Some(v),
            Err(_) => file.whisper_prompt.clone(),
        };
        let kordoc_default = models.join("kordoc").join("node_modules").join(".bin").join(if cfg!(windows) { "kordoc.cmd" } else { "kordoc" });
        Ok(Self {
            ollama_url: var_or("BLACKHOLE_OLLAMA_URL", DEFAULT_OLLAMA_URL),
            text_model: var_or("BLACKHOLE_TEXT_MODEL", DEFAULT_TEXT_MODEL),
            direct_model: var_or("BLACKHOLE_DIRECT_MODEL", DEFAULT_DIRECT_MODEL),
            whisper_bin: env::var_os("BLACKHOLE_WHISPER_BIN").map(PathBuf::from).unwrap_or_else(|| {
                // tools/setup-local-models.ps1 unpacks the official Windows build here.
                let bundled = models.join("whisper-cpp").join("Release").join("whisper-cli.exe");
                if cfg!(windows) && bundled.is_file() { bundled } else { PathBuf::from("whisper-cli") }
            }),
            whisper_model: env::var_os("BLACKHOLE_WHISPER_MODEL")
                .map(PathBuf::from)
                .unwrap_or_else(|| models.join("whisper").join(DEFAULT_WHISPER_MODEL_FILE)),
            kordoc_bin: env::var_os("BLACKHOLE_KORDOC_BIN").map(PathBuf::from).unwrap_or(kordoc_default),
            llm_timeout: Duration::from_secs(var_or("BLACKHOLE_LLM_TIMEOUT_SECS", "300").parse().unwrap_or(300)),
            whisper_prompt,
            document_model: match env::var("BLACKHOLE_DOCUMENT_MODEL") {
                Ok(v) if v == "off" || v.trim().is_empty() => None,
                Ok(v) => Some(v),
                Err(_) => file.document_model.clone(),
            },
            options,
        })
    }

    pub fn whisper(&self) -> WhisperCli {
        WhisperCli { binary: self.whisper_bin.clone(), model: self.whisper_model.clone(), language: "ko".into(), prompt: self.whisper_prompt.clone() }
    }

    pub fn kordoc(&self) -> KordocCli {
        KordocCli { binary: self.kordoc_bin.clone() }
    }

    pub fn text_chat(&self) -> OllamaChat {
        OllamaChat { base_url: self.ollama_url.clone(), model: self.text_model.clone(), timeout: self.llm_timeout }
    }

    pub fn direct_chat(&self) -> OllamaChat {
        OllamaChat { base_url: self.ollama_url.clone(), model: self.direct_model.clone(), timeout: self.llm_timeout }
    }

    /// The Gemma model to use for a source: `document_model` for documents and images, if set.
    pub fn chat_for(&self, source: SourceType, direct: bool) -> OllamaChat {
        let model = match (&self.document_model, source) {
            (Some(model), SourceType::Document | SourceType::Image) => model.clone(),
            _ if direct => self.direct_model.clone(),
            _ => self.text_model.clone(),
        };
        OllamaChat { base_url: self.ollama_url.clone(), model, timeout: self.llm_timeout }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_parses_and_unknown_keys_are_rejected() {
        let example = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/worker-config.example.json");
        let parsed = read_file_config(Path::new(example)).unwrap();
        assert!(!parsed.school_words.is_empty() && !parsed.personal_words.is_empty());
        assert!(parsed.whisper_prompt.is_some());

        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, br#"{"schoolWord": []}"#).unwrap();
        assert_eq!(read_file_config(&bad).unwrap_err().code, ErrorCode::Io);
    }

    #[test]
    fn document_model_applies_to_documents_and_images_only() {
        let mut config = WorkerConfig::from_env().unwrap_or_else(|_| panic!("env config"));
        config.text_model = "t".into();
        config.direct_model = "d".into();
        config.document_model = Some("big".into());
        assert_eq!(config.chat_for(SourceType::Audio, false).model, "t");
        assert_eq!(config.chat_for(SourceType::Audio, true).model, "d");
        assert_eq!(config.chat_for(SourceType::Document, false).model, "big");
        assert_eq!(config.chat_for(SourceType::Image, true).model, "big");
        config.document_model = None;
        assert_eq!(config.chat_for(SourceType::Image, true).model, "d");
    }
}
