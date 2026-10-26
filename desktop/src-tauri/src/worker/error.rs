use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable failure codes stored on failed jobs. Messages are Korean for the app UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InputMissing,
    InputChanged,
    EmptyAudio,
    UnsupportedAudio,
    SttUnavailable,
    SttModelMissing,
    SttFailed,
    ReaderUnavailable,
    ReaderFailed,
    EmptyDocument,
    UnsupportedInput,
    RunnerUnavailable,
    ModelMissing,
    RunnerFailed,
    InvalidModelOutput,
    Interrupted,
    Io,
    /// No Claude API key (or a wrong one): the job waits until a key is set.
    ApiKeyMissing,
    /// Claude API balance or billing problem: the job waits.
    ApiBilling,
}

impl ErrorCode {
    /// The analyzer itself is not available (model or service off, not installed): the input
    /// is fine, so the job waits instead of failing for good.
    pub fn is_waiting(self) -> bool {
        matches!(
            self,
            Self::RunnerUnavailable | Self::ModelMissing | Self::SttUnavailable | Self::SttModelMissing | Self::ReaderUnavailable | Self::ApiKeyMissing | Self::ApiBilling
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerError {
    pub code: ErrorCode,
    pub message: String,
}

impl WorkerError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl fmt::Display for WorkerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkerError {}

impl From<std::io::Error> for WorkerError {
    fn from(error: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, format!("파일 처리 실패: {error}"))
    }
}
