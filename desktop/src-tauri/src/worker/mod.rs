//! Local analysis worker: audio, text, documents and images become proposal JSON
//! using only models on this machine (whisper.cpp, kordoc, Gemma via Ollama on loopback).
//! No Google, Calendar or other network access. The desktop app (stage 2) and the
//! `blackhole-worker` CLI share this module.

pub mod config;
pub mod dates;
pub mod error;
pub mod extract;
pub mod inbox;
pub mod notes;
pub mod pipeline;
pub mod proposal;
pub mod queue;
pub mod runners;
pub mod source;
