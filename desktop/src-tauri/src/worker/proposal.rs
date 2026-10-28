//! Proposal JSON v2: what the local worker hands to the desktop app.
//! Mirrors `desktop/src/worker/proposal.ts` and
//! `desktop/src-tauri/schemas/proposal.v2.schema.json`.

use serde::{Deserialize, Serialize};

pub const PROPOSAL_SCHEMA_VERSION: u32 = 2;
pub const PROMPT_VERSION: &str = "extract-ko-v6-change-cancel";
pub const WORKER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    /// 16-bit PCM WAV recording.
    Audio,
    /// Typed or pasted instruction text.
    Text,
    /// PDF, HWP, HWPX, DOCX, XLSX, ... read by kordoc.
    Document,
    /// PNG, JPEG, WebP photo or screenshot.
    Image,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineId {
    /// Turn the source into text first (whisper.cpp / kordoc), then a Gemma text model structures it.
    #[serde(rename = "A")]
    TextFirst,
    /// One multimodal Gemma call reads the audio or image directly.
    #[serde(rename = "B")]
    Direct,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalSource {
    #[serde(rename = "type")]
    pub source_type: SourceType,
    /// Lower-case file extension ("wav", "pdf", "hwp", "png", "txt"); no file name or path.
    pub format: String,
    /// SHA-256 of the original bytes. Used as the dedupe key.
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: EngineId,
    /// What produced `sourceText` before the LLM: whisper model, kordoc version, or "" (text / engine B).
    pub reader: String,
    pub llm_model: String,
    pub prompt_version: String,
    pub worker_version: String,
}

/// Source phrases that back an item. Every non-empty value is a substring of
/// `sourceText` (checked in code, whitespace-insensitive).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub sentence: String,
    pub date_text: String,
    pub time_text: String,
    /// End of a PERIOD ("6일", "11월 6일"). Empty otherwise.
    #[serde(default)]
    pub end_date_text: String,
    /// What the user asked to be reminded at ("목요일 9시"). Empty when not said.
    #[serde(default)]
    pub reminder_text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalItem {
    /// "SCHEDULE" | "TODO" (23-column Items values) | "NOTE" (information to remember)
    /// | "PERIOD" (several whole days: start_at = first day 00:00, end_at = day after the last).
    pub kind: String,
    /// "PERSONAL" | "SCHOOL".
    pub area: String,
    pub title: String,
    /// Extra facts worth keeping (place, materials, who). Free text from the source.
    pub details: String,
    /// ISO 8601 with offset, or "" when no date/time was stated.
    pub start_at: String,
    pub end_at: String,
    pub reminder_at: String,
    /// Every reminder instant (ISO 8601), earliest first; `reminder_at` is the first one.
    /// Ring like a phone call at each of these.
    #[serde(default)]
    pub reminders: Vec<String>,
    /// Sub-checklist under a TODO, in the source's words and order.
    #[serde(default)]
    pub subtasks: Vec<String>,
    /// Steps the model proposed that the source did not say (at most 5, in order).
    /// Kept as 「AI 제안」 steps the user can drop; never a reason for review.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggested_subtasks: Vec<String>,
    /// 「병렬협조 마무리되면 …」 「김선생님 연락 오는 거 보고 …」: what has to happen first (「기다림」).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub wait_for: String,
    /// 「치과 3시에서 4시로 바뀜」 「학년 협의회 취소됨」: "MOVE" | "CANCEL" an entry already in the
    /// calendar named by `title` (start_at = the new day/time said; empty phrases keep the old one).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub change: String,
    /// The old day/time as said (「금요일 3시」), to pick the right one among several.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub change_from: String,
    pub evidence: Evidence,
    /// Model self-reported confidence, 0.0..=1.0; capped at 0.5 when review is needed.
    pub confidence: f64,
    pub needs_review: bool,
    pub review_reasons: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    /// Speech recognition, document parsing or OCR.
    pub read_ms: u64,
    pub llm_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub schema_version: u32,
    pub source: ProposalSource,
    /// The clock the date resolver used (ISO 8601 with offset).
    pub reference_time: String,
    pub engine: EngineInfo,
    /// Transcript, typed text, or text read from the document/image.
    pub source_text: String,
    /// One-line Korean summary of the whole input.
    pub summary: String,
    pub items: Vec<ProposalItem>,
    /// True when any item needs review or nothing usable was found.
    pub needs_review: bool,
    pub review_reasons: Vec<String>,
    pub timings: Timings,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const SAMPLE: &str = include_str!("../../../tests/fixtures/proposal-sample.json");
    const SCHEMA: &str = include_str!("../../../schemas/proposal.v2.schema.json");

    fn keys(value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    fn required(value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = value["required"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_string()).collect();
        keys.sort();
        keys
    }

    #[test]
    fn sample_round_trips_and_matches_schema() {
        let proposal: Proposal = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(proposal.schema_version, PROPOSAL_SCHEMA_VERSION);
        let value = serde_json::to_value(&proposal).unwrap();
        assert_eq!(value, serde_json::from_str::<Value>(SAMPLE).unwrap());

        let schema: Value = serde_json::from_str(SCHEMA).unwrap();
        assert_eq!(keys(&value), required(&schema));
        assert_eq!(keys(&value["items"][0]), required(&schema["$defs"]["item"]));
        assert_eq!(keys(&value["source"]), required(&schema["properties"]["source"]));
        assert_eq!(keys(&value["engine"]), required(&schema["properties"]["engine"]));
        assert_eq!(keys(&value["timings"]), required(&schema["properties"]["timings"]));
    }
}
