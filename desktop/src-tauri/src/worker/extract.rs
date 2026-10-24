//! Prompt, output schema and strict validation of Gemma extraction results.

use super::{
    dates::{mentions_date, mentions_time, quoted_in, resolve},
    error::{ErrorCode, WorkerError},
    proposal::{Evidence, ProposalItem},
};
use chrono::{DateTime, FixedOffset};
use serde_json::{json, Map, Value};

pub const MAX_ITEMS: usize = 20;

const SYSTEM_PROMPT: &str = "너는 한국어 메모·지시·문서를 일정, 할 일, 기억할 정보로 정리하는 도구다. 입력은 말로 한 지시, 받아 적은 음성, 공문·안내문·사진에서 뽑은 글일 수 있다. JSON 하나로만 답한다.
- summary: 입력 전체를 한 줄로 요약.
- items: 입력에 들어 있는 일을 하나씩 나눠 담는다. 한 입력에 여러 일이 있으면 모두 따로 적고, 정리할 것이 없으면 빈 목록.
  - kind: 정해진 때에 가거나 만나거나 참석하는 일(회의, 상담, 수업, 약속, 진료, 행사 등)은 \"SCHEDULE\", 내가 끝내야 하는 행동(제출, 구매, 연락, 준비, 신청 등, 마감 포함)은 \"TODO\", 나중에 다시 볼 사실·정보(\"기억해 둬\", 장소, 준비물, 결정 사항, 연락처 등)는 \"NOTE\".
  - area: 학교 일(학생, 학부모, 수업, 담임, 교무, 시험, 생활기록부, 교직원, 학년, 동아리, 공문 등)은 \"SCHOOL\", 그 밖은 \"PERSONAL\".
  - title: 날짜·시간과 \"추가해 줘\", \"기억해 줘\" 같은 부탁 말을 뺀 짧은 제목. 원문에 있는 말을 쓴다.
  - details: 장소, 준비물, 대상 같은 덧붙일 정보. 없으면 \"\".
  - dateText: 원문의 날짜 표현을 글자 그대로 옮긴다(예: \"내일\", \"다음 주 화요일\", \"11월 3일\"). 날짜를 계산하거나 바꾸지 않는다. 없으면 \"\".
  - timeText: 원문의 시간 표현을 글자 그대로 옮긴다(예: \"오후 3시\", \"10시 반\"). 없으면 \"\".
  - evidence: 그 항목의 근거가 된 원문 구절.
  - confidence: 0과 1 사이 숫자. 애매하면 낮게.";

fn direct_instruction(media: &str) -> String {
    format!(
        "첨부한 {media}의 말이나 글자를 먼저 transcript에 있는 그대로 옮겨 적고, 그 글을 기준으로 summary와 items를 채워라. 말소리나 글자가 없으면 transcript를 \"\"로 둔다."
    )
}

/// JSON schema passed to the runner as a structured-output constraint.
pub fn output_schema(with_transcript: bool) -> Value {
    let item = json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["SCHEDULE", "TODO", "NOTE"] },
            "area": { "type": "string", "enum": ["PERSONAL", "SCHOOL"] },
            "title": { "type": "string" },
            "details": { "type": "string" },
            "dateText": { "type": "string" },
            "timeText": { "type": "string" },
            "evidence": { "type": "string" },
            "confidence": { "type": "number" }
        },
        "required": ["kind", "area", "title", "details", "dateText", "timeText", "evidence", "confidence"]
    });
    let mut properties = json!({
        "summary": { "type": "string" },
        "items": { "type": "array", "items": item }
    });
    let mut required = vec!["summary", "items"];
    if with_transcript {
        properties["transcript"] = json!({ "type": "string" });
        required.insert(0, "transcript");
    }
    json!({ "type": "object", "properties": properties, "required": required })
}

const FEW_SHOT_INPUTS: [&str; 2] = [
    "다음 주 월요일 오전 10시에 교무 회의 있고 그 전에 회의 자료 인쇄해야 돼",
    "우리 집 와이파이 공유기는 거실 책장 뒤에 있다는 거 기억해 줘",
];

/// Phrases whisper (and audio LLMs) are known to invent from noise or silence.
/// Distinctive ones match anywhere in a short transcript; generic ones only when alone.
const HALLUCINATIONS: [&str; 7] = [
    "시청해주셔서감사합니다", "구독과좋아요", "자막제공", "한글자막", "뉴스스토리", "MBC뉴스", "다음영상에서만나요",
];
const HALLUCINATIONS_ALONE: [&str; 3] = ["감사합니다", "안녕", "네"];

/// True when `text` is nothing but a known noise hallucination, or a copy of a prompt example.
pub fn looks_invented(text: &str) -> bool {
    let squash = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let squashed = squash(text);
    let length = squashed.chars().count();
    length < 2
        || FEW_SHOT_INPUTS.iter().any(|e| squash(e) == squashed)
        || HALLUCINATIONS_ALONE.contains(&squashed.as_str())
        || HALLUCINATIONS.iter().any(|h| squashed.contains(h) && length <= h.chars().count() + 8)
}

fn few_shot() -> Vec<Value> {
    let example = |user: &str, answer: Value| {
        vec![json!({"role": "user", "content": user}), json!({"role": "assistant", "content": answer.to_string()})]
    };
    let mut messages = example(
        FEW_SHOT_INPUTS[0],
        json!({"summary":"교무 회의와 자료 인쇄","items":[
            {"kind":"SCHEDULE","area":"SCHOOL","title":"교무 회의","details":"","dateText":"다음 주 월요일","timeText":"오전 10시","evidence":"다음 주 월요일 오전 10시에 교무 회의 있고","confidence":0.9},
            {"kind":"TODO","area":"SCHOOL","title":"회의 자료 인쇄","details":"교무 회의 전에","dateText":"","timeText":"","evidence":"회의 자료 인쇄해야 돼","confidence":0.8}]}),
    );
    messages.extend(example(
        FEW_SHOT_INPUTS[1],
        json!({"summary":"공유기 위치 기억","items":[
            {"kind":"NOTE","area":"PERSONAL","title":"와이파이 공유기 위치","details":"거실 책장 뒤","dateText":"","timeText":"","evidence":"와이파이 공유기는 거실 책장 뒤에 있다","confidence":0.9}]}),
    ));
    messages
}

pub fn text_messages(source_text: &str) -> Vec<Value> {
    let mut messages = vec![json!({"role": "system", "content": SYSTEM_PROMPT})];
    messages.extend(few_shot());
    messages.push(json!({"role": "user", "content": source_text}));
    messages
}

/// `media` is "음성" or "이미지". Ollama carries Gemma 4 audio and images in `images`.
pub fn direct_messages(media: &str, base64: String) -> Vec<Value> {
    let mut messages = vec![json!({"role": "system", "content": format!("{SYSTEM_PROMPT}\n- transcript: 들은 말이나 읽은 글 전체.")})];
    messages.extend(few_shot());
    messages.push(json!({"role": "user", "content": direct_instruction(media), "images": [base64]}));
    messages
}

/// Splits long document text on line boundaries so each LLM call stays small.
pub fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let line_chars = line.chars().count();
        if !current.is_empty() && current.chars().count() + line_chars + 1 > max_chars {
            chunks.push(std::mem::take(&mut current));
        }
        if line_chars > max_chars {
            let chars: Vec<char> = line.chars().collect();
            for piece in chars.chunks(max_chars) {
                chunks.push(piece.iter().collect());
            }
            continue;
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Validated model answer. Item dates come from code, not from the model.
#[derive(Debug, Clone, PartialEq)]
pub struct Extraction {
    /// Present only for engine B (the model's own transcript).
    pub transcript: Option<String>,
    pub summary: String,
    pub items: Vec<ProposalItem>,
}

fn invalid(message: impl Into<String>) -> WorkerError {
    WorkerError::new(ErrorCode::InvalidModelOutput, message)
}

fn string_field<'a>(object: &'a Map<String, Value>, key: &str, at: &str) -> Result<&'a str, WorkerError> {
    match object.get(key) {
        Some(Value::String(value)) => Ok(value.as_str()),
        Some(other) => Err(invalid(format!("{at}{key}가 문자열이 아닙니다: {other}"))),
        None => Err(invalid(format!("{at}{key} 항목이 없습니다."))),
    }
}

fn validate_item(value: &Value, index: usize, source_text: &str, single_item: bool, reference: DateTime<FixedOffset>) -> Result<ProposalItem, WorkerError> {
    let at = format!("items[{index}].");
    let object = value.as_object().ok_or_else(|| invalid(format!("{at} 객체가 아닙니다.")))?;
    let kind = string_field(object, "kind", &at)?;
    if !matches!(kind, "SCHEDULE" | "TODO" | "NOTE") {
        return Err(invalid(format!("{at}kind 값이 잘못되었습니다: {kind}")));
    }
    let area = string_field(object, "area", &at)?;
    if !matches!(area, "PERSONAL" | "SCHOOL") {
        return Err(invalid(format!("{at}area 값이 잘못되었습니다: {area}")));
    }
    let mut title = string_field(object, "title", &at)?.trim().to_string();
    if title.is_empty() {
        return Err(invalid(format!("{at}title이 비어 있습니다.")));
    }
    let details = string_field(object, "details", &at)?.trim().to_string();
    let date_text = string_field(object, "dateText", &at)?.trim().to_string();
    let time_text = string_field(object, "timeText", &at)?.trim().to_string();
    let mut sentence = string_field(object, "evidence", &at)?.trim().to_string();
    let confidence = object
        .get("confidence")
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid(format!("{at}confidence가 숫자가 아닙니다.")))?;
    if !(0.0..=1.0).contains(&confidence) {
        return Err(invalid(format!("{at}confidence가 0~1 밖입니다: {confidence}")));
    }

    let mut reasons = Vec::new();
    if title.chars().count() > 80 {
        title = title.chars().take(80).collect::<String>().trim().to_string();
        reasons.push("제목이 길어 80자로 줄임".to_string());
    }
    let date_text = if quoted_in(source_text, &date_text) {
        date_text
    } else {
        reasons.push(format!("원문에 없는 날짜 표현을 버림: 「{date_text}」"));
        String::new()
    };
    let time_text = if quoted_in(source_text, &time_text) {
        time_text
    } else {
        reasons.push(format!("원문에 없는 시간 표현을 버림: 「{time_text}」"));
        String::new()
    };
    if !quoted_in(source_text, &sentence) {
        reasons.push("근거 문장이 원문과 달라 버림".to_string());
        sentence.clear();
    }
    // A phrase the model skipped is flagged, never filled in. With a single item the
    // whole source is its context; otherwise only its own evidence sentence.
    if kind != "NOTE" {
        let context = if single_item { source_text } else { sentence.as_str() };
        if date_text.is_empty() && mentions_date(context, reference.date_naive()) {
            reasons.push("원문에 날짜가 있는데 추출되지 않음".to_string());
        }
        if time_text.is_empty() && mentions_time(context) {
            reasons.push("원문에 시간이 있는데 추출되지 않음".to_string());
        }
    }

    let resolved = resolve(&date_text, &time_text, kind, reference);
    reasons.extend(resolved.review_reasons);
    let iso = |d: Option<DateTime<FixedOffset>>| d.map(|d| d.to_rfc3339()).unwrap_or_default();
    let needs_review = !reasons.is_empty();
    Ok(ProposalItem {
        kind: kind.to_string(),
        area: area.to_string(),
        title,
        details,
        start_at: iso(resolved.start_at),
        end_at: iso(resolved.end_at),
        reminder_at: iso(resolved.reminder_at),
        evidence: Evidence { sentence, date_text, time_text },
        confidence: if needs_review { confidence.min(0.5) } else { confidence },
        needs_review,
        review_reasons: reasons,
    })
}

/// Parses raw model output. Shape errors fail the job; nothing is filled in by guessing.
/// `source_text` is `None` for engine B, where the text comes from the model's `transcript`.
pub fn validate(raw: &str, source_text: Option<&str>, reference: DateTime<FixedOffset>) -> Result<Extraction, WorkerError> {
    let value: Value = serde_json::from_str(raw.trim()).map_err(|e| invalid(format!("JSON이 아닙니다: {e}")))?;
    let object = value.as_object().ok_or_else(|| invalid("JSON 객체가 아닙니다."))?;

    let transcript = match source_text {
        Some(_) => None,
        None => {
            let text = string_field(object, "transcript", "")?.trim().to_string();
            if text.is_empty() || looks_invented(&text) {
                return Err(WorkerError::new(ErrorCode::EmptyAudio, format!("받아 적은 말이 없거나 지어낸 문장입니다: 「{text}」")));
            }
            Some(text)
        }
    };
    let text = source_text.map(str::to_owned).or_else(|| transcript.clone()).unwrap_or_default();
    let summary = string_field(object, "summary", "")?.trim().to_string();
    let items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("items가 목록이 아닙니다."))?;
    if items.len() > MAX_ITEMS {
        return Err(invalid(format!("항목이 너무 많습니다: {}개(최대 {MAX_ITEMS})", items.len())));
    }
    let items = items
        .iter()
        .enumerate()
        .map(|(index, item)| validate_item(item, index, &text, items.len() == 1, reference))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Extraction { transcript, summary, items })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-10-21T09:00:00+09:00").unwrap()
    }

    const TEXT: &str = "내일 오후 3시에 학부모 상담 일정 추가해줘.";

    fn item() -> Value {
        json!({"kind":"SCHEDULE","area":"SCHOOL","title":"학부모 상담","details":"","dateText":"내일","timeText":"오후 3시","evidence":"학부모 상담","confidence":0.9})
    }

    fn answer(items: Vec<Value>) -> Value {
        json!({"summary":"상담 일정","items":items})
    }

    #[test]
    fn valid_output_resolves_dates_in_code() {
        let e = validate(&answer(vec![item()]).to_string(), Some(TEXT), reference()).unwrap();
        let first = &e.items[0];
        assert_eq!(first.start_at, "2026-10-22T15:00:00+09:00");
        assert_eq!(first.end_at, "2026-10-22T16:00:00+09:00");
        assert!(!first.needs_review);
        assert_eq!(first.confidence, 0.9);
    }

    #[test]
    fn several_items_and_notes_are_kept() {
        let text = "내일 오후 3시에 학부모 상담 있고, 상담 자료는 교무실 책상 위에 있어.";
        let note = json!({"kind":"NOTE","area":"SCHOOL","title":"상담 자료 위치","details":"교무실 책상 위","dateText":"","timeText":"","evidence":"상담 자료는 교무실 책상 위에 있어","confidence":0.8});
        let e = validate(&answer(vec![item(), note]).to_string(), Some(text), reference()).unwrap();
        assert_eq!(e.items.len(), 2);
        assert_eq!(e.items[1].kind, "NOTE");
        assert_eq!(e.items[1].start_at, "");
        assert!(!e.items[1].needs_review);
    }

    #[test]
    fn empty_item_list_is_valid() {
        let e = validate(&answer(vec![]).to_string(), Some("안녕"), reference()).unwrap();
        assert!(e.items.is_empty());
    }

    #[test]
    fn format_errors_fail_instead_of_guessing() {
        let with = |f: &dyn Fn(&mut Value)| {
            let mut v = item();
            f(&mut v);
            answer(vec![v]).to_string()
        };
        let cases: Vec<(String, &str)> = vec![
            ("not json".into(), "JSON이 아닙니다"),
            ("[1,2]".into(), "객체가 아닙니다"),
            (json!({"summary":"x"}).to_string(), "items"),
            (json!({"items":[]}).to_string(), "summary"),
            (with(&|v| v["kind"] = json!("MEETING")), "kind"),
            (with(&|v| v["area"] = json!("WORK")), "area"),
            (with(&|v| v["title"] = json!("  ")), "title"),
            (with(&|v| { v.as_object_mut().unwrap().remove("timeText"); }), "timeText"),
            (with(&|v| v["dateText"] = json!(20261022)), "dateText"),
            (with(&|v| v["confidence"] = json!("high")), "confidence"),
            (with(&|v| v["confidence"] = json!(7)), "confidence"),
            (answer(vec![item(); MAX_ITEMS + 1]).to_string(), "너무 많습니다"),
        ];
        for (raw, needle) in cases {
            let err = validate(&raw, Some(TEXT), reference()).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidModelOutput, "{raw}");
            assert!(err.message.contains(needle), "{raw} -> {}", err.message);
        }
    }

    #[test]
    fn invented_date_is_dropped_and_flagged() {
        let mut v = item();
        v["dateText"] = json!("모레");
        let e = validate(&answer(vec![v]).to_string(), Some(TEXT), reference()).unwrap();
        let first = &e.items[0];
        assert_eq!(first.evidence.date_text, "");
        assert_eq!(first.start_at, "2026-10-21T15:00:00+09:00");
        assert!(first.review_reasons.iter().any(|r| r.contains("원문에 없는 날짜")));
        assert!(first.confidence <= 0.5);
    }

    #[test]
    fn missed_date_is_flagged_not_filled() {
        let mut v = item();
        v["dateText"] = json!("");
        v["timeText"] = json!("");
        v["evidence"] = json!("내일 오후 3시에 학부모 상담");
        let e = validate(&answer(vec![v]).to_string(), Some(TEXT), reference()).unwrap();
        assert_eq!(e.items[0].start_at, "");
        assert!(e.items[0].review_reasons.iter().any(|r| r.contains("날짜가 있는데")));
        assert!(e.items[0].review_reasons.iter().any(|r| r.contains("시간이 있는데")));
    }

    #[test]
    fn skipped_relative_day_is_flagged_even_without_evidence() {
        let text = "글피 오후 1시에 미용실 예약";
        let v = json!({"kind":"SCHEDULE","area":"PERSONAL","title":"미용실 예약","details":"","dateText":"","timeText":"오후 1시","evidence":"미용실 예약","confidence":0.9});
        let e = validate(&answer(vec![v]).to_string(), Some(text), reference()).unwrap();
        assert_eq!(e.items[0].start_at, "2026-10-21T13:00:00+09:00");
        assert!(e.items[0].needs_review);
        assert!(e.items[0].review_reasons.iter().any(|r| r.contains("날짜가 있는데")));
    }

    #[test]
    fn engine_b_requires_transcript_and_rejects_empty() {
        let raw = answer(vec![item()]).to_string();
        assert_eq!(validate(&raw, None, reference()).unwrap_err().code, ErrorCode::InvalidModelOutput);
        let mut v = answer(vec![item()]);
        v["transcript"] = json!("");
        assert_eq!(validate(&v.to_string(), None, reference()).unwrap_err().code, ErrorCode::EmptyAudio);
        v["transcript"] = json!(TEXT);
        assert_eq!(validate(&v.to_string(), None, reference()).unwrap().transcript.as_deref(), Some(TEXT));
    }

    #[test]
    fn noise_hallucinations_and_example_echoes_are_detected() {
        for text in ["시청해주셔서 감사합니다.", "감사합니다.", "한글자막 by 한효정", "2.", "", FEW_SHOT_INPUTS[1]] {
            assert!(looks_invented(text), "{text}");
        }
        for text in ["내일 오후 3시 회의", "엄마께 감사합니다 문자", "모레 치과", "도와주셔서 감사합니다 메일 보내기"] {
            assert!(!looks_invented(text), "{text}");
        }
        let mut v = answer(vec![item()]);
        v["transcript"] = json!(FEW_SHOT_INPUTS[1]);
        assert_eq!(validate(&v.to_string(), None, reference()).unwrap_err().code, ErrorCode::EmptyAudio);
    }

    #[test]
    fn long_text_is_chunked_on_lines() {
        let text = (0..10).map(|i| format!("{i}번째 줄 내용입니다")).collect::<Vec<_>>().join("\n");
        let chunks = chunk_text(&text, 40);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.chars().count() <= 40));
        assert_eq!(chunks.join("\n"), text);
        assert_eq!(chunk_text(&"가".repeat(25), 10).len(), 3);
    }

    #[test]
    fn schema_lists_required_fields() {
        assert_eq!(output_schema(false)["required"], json!(["summary", "items"]));
        assert_eq!(output_schema(true)["required"][0], "transcript");
    }
}
