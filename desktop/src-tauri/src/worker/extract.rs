//! Prompt, output schema and strict validation of Gemma extraction results.

use super::{
    dates::{find_date_phrase, find_time_phrase, mentions_date, mentions_time, quoted_in, resolve, resolve_period_end},
    error::{ErrorCode, WorkerError},
    proposal::{Evidence, ProposalItem},
};
use chrono::{DateTime, Duration, FixedOffset, NaiveTime, TimeZone};
use serde_json::{json, Map, Value};

pub const MAX_ITEMS: usize = 20;
pub const MAX_SUBTASKS: usize = 20;

const SYSTEM_PROMPT: &str = "너는 한국어 메모·지시·문서를 일정, 할 일, 기억할 정보로 정리하는 도구다. 입력은 말로 한 지시, 받아 적은 음성, 공문·안내문·사진에서 뽑은 글일 수 있다. JSON 하나로만 답한다.
- summary: 입력 전체를 한 줄로 요약.
- items: 입력에 들어 있는 일을 하나씩 나눠 담는다. 한 입력에 여러 일이 있으면 모두 따로 적고, 정리할 것이 없으면 빈 목록.
  - kind: 정해진 때에 가거나 만나거나 참석하는 일(회의, 상담, 수업, 약속, 진료, 행사 등)은 \"SCHEDULE\", 내가 끝내야 하는 행동(제출, 구매, 연락, 준비, 신청 등, 마감 포함)은 \"TODO\", 여러 날에 걸친 기간(시험 기간, 상담 주간, 방학, 챌린지 등)은 \"PERIOD\", 나중에 다시 볼 사실·정보(\"기억해 둬\", 장소, 준비물, 결정 사항, 연락처 등)는 \"NOTE\".
  - area: 학교 일(학생, 학부모, 수업, 담임, 교무, 시험, 생활기록부, 교직원, 학년, 동아리, 공문 등)은 \"SCHOOL\", 그 밖은 \"PERSONAL\".
  - title: 날짜·시간과 \"추가해 줘\", \"기억해 줘\" 같은 부탁 말을 뺀 짧은 제목. 원문에 있는 말을 쓴다.
  - details: 장소, 준비물, 대상 같은 덧붙일 정보. 없으면 \"\".
  - dateText: 원문의 날짜 표현을 글자 그대로 옮긴다(예: \"내일\", \"다음 주 화요일\", \"11월 3일\"). 날짜를 계산하거나 바꾸지 않는다. 없으면 \"\".
  - timeText: 원문의 시간 표현을 글자 그대로 옮긴다(예: \"오후 3시\", \"10시 반\", \"1620\", \"16:20~21:20\", \"16202120\"). 숫자만 쓴 시각도 시간 표현이다. 없으면 \"\".
  - endDateText: PERIOD일 때 끝 날짜 표현을 글자 그대로(예: \"6일\", \"11월 6일\"). dateText는 시작 날짜. PERIOD가 아니면 \"\".
  - subtasks: 할 일 아래 나열된 하위 할 일들을 원문 말 그대로 목록으로(예: \"보고서 제출: 자료 정리, 초안, 결재\" → [\"자료 정리\",\"초안\",\"결재\"]). 없으면 [].
  - reminderText: \"~에 알려 줘\", \"~에 알림\"처럼 알림 때를 따로 말했으면 그 날짜·시간 표현을 글자 그대로(예: \"목요일 9시\"). 없으면 \"\".
  - evidence: 그 항목의 근거가 된 원문 구절.
  - confidence: 0과 1 사이 숫자. 애매하면 낮게.
받아 적은 음성에서 학년·반·교시·모둠 앞의 한글 숫자는 숫자로 고쳐 쓴다(\"오반도\" → \"5반도\", \"삼학년\" → \"3학년\", \"육교시\" → \"6교시\").";

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
            "kind": { "type": "string", "enum": ["SCHEDULE", "TODO", "NOTE", "PERIOD"] },
            "area": { "type": "string", "enum": ["PERSONAL", "SCHOOL"] },
            "title": { "type": "string" },
            "details": { "type": "string" },
            "dateText": { "type": "string" },
            "timeText": { "type": "string" },
            "endDateText": { "type": "string" },
            "subtasks": { "type": "array", "items": { "type": "string" } },
            "reminderText": { "type": "string" },
            "evidence": { "type": "string" },
            "confidence": { "type": "number" }
        },
        "required": ["kind", "area", "title", "details", "dateText", "timeText", "endDateText", "subtasks", "reminderText", "evidence", "confidence"]
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

const FEW_SHOT_INPUTS: [&str; 3] = [
    "다음 주 월요일 오전 10시에 교무 회의 있고 그 전에 회의 자료 인쇄해야 돼",
    "우리 집 와이파이 공유기는 거실 책장 뒤에 있다는 거 기억해 줘",
    "다음 달 7일 6시까지 동아리 결과 보고서 내야 해: 사진 정리, 활동 기록, 결재. 6일 저녁 8시에 알려줘. 그리고 3일부터 5일까지는 학년 체육 주간이야",
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
            {"kind":"SCHEDULE","area":"SCHOOL","title":"교무 회의","details":"","dateText":"다음 주 월요일","timeText":"오전 10시","endDateText":"","subtasks":[],"reminderText":"","evidence":"다음 주 월요일 오전 10시에 교무 회의 있고","confidence":0.9},
            {"kind":"TODO","area":"SCHOOL","title":"회의 자료 인쇄","details":"교무 회의 전에","dateText":"","timeText":"","endDateText":"","subtasks":[],"reminderText":"","evidence":"회의 자료 인쇄해야 돼","confidence":0.8}]}),
    );
    messages.extend(example(
        FEW_SHOT_INPUTS[1],
        json!({"summary":"공유기 위치 기억","items":[
            {"kind":"NOTE","area":"PERSONAL","title":"와이파이 공유기 위치","details":"거실 책장 뒤","dateText":"","timeText":"","endDateText":"","subtasks":[],"reminderText":"","evidence":"와이파이 공유기는 거실 책장 뒤에 있다","confidence":0.9}]}),
    ));
    messages.extend(example(
        FEW_SHOT_INPUTS[2],
        json!({"summary":"보고서 제출과 체육 주간","items":[
            {"kind":"TODO","area":"SCHOOL","title":"동아리 결과 보고서 제출","details":"","dateText":"다음 달 7일","timeText":"6시","endDateText":"","subtasks":["사진 정리","활동 기록","결재"],"reminderText":"6일 저녁 8시","evidence":"다음 달 7일 6시까지 동아리 결과 보고서 내야 해","confidence":0.85},
            {"kind":"PERIOD","area":"SCHOOL","title":"학년 체육 주간","details":"","dateText":"3일","timeText":"","endDateText":"5일","subtasks":[],"reminderText":"","evidence":"3일부터 5일까지는 학년 체육 주간이야","confidence":0.85}]}),
    ));
    messages
}

/// Switches for the accuracy experiments in tools/worker-eval. All off by default.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExtractOptions {
    /// Fill a date/time phrase the model skipped when the code resolver finds one in the
    /// item's context. The item is still marked for review.
    pub fill_missing: bool,
    /// The user's own vocabulary: an item mentioning only school words is SCHOOL, only
    /// personal words PERSONAL. Also shown to the model as a hint.
    pub school_words: Vec<String>,
    pub personal_words: Vec<String>,
}

fn system_prompt(options: &ExtractOptions) -> String {
    let mut prompt = SYSTEM_PROMPT.to_string();
    if !options.school_words.is_empty() || !options.personal_words.is_empty() {
        prompt.push_str(&format!(
            "\n- 이 사용자에게 학교 일인 말: {}. 개인 일인 말: {}.",
            options.school_words.join(", "),
            options.personal_words.join(", ")
        ));
    }
    prompt
}

pub fn text_messages(source_text: &str) -> Vec<Value> {
    text_messages_with(source_text, &ExtractOptions::default())
}

pub fn text_messages_with(source_text: &str, options: &ExtractOptions) -> Vec<Value> {
    let mut messages = vec![json!({"role": "system", "content": system_prompt(options)})];
    messages.extend(few_shot());
    messages.push(json!({"role": "user", "content": source_text}));
    messages
}

/// `media` is "음성" or "이미지". Ollama carries Gemma 4 audio and images in `images`.
pub fn direct_messages(media: &str, base64: String) -> Vec<Value> {
    direct_messages_with(media, base64, None, &ExtractOptions::default())
}

/// `ocr_hint`: text a separate OCR pass read from the same image, offered as a hint.
pub fn direct_messages_with(media: &str, base64: String, ocr_hint: Option<&str>, options: &ExtractOptions) -> Vec<Value> {
    let mut messages = vec![json!({"role": "system", "content": format!("{}\n- transcript: 들은 말이나 읽은 글 전체.", system_prompt(options))})];
    messages.extend(few_shot());
    let mut instruction = direct_instruction(media);
    if let Some(hint) = ocr_hint.filter(|h| !h.trim().is_empty()) {
        instruction.push_str(&format!(
            "\n참고로 글자 인식기가 같은 그림에서 읽은 글은 아래와 같다. 틀린 글자가 있을 수 있으니 그림을 보고 바로잡아 transcript에 적어라.\n---\n{hint}\n---"
        ));
    }
    messages.push(json!({"role": "user", "content": instruction, "images": [base64]}));
    messages
}

const RECHECK_INSTRUCTION: &str = "위 답을 원문과 한 줄씩 다시 대조해 고친 JSON 하나로만 답하라. 확인할 것: 원문에 있는데 빠진 일, 빠진 날짜·시간 표현(글자 그대로), 종류(SCHEDULE/TODO/NOTE), 영역(SCHOOL/PERSONAL), 원문에 없는 말.";

/// Follow-up turn asking the model to check its own first answer.
pub fn recheck_messages(mut messages: Vec<Value>, first_answer: &str) -> Vec<Value> {
    messages.push(json!({"role": "assistant", "content": first_answer}));
    messages.push(json!({"role": "user", "content": RECHECK_INSTRUCTION}));
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

/// A field added in v2. Missing means empty; a wrong type is still a format error.
fn optional_string(object: &Map<String, Value>, key: &str, at: &str) -> Result<String, WorkerError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.trim().to_string()),
        Some(other) => Err(invalid(format!("{at}{key}가 문자열이 아닙니다: {other}"))),
    }
}

fn validate_item(value: &Value, index: usize, source_text: &str, single_item: bool, reference: DateTime<FixedOffset>, options: &ExtractOptions) -> Result<ProposalItem, WorkerError> {
    let at = format!("items[{index}].");
    let object = value.as_object().ok_or_else(|| invalid(format!("{at} 객체가 아닙니다.")))?;
    let kind = string_field(object, "kind", &at)?;
    if !matches!(kind, "SCHEDULE" | "TODO" | "NOTE" | "PERIOD") {
        return Err(invalid(format!("{at}kind 값이 잘못되었습니다: {kind}")));
    }
    let mut area = string_field(object, "area", &at)?;
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
    let end_date_text = optional_string(object, "endDateText", &at)?;
    let reminder_text = optional_string(object, "reminderText", &at)?;
    let raw_subtasks: Vec<String> = match object.get("subtasks") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => list
            .iter()
            .map(|v| v.as_str().map(|s| s.trim().to_string()).ok_or_else(|| invalid(format!("{at}subtasks에 문자열이 아닌 값이 있습니다: {v}"))))
            .collect::<Result<_, _>>()?,
        Some(other) => return Err(invalid(format!("{at}subtasks가 목록이 아닙니다: {other}"))),
    };
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
    let mut date_text = if quoted_in(source_text, &date_text) {
        date_text
    } else {
        reasons.push(format!("원문에 없는 날짜 표현을 버림: 「{date_text}」"));
        String::new()
    };
    let mut time_text = if quoted_in(source_text, &time_text) {
        time_text
    } else {
        reasons.push(format!("원문에 없는 시간 표현을 버림: 「{time_text}」"));
        String::new()
    };
    if !quoted_in(source_text, &sentence) {
        reasons.push("근거 문장이 원문과 달라 버림".to_string());
        sentence.clear();
    }
    // A phrase the model skipped is always flagged. With `fill_missing` the code
    // resolver's own phrase from the context is used, still under review. With a single
    // item the whole source is its context; otherwise only its own evidence sentence.
    if kind != "NOTE" {
        let context = if single_item { source_text } else { sentence.as_str() };
        if date_text.is_empty() && mentions_date(context, reference.date_naive()) {
            match find_date_phrase(context).filter(|_| options.fill_missing) {
                Some(phrase) => {
                    reasons.push(format!("모델이 빠뜨린 날짜를 원문에서 채움: 「{phrase}」"));
                    date_text = phrase;
                }
                None => reasons.push("원문에 날짜가 있는데 추출되지 않음".to_string()),
            }
        }
        if time_text.is_empty() && mentions_time(context) {
            match find_time_phrase(context).filter(|_| options.fill_missing) {
                Some(phrase) => {
                    reasons.push(format!("모델이 빠뜨린 시간을 원문에서 채움: 「{phrase}」"));
                    time_text = phrase;
                }
                None => reasons.push("원문에 시간이 있는데 추출되지 않음".to_string()),
            }
        }
    }
    // The user's vocabulary outranks the model when it points one way only.
    let haystack = format!("{title} {details} {sentence}");
    let has = |words: &[String]| words.iter().any(|w| !w.is_empty() && haystack.contains(w.as_str()));
    match (has(&options.school_words), has(&options.personal_words)) {
        (true, false) => area = "SCHOOL",
        (false, true) => area = "PERSONAL",
        _ => {}
    }

    let mut subtasks = Vec::new();
    for sub in raw_subtasks.into_iter().filter(|s| !s.is_empty()) {
        if subtasks.len() == MAX_SUBTASKS {
            reasons.push(format!("하위 할 일이 많아 {MAX_SUBTASKS}개까지만 둠"));
            break;
        }
        if quoted_in(source_text, &sub) {
            subtasks.push(sub);
        } else {
            reasons.push(format!("원문에 없는 하위 할 일을 버림: 「{sub}」"));
        }
    }

    let iso = |d: Option<DateTime<FixedOffset>>| d.map(|d| d.to_rfc3339()).unwrap_or_default();
    let (start, end, mut reminders) = if kind == "PERIOD" {
        // Whole days: first day 00:00 until the day after the last. The end is resolved
        // against the start ("3일부터 6일까지"); without one the period is a single day.
        let first = resolve(&date_text, "", "TODO", reference);
        reasons.extend(first.review_reasons);
        match first.start_at {
            Some(first_at) => {
                let start_day = first_at.date_naive();
                let end_day = match resolve_period_end(&end_date_text, start_day) {
                    Some(day) => day,
                    None => {
                        reasons.push(if end_date_text.is_empty() {
                            "기간의 끝 날짜가 없어 하루로 둠".to_string()
                        } else {
                            format!("기간 끝 날짜를 해석하지 못함: 「{end_date_text}」")
                        });
                        start_day
                    }
                };
                let midnight = |day: chrono::NaiveDate| reference.offset().from_local_datetime(&day.and_time(NaiveTime::MIN)).single();
                (midnight(start_day), midnight(end_day + Duration::days(1)), Vec::new())
            }
            None => (None, None, Vec::new()),
        }
    } else {
        let resolved = resolve(&date_text, &time_text, kind, reference);
        reasons.extend(resolved.review_reasons);
        // Default reminder: 30 minutes before a stated time; the day's 09:00 otherwise.
        let default = match (kind, resolved.start_at) {
            ("NOTE", _) | (_, None) => Vec::new(),
            (_, Some(at)) if !time_text.is_empty() => vec![at - Duration::minutes(30)],
            (_, Some(at)) => vec![at],
        };
        (resolved.start_at, resolved.end_at, default)
    };
    if !reminder_text.is_empty() {
        let asked = if quoted_in(source_text, &reminder_text) {
            let date = find_date_phrase(&reminder_text).unwrap_or_default();
            let time = find_time_phrase(&reminder_text).unwrap_or_default();
            if time.is_empty() { None } else { resolve(&date, &time, "SCHEDULE", reference).start_at }
        } else {
            None
        };
        match asked {
            Some(at) => reminders = vec![at],
            None => reasons.push(format!("알림 때를 해석하지 못함: 「{reminder_text}」")),
        }
    }
    reminders.sort();
    let needs_review = !reasons.is_empty();
    Ok(ProposalItem {
        kind: kind.to_string(),
        area: area.to_string(),
        title,
        details,
        start_at: iso(start),
        end_at: iso(end),
        reminder_at: iso(reminders.first().copied()),
        reminders: reminders.iter().map(|r| r.to_rfc3339()).collect(),
        subtasks,
        evidence: Evidence { sentence, date_text, time_text, end_date_text, reminder_text },
        confidence: if needs_review { confidence.min(0.5) } else { confidence },
        needs_review,
        review_reasons: reasons,
    })
}

/// A sub-item that repeats its own title, or that is also listed as an item of its own
/// ("회의 있고 그 전에 출석부 정리" → meeting + to-do), is not a sub-item.
fn drop_echoed_subtasks(mut items: Vec<ProposalItem>) -> Vec<ProposalItem> {
    let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let titles: Vec<String> = items.iter().map(|i| squash(&i.title)).collect();
    for item in &mut items {
        let own = squash(&item.title);
        item.subtasks.retain(|sub| {
            let sub = squash(sub);
            sub != own && !titles.iter().any(|t| *t == sub)
        });
    }
    items
}

/// Parses raw model output. Shape errors fail the job; nothing is filled in by guessing.
/// `source_text` is `None` for engine B, where the text comes from the model's `transcript`.
pub fn validate(raw: &str, source_text: Option<&str>, reference: DateTime<FixedOffset>) -> Result<Extraction, WorkerError> {
    validate_with(raw, source_text, reference, &ExtractOptions::default())
}

pub fn validate_with(raw: &str, source_text: Option<&str>, reference: DateTime<FixedOffset>, options: &ExtractOptions) -> Result<Extraction, WorkerError> {
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
        .map(|(index, item)| validate_item(item, index, &text, items.len() == 1, reference, options))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Extraction { transcript, summary, items: drop_echoed_subtasks(items) })
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
    fn subtasks_reminder_and_period_are_resolved_in_code() {
        let text = "금요일 오후 6시까지 연수 보고서 제출: 자료 정리, 소감 작성, 결재. 목요일 9시에 알려줘. 그리고 11월 3일부터 6일까지 상담 주간이야";
        let todo = json!({"kind":"TODO","area":"SCHOOL","title":"연수 보고서 제출","details":"","dateText":"금요일","timeText":"오후 6시","endDateText":"","subtasks":["자료 정리","소감 작성","결재"],"reminderText":"목요일 9시","evidence":"금요일 오후 6시까지 연수 보고서 제출","confidence":0.9});
        let period = json!({"kind":"PERIOD","area":"SCHOOL","title":"상담 주간","details":"","dateText":"11월 3일","timeText":"","endDateText":"6일","subtasks":[],"reminderText":"","evidence":"11월 3일부터 6일까지 상담 주간이야","confidence":0.9});
        let e = validate(&answer(vec![todo, period]).to_string(), Some(text), reference()).unwrap();
        let t = &e.items[0];
        assert_eq!(t.start_at, "2026-10-23T18:00:00+09:00");
        assert_eq!(t.subtasks, vec!["자료 정리", "소감 작성", "결재"]);
        assert_eq!(t.reminders, vec!["2026-10-22T09:00:00+09:00"]);
        assert_eq!(t.reminder_at, "2026-10-22T09:00:00+09:00");
        assert!(!t.needs_review, "{:?}", t.review_reasons);
        let p = &e.items[1];
        assert_eq!(p.kind, "PERIOD");
        assert_eq!(p.start_at, "2026-11-03T00:00:00+09:00");
        assert_eq!(p.end_at, "2026-11-07T00:00:00+09:00");
        assert!(p.reminders.is_empty());
    }

    #[test]
    fn default_reminders_and_invented_subtasks() {
        let e = validate(&answer(vec![item()]).to_string(), Some(TEXT), reference()).unwrap();
        // A stated time rings 30 minutes before.
        assert_eq!(e.items[0].reminders, vec!["2026-10-22T14:30:00+09:00"]);
        let mut v = item();
        v["kind"] = json!("TODO");
        v["subtasks"] = json!(["상담 일정", "명단 출력"]);
        v["reminderText"] = json!("모레 8시");
        let e = validate(&answer(vec![v]).to_string(), Some(TEXT), reference()).unwrap();
        let t = &e.items[0];
        assert_eq!(t.subtasks, vec!["상담 일정"]);
        assert!(t.review_reasons.iter().any(|r| r.contains("원문에 없는 하위 할 일")));
        assert!(t.review_reasons.iter().any(|r| r.contains("알림 때를 해석하지 못함")));
        assert_eq!(t.reminders, vec!["2026-10-22T14:30:00+09:00"], "falls back to the default reminder");
    }

    #[test]
    fn subtasks_that_repeat_item_titles_are_dropped() {
        let text = "내일 오후 2시에 학년 회의 있고 회의 전에 출석부 정리해야 돼";
        let meeting = json!({"kind":"SCHEDULE","area":"SCHOOL","title":"학년 회의","details":"","dateText":"내일","timeText":"오후 2시","endDateText":"","subtasks":["출석부 정리"],"reminderText":"","evidence":"내일 오후 2시에 학년 회의 있고","confidence":0.9});
        let todo = json!({"kind":"TODO","area":"SCHOOL","title":"출석부 정리","details":"","dateText":"","timeText":"","endDateText":"","subtasks":["출석부 정리"],"reminderText":"","evidence":"출석부 정리해야 돼","confidence":0.9});
        let e = validate(&answer(vec![meeting, todo]).to_string(), Some(text), reference()).unwrap();
        assert!(e.items[0].subtasks.is_empty());
        assert!(e.items[1].subtasks.is_empty());
    }

    #[test]
    fn period_without_end_is_one_day_and_reviewed() {
        let text = "11월 3일 상담 주간 시작";
        let v = json!({"kind":"PERIOD","area":"SCHOOL","title":"상담 주간","details":"","dateText":"11월 3일","timeText":"","endDateText":"","subtasks":[],"reminderText":"","evidence":"","confidence":0.7});
        let e = validate(&answer(vec![v]).to_string(), Some(text), reference()).unwrap();
        assert_eq!(e.items[0].end_at, "2026-11-04T00:00:00+09:00");
        assert!(e.items[0].needs_review);
    }

    #[test]
    fn new_fields_with_wrong_types_fail() {
        let mut v = item();
        v["subtasks"] = json!("자료 정리");
        assert_eq!(validate(&answer(vec![v]).to_string(), Some(TEXT), reference()).unwrap_err().code, ErrorCode::InvalidModelOutput);
        let mut v = item();
        v["reminderText"] = json!(9);
        assert_eq!(validate(&answer(vec![v]).to_string(), Some(TEXT), reference()).unwrap_err().code, ErrorCode::InvalidModelOutput);
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
    fn fill_missing_uses_code_phrase_and_keeps_review() {
        let text = "글피 오후 1시에 미용실 예약";
        let v = json!({"kind":"SCHEDULE","area":"PERSONAL","title":"미용실 예약","details":"","dateText":"","timeText":"","evidence":"미용실 예약","confidence":0.9});
        let on = ExtractOptions { fill_missing: true, ..Default::default() };
        let e = validate_with(&answer(vec![v.clone()]).to_string(), Some(text), reference(), &on).unwrap();
        let item = &e.items[0];
        assert_eq!(item.start_at, "2026-10-24T13:00:00+09:00");
        assert_eq!(item.evidence.date_text, "글피");
        assert!(item.needs_review && item.confidence <= 0.5);
        assert!(item.review_reasons.iter().any(|r| r.contains("날짜를 원문에서 채움")));
        // Off: same answer stays empty and flagged.
        let off = validate(&answer(vec![v]).to_string(), Some(text), reference()).unwrap();
        assert_eq!(off.items[0].start_at, "");
        // NOTE items are never given a date.
        let note = json!({"kind":"NOTE","area":"PERSONAL","title":"메모","details":"","dateText":"","timeText":"","evidence":"","confidence":0.9});
        assert_eq!(validate_with(&answer(vec![note]).to_string(), Some(text), reference(), &on).unwrap().items[0].start_at, "");
    }

    #[test]
    fn word_lists_override_area_only_when_unambiguous() {
        let opts = ExtractOptions { school_words: vec!["세특".into(), "학년".into()], personal_words: vec!["헬스".into()], ..Default::default() };
        let item = |title: &str, area: &str| json!({"kind":"TODO","area":area,"title":title,"details":"","dateText":"","timeText":"","evidence":"","confidence":0.9});
        let area_of = |title: &str, area: &str| {
            validate_with(&answer(vec![item(title, area)]).to_string(), Some(title), reference(), &opts).unwrap().items[0].area.clone()
        };
        assert_eq!(area_of("세특 입력", "PERSONAL"), "SCHOOL");
        assert_eq!(area_of("헬스 등록", "SCHOOL"), "PERSONAL");
        assert_eq!(area_of("학년 헬스 모임", "PERSONAL"), "PERSONAL");
        assert_eq!(area_of("장보기", "SCHOOL"), "SCHOOL");
        assert!(system_prompt(&opts).contains("세특"));
        assert!(!system_prompt(&ExtractOptions::default()).contains("이 사용자에게"));
    }

    #[test]
    fn ocr_hint_and_recheck_messages() {
        let m = direct_messages_with("이미지", "AAAA".into(), Some("11월 3일 회의"), &ExtractOptions::default());
        assert!(m.last().unwrap()["content"].as_str().unwrap().contains("11월 3일 회의"));
        let r = recheck_messages(text_messages("내일 회의"), "{}");
        assert_eq!(r[r.len() - 2]["role"], "assistant");
        assert_eq!(r.last().unwrap()["role"], "user");
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
