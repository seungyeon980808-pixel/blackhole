//! Where the worker finds its local runners and models. Every value can be
//! overridden with an environment variable; nothing here is a personal path.

use super::runners::{KordocCli, OllamaChat, WhisperCli};
use std::{env, path::PathBuf, time::Duration};

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
}

/// `~/.local/share/ya-models` on macOS/Linux, `%LOCALAPPDATA%\ya-models` on Windows.
pub fn models_dir() -> PathBuf {
    if let Some(dir) = env::var_os("YA_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local).join("ya-models");
        }
    }
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local").join("share").join("ya-models")
}

fn var_or(name: &str, default: impl Into<String>) -> String {
    env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.into())
}

impl WorkerConfig {
    pub fn from_env() -> Self {
        let models = models_dir();
        let kordoc_default = models.join("kordoc").join("node_modules").join(".bin").join(if cfg!(windows) { "kordoc.cmd" } else { "kordoc" });
        Self {
            ollama_url: var_or("YA_OLLAMA_URL", DEFAULT_OLLAMA_URL),
            text_model: var_or("YA_TEXT_MODEL", DEFAULT_TEXT_MODEL),
            direct_model: var_or("YA_DIRECT_MODEL", DEFAULT_DIRECT_MODEL),
            whisper_bin: env::var_os("YA_WHISPER_BIN").map(PathBuf::from).unwrap_or_else(|| {
                // tools/setup-local-models.ps1 unpacks the official Windows build here.
                let bundled = models.join("whisper-cpp").join("Release").join("whisper-cli.exe");
                if cfg!(windows) && bundled.is_file() { bundled } else { PathBuf::from("whisper-cli") }
            }),
            whisper_model: env::var_os("YA_WHISPER_MODEL")
                .map(PathBuf::from)
                .unwrap_or_else(|| models.join("whisper").join(DEFAULT_WHISPER_MODEL_FILE)),
            kordoc_bin: env::var_os("YA_KORDOC_BIN").map(PathBuf::from).unwrap_or(kordoc_default),
            llm_timeout: Duration::from_secs(var_or("YA_LLM_TIMEOUT_SECS", "300").parse().unwrap_or(300)),
        }
    }

    pub fn whisper(&self) -> WhisperCli {
        WhisperCli { binary: self.whisper_bin.clone(), model: self.whisper_model.clone(), language: "ko".into() }
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
}
