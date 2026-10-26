//! Analysis worker: audio, text, documents and images become proposal JSON.
//! Default analyzer (2026-10-26): Claude API (Claude Haiku 5.5) — text, images and PDFs go to
//! the API; HWPX·DOCX·XLSX are read to text locally (kordoc); speech is the phone's own
//! transcript or macOS speech recognition. Local models (whisper.cpp, Gemma via Ollama on
//! loopback) stay as an option, off by default. The desktop app and the `blackhole-worker`
//! CLI share this module.

pub mod claude;
pub mod config;
pub mod dates;
pub mod error;
pub mod extract;
pub mod inbox;
pub mod messenger;
pub mod notes;
pub mod pipeline;
pub mod proposal;
pub mod queue;
pub mod runners;
pub mod source;
pub mod speech;
