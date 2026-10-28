//! Prompt, output schema and strict validation of Gemma extraction results.

use super::{
    dates::{compact_dates, find_date_phrase, find_time_phrase, mentions_date, month_day, mentions_time, period_days, quoted_in, resolve, resolve_period_end, week_span},
    error::{ErrorCode, WorkerError},
    proposal::{Evidence, ProposalItem},
};
use chrono::{DateTime, Duration, FixedOffset, NaiveTime, TimeZone};
use serde_json::{json, Map, Value};

pub const MAX_ITEMS: usize = 20;
pub const MAX_SUBTASKS: usize = 20;
/// 「AI 제안」 steps kept per to-do.
pub const MAX_SUGGESTED: usize = 5;

const SYSTEM_PROMPT: &str = "너는 한국어 메모·지시·문서를 일정, 할 일, 기억할 정보로 정리하는 도구다. 입력은 말로 한 지시, 받아 적은 음성, 공문·안내문·사진에서 뽑은 글일 수 있다. JSON 하나로만 답한다.
- summary: 입력 전체를 한 줄로 요약.
- items: 입력에 들어 있는 일을 하나씩 나눠 담는다. 한 입력에 여러 일이 있으면 모두 따로 적고, 정리할 것이 없으면 빈 목록.
  - kind: 정해진 때에 가거나 만나거나 참석하는 일(회의, 상담, 수업, 약속, 진료, 행사 등, \"~에 가야 함\"도)은 \"SCHEDULE\", 내가 끝내야 하는 행동(제출, 구매, 연락, 준비, 신청, 기안, 요청 등, 마감 포함)은 \"TODO\", 여러 날에 걸친 기간(시험 기간, 상담 주간, 방학, 챌린지 등)은 \"PERIOD\", 나중에 다시 볼 사실·정보(\"기억해 둬\", 장소, 준비물, 결정 사항, 연락처 등)는 \"NOTE\".
    날짜만 있는 학교 행사·휴일(\"11/20 재량휴업일\", \"1029 기말고사\")은 NOTE가 아니라 SCHEDULE. \"~해야 함\", \"~할 것\", \"~하기\"로 끝나는 행동은 시각이 있어도 TODO(그 시각이 마감). 이미 끝낸 일을 알리는 말(\"~함\", \"~했음\", \"완료\", \"끝\", \"진도 종료\")은 NOTE.
  - area: 학교 일(학생, 학부모, 수업, 담임, 교무, 시험, 생활기록부, 교직원, 학년, 동아리, 공문 등)은 \"SCHOOL\", 그 밖은 \"PERSONAL\".
  - title: 날짜·시간과 \"추가해 줘\", \"기억해 줘\" 같은 부탁 말을 뺀 짧은 제목. 원문에 있는 말을 쓴다. 반·학년·사람 이름처럼 일을 구별하는 말은 제목에 남긴다(\"6반 수행평가 점수 확인\", \"9반 성운부터 설명\"). 반이나 대상이 다르면 항목을 따로 나눈다. 목록 머리말(\"급식지도 일정\") 아래 줄들은 머리말과 그 줄의 말을 합쳐 제목을 짓는다(\"급식지도 (복도)\").
  - details: 장소, 준비물, 대상 같은 덧붙일 정보. 없으면 \"\".
  - dateText: 원문의 날짜 표현을 글자 그대로 옮긴다(예: \"내일\", \"다음 주 화요일\", \"11월 3일\"). 날짜를 계산하거나 바꾸지 않는다. 없으면 \"\".
  - timeText: 원문의 시간 표현을 글자 그대로 옮긴다(예: \"오후 3시\", \"10시 반\", \"1620\", \"16:20~21:20\", \"16202120\"). 숫자만 쓴 시각도 시간 표현이다. 없으면 \"\".
  - endDateText: PERIOD일 때 끝 날짜 표현을 글자 그대로(예: \"6일\", \"11월 6일\"). dateText는 시작 날짜. PERIOD가 아니면 \"\".
  - subtasks: 할 일 아래 나열된 하위 할 일들을 원문 말 그대로 목록으로(예: \"보고서 제출: 자료 정리, 초안, 결재\" → [\"자료 정리\",\"초안\",\"결재\"]). 원문에 단계가 없어도 순서가 있는 일(기안·준비·제출처럼 여러 단계)이면 꼭 필요한 단계를 짧게 최대 5개까지 순서대로 제안해도 된다. 단순한 일이면 []. 한 목적을 위해 이어서 하는 행동들(\"가능한지 확인해보고, 요청하고, 신청해야 함\")은 TODO를 여러 개로 나누지 말고 마지막 목적을 제목으로 한 TODO 하나에 원문 순서대로 subtasks로 담는다.
  - waitFor: \"~되면\", \"~보고\", \"~알려주시면\", \"~오면\", \"~받고 나서\"처럼 다른 일이 먼저 있어야 시작할 수 있으면 그 조건을 짧게(예: \"병렬협조 마무리\", \"한 선생님 연락\", \"일정 확정\"). 조건 자체를 따로 일정이나 할 일로 만들지 않는다. 조건에 날짜·시간이 붙어 있으면(\"내일 9시에 연락 오는 거 보고\") 그것을 이 할 일의 dateText·timeText로 쓴다. 조건이 없으면 \"\".
  - 날짜가 아직 정해지지 않았다고 하면(\"수요일일지 목요일일지 모름\", \"미정\") dateText는 \"\".
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
            "waitFor": { "type": "string" },
            "evidence": { "type": "string" },
            "confidence": { "type": "number" }
        },
        "required": ["kind", "area", "title", "details", "dateText", "timeText", "endDateText", "subtasks", "reminderText", "waitFor", "evidence", "confidence"]
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

const FEW_SHOT_INPUTS: [&str; 4] = [
    "다음 주 월요일 오전 10시에 교무 회의 있고 그 전에 회의 자료 인쇄해야 돼",
    "우리 집 와이파이 공유기는 거실 책장 뒤에 있다는 거 기억해 줘",
    "다음 달 7일 6시까지 동아리 결과 보고서 내야 해: 사진 정리, 활동 기록, 결재. 6일 저녁 8시에 알려줘. 그리고 3일부터 5일까지는 학년 체육 주간이야",
    "1112 학부모 공개수업 / 출장 가능한지 확인해보고 출장 신청해야함 / 2반 진도 종료 / 김선생님이 자료 보내주시면 취합해서 제출",
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
            {"kind":"SCHEDULE","area":"SCHOOL","title":"교무 회의","details":"","dateText":"다음 주 월요일","timeText":"오전 10시","endDateText":"","subtasks":[],"reminderText":"","waitFor":"","evidence":"다음 주 월요일 오전 10시에 교무 회의 있고","confidence":0.9},
            {"kind":"TODO","area":"SCHOOL","title":"회의 자료 인쇄","details":"교무 회의 전에","dateText":"","timeText":"","endDateText":"","subtasks":[],"reminderText":"","waitFor":"","evidence":"회의 자료 인쇄해야 돼","confidence":0.8}]}),
    );
    messages.extend(example(
        FEW_SHOT_INPUTS[1],
        json!({"summary":"공유기 위치 기억","items":[
            {"kind":"NOTE","area":"PERSONAL","title":"와이파이 공유기 위치","details":"거실 책장 뒤","dateText":"","timeText":"","endDateText":"","subtasks":[],"reminderText":"","waitFor":"","evidence":"와이파이 공유기는 거실 책장 뒤에 있다","confidence":0.9}]}),
    ));
    messages.extend(example(
        FEW_SHOT_INPUTS[2],
        json!({"summary":"보고서 제출과 체육 주간","items":[
            {"kind":"TODO","area":"SCHOOL","title":"동아리 결과 보고서 제출","details":"","dateText":"다음 달 7일","timeText":"6시","endDateText":"","subtasks":["사진 정리","활동 기록","결재"],"reminderText":"6일 저녁 8시","waitFor":"","evidence":"다음 달 7일 6시까지 동아리 결과 보고서 내야 해","confidence":0.85},
            {"kind":"PERIOD","area":"SCHOOL","title":"학년 체육 주간","details":"","dateText":"3일","timeText":"","endDateText":"5일","subtasks":[],"reminderText":"","waitFor":"","evidence":"3일부터 5일까지는 학년 체육 주간이야","confidence":0.85}]}),
    ));
    messages.extend(example(
        FEW_SHOT_INPUTS[3],
        json!({"summary":"공개수업, 출장 신청, 진도, 자료 제출","items":[
            {"kind":"SCHEDULE","area":"SCHOOL","title":"학부모 공개수업","details":"","dateText":"1112","timeText":"","endDateText":"","subtasks":[],"reminderText":"","waitFor":"","evidence":"1112 학부모 공개수업","confidence":0.9},
            {"kind":"TODO","area":"SCHOOL","title":"출장 신청","details":"","dateText":"","timeText":"","endDateText":"","subtasks":["출장 가능한지 확인","출장 신청"],"reminderText":"","waitFor":"","evidence":"출장 가능한지 확인해보고 출장 신청해야함","confidence":0.85},
            {"kind":"NOTE","area":"SCHOOL","title":"2반 진도 종료","details":"","dateText":"","timeText":"","endDateText":"","subtasks":[],"reminderText":"","waitFor":"","evidence":"2반 진도 종료","confidence":0.9},
            {"kind":"TODO","area":"SCHOOL","title":"자료 취합해서 제출","details":"","dateText":"","timeText":"","endDateText":"","subtasks":[],"reminderText":"","waitFor":"김선생님 자료","evidence":"김선생님이 자료 보내주시면 취합해서 제출","confidence":0.85}]}),
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

/// KakaoTalk-style export lines without their message time and date header (「[오후 3:13] 김선생님: …」
/// 「오후 8:01, 교무부장 : …」 「2026년 10월 27일 화요일」 alone on a line).
fn chat_stamps_removed(text: &str) -> String {
    use std::sync::OnceLock;
    static STAMP: OnceLock<regex::Regex> = OnceLock::new();
    static HEADER: OnceLock<regex::Regex> = OnceLock::new();
    let t = STAMP
        .get_or_init(|| regex::Regex::new(r"(?m)^(\s*(?:\[[^\]\n]{1,20}\]\s*)?)(?:\[(?:오전|오후)\s*\d{1,2}:\d{2}\]|(?:오전|오후)\s*\d{1,2}:\d{2},)\s*").unwrap())
        .replace_all(text, "$1");
    HEADER
        .get_or_init(|| regex::Regex::new(r"(?m)^\s*-*\s*\d{4}년\s*\d{1,2}월\s*\d{1,2}일\s*[월화수목금토일]요일\s*-*\s*$").unwrap())
        .replace_all(&t, "")
        .into_owned()
}

/// A reminder said against the start: 「30분 전」 「1시간 전」 「하루 전」/「전날」 (same time, or 「전날 저녁 8시」 at that
/// time) · 「3일 전」 · 「일주일 전」. None when it is not that kind of phrase.
fn reminder_before(text: &str, time: &str, start: DateTime<FixedOffset>, reference: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
    use std::sync::OnceLock;
    static MIN: OnceLock<regex::Regex> = OnceLock::new();
    static HOUR: OnceLock<regex::Regex> = OnceLock::new();
    static DAYS: OnceLock<regex::Regex> = OnceLock::new();
    let t = text.replace("한 시간", "1시간").replace("두 시간", "2시간").replace("세 시간", "3시간").replace("반 시간", "30분");
    if let Some(c) = MIN.get_or_init(|| regex::Regex::new(r"(\d{1,3})\s*분\s*(?:전|일찍)").unwrap()).captures(&t) {
        return Some(start - Duration::minutes(c[1].parse().ok()?));
    }
    if let Some(c) = HOUR.get_or_init(|| regex::Regex::new(r"(\d{1,2})\s*시간\s*(?:전|일찍)").unwrap()).captures(&t) {
        return Some(start - Duration::hours(c[1].parse().ok()?));
    }
    let days = if t.contains("일주일 전") || t.contains("1주일 전") || t.contains("한 주 전") {
        7
    } else if t.contains("하루 전") || t.contains("전날") {
        1
    } else if let Some(c) = DAYS.get_or_init(|| regex::Regex::new(r"(\d{1,2})\s*일\s*전").unwrap()).captures(&t) {
        c[1].parse().ok()?
    } else if t.contains("당일") {
        0
    } else {
        return None;
    };
    let day = start - Duration::days(days);
    if time.is_empty() {
        return Some(day);
    }
    // 「전날 저녁 8시」: that clock time on that day.
    let at = resolve(&format!("{}월 {}일", day.format("%-m"), day.format("%-d")), time, "SCHEDULE", reference).start_at?;
    Some(reference.offset().from_local_datetime(&day.date_naive().and_time(at.time())).single()?)
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

/// True when `needle` starts a line (or a 「/」 part of one) of `source`: 「1029 3학년 기말고사」.
fn line_head(source: &str, needle: &str) -> bool {
    source.lines().flat_map(|l| l.split('/')).any(|part| part.trim_start().starts_with(needle))
}

/// 「수요일일지 목요일일지 알지 못함」 「날짜 미정」 「일정 확정되면」: the day is not known yet.
fn unsure_date(text: &str) -> bool {
    use std::sync::OnceLock;
    static UNSURE: OnceLock<regex::Regex> = OnceLock::new();
    UNSURE.get_or_init(|| regex::Regex::new(r"(?:일지|인지).{0,15}(?:일지|인지)|모름|모르겠|알지\s*못|미정|확정되면|정해지면").unwrap()).is_match(text)
}

/// Days counted back right after the date phrase: 「11월 13일 축제 일주일 전에」 → 7, 「… 전날」 → 1.
/// Not when that phrase is the reminder (「일주일 전에 알려줘」).
fn days_before_said(context: &str, date_text: &str, reminder_text: &str) -> Option<i64> {
    use std::sync::OnceLock;
    static BEFORE: OnceLock<regex::Regex> = OnceLock::new();
    if date_text.is_empty() {
        return None;
    }
    let before = BEFORE.get_or_init(|| regex::Regex::new(r"^\s*(?:[가-힣A-Za-z0-9]+\s+)?(?:(일주일|한\s*주|(\d+)\s*주)|(하루|이틀|사흘|나흘|(\d+)\s*일))\s*전(?:에|까지)?|^\s*(?:[가-힣A-Za-z0-9]+\s+)?(전날)").unwrap());
    // The phrase may be inside the date the model quoted (「11월 13일 축제 일주일 전」) or right after it.
    let inside = date_text.char_indices().filter(|&(_, ch)| ch == ' ').map(|(i, _)| &date_text[i..]).find(|tail| before.is_match(tail));
    let after = match inside {
        Some(tail) => tail,
        None => &context[context.find(date_text)? + date_text.len()..],
    };
    let c = before.captures(after)?;
    if !reminder_text.is_empty() && reminder_text.contains(c[0].trim()) {
        return None;
    }
    Some(if c.get(1).is_some() {
        7 * c.get(2).and_then(|n| n.as_str().parse::<i64>().ok()).unwrap_or(1)
    } else if let Some(word) = c.get(3) {
        c.get(4).and_then(|n| n.as_str().parse().ok()).unwrap_or(match word.as_str() { "하루" => 1, "이틀" => 2, "사흘" => 3, _ => 4 })
    } else {
        1
    })
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
    let mut end_date_text = optional_string(object, "endDateText", &at)?;
    let reminder_text = optional_string(object, "reminderText", &at)?;
    let wait_for = optional_string(object, "waitFor", &at)?;
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
    // 「1029 3학년 기말고사」: the model rightly says 「10월 29일」, which the source writes as 1029.
    let compact = compact_dates(source_text);
    let mut date_text = if quoted_in(source_text, &date_text) || month_day(&date_text).is_some_and(|md| compact.contains(&md)) {
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
    // 「1029 3학년 기말고사」 「1209~1210 기말고사」 at the head of a line, given only as the time: the
    // day (the owner writes school days that way; a time is 「오늘 1620~2120」 「0740~1240」 after a day).
    if date_text.is_empty() && !time_text.is_empty() {
        let digits_only = time_text.chars().all(|c| c.is_ascii_digit() || c.is_whitespace() || matches!(c, '~' | '-' | '–'));
        if digits_only && !compact_dates(&time_text).is_empty() && line_head(source_text, &time_text) {
            date_text = std::mem::take(&mut time_text);
        }
    }
    // 「1209~1210」 as a period's start: its end is the second day.
    if kind == "PERIOD" && end_date_text.is_empty() {
        if let [_, (m, d)] = compact_dates(&date_text)[..] {
            end_date_text = format!("{m}월 {d}일");
        }
    }
    // 「수요일일지 목요일일지 모름」: not a date yet.
    let unsure = unsure_date(if single_item { source_text } else { sentence.as_str() });
    if unsure && !date_text.is_empty() && ["일지", "인지"].iter().any(|w| source_text.contains(&format!("{date_text}{w}"))) {
        date_text.clear();
    }
    // The same 「1029」 (or 「1209~1210」) given as the time too: it is the day, not 10:29.
    if let Some(md) = month_day(&date_text) {
        let runs = compact_dates(&time_text);
        let digits_only = time_text.chars().all(|c| c.is_ascii_digit() || c.is_whitespace() || matches!(c, '~' | '-' | '–'));
        if digits_only && runs.first() == Some(&md) {
            time_text.clear();
        }
    }
    // 「금요일 퇴근하고 7시 영화」: a bare morning hour after 퇴근 is the evening (it came out 07:00).
    let bare_hour = time_text.trim_end_matches(['에', ' ']).strip_suffix('시').and_then(|h| h.trim().parse::<u32>().ok());
    if bare_hour.is_some_and(|h| (5..12).contains(&h)) && ["퇴근하고", "퇴근 후", "퇴근후", "퇴근해서", "퇴근하면"].iter().any(|w| sentence.contains(w) || (single_item && source_text.contains(w))) {
        time_text = format!("저녁 {time_text}");
    }
    // An end phrase not in the source loses to a length said in the sentence (it wrote 「일주일 뒤」 for
    // 「일주일 동안」 and the period got 8 days); it still counts otherwise (「6일까지」 written as 「11월 6일」).
    let end_said = quoted_in(source_text, &end_date_text);
    if !quoted_in(source_text, &sentence) {
        reasons.push("근거 문장이 원문과 달라 버림".to_string());
        sentence.clear();
    }
    // A phrase the model skipped is always flagged. With `fill_missing` the code
    // resolver's own phrase from the context is used, still under review. With a single
    // item the whole source is its context; otherwise only its own evidence sentence.
    if kind != "NOTE" {
        // Chat exports carry each message's own time (「[오후 3:13] 김선생님:」 「오후 8:01, 교무부장 :」): not the item's.
        let cleaned = chat_stamps_removed(if single_item { source_text } else { sentence.as_str() });
        let context = cleaned.as_str();
        if date_text.is_empty() && !unsure && mentions_date(context, reference.date_naive()) {
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

    // Steps the source names stay as they are; steps the model added are kept apart as
    // 「AI 제안」 (at most MAX_SUGGESTED, in order) instead of being dropped. Dates and times
    // are still checked strictly against the source above — only steps are let through.
    let mut subtasks = Vec::new();
    let mut suggested_subtasks = Vec::new();
    for sub in raw_subtasks.into_iter().filter(|s| !s.is_empty()) {
        if quoted_in(source_text, &sub) {
            if subtasks.len() == MAX_SUBTASKS {
                reasons.push(format!("하위 할 일이 많아 {MAX_SUBTASKS}개까지만 둠"));
                break;
            }
            subtasks.push(sub);
        } else if suggested_subtasks.len() < MAX_SUGGESTED && kind == "TODO" {
            suggested_subtasks.push(sub);
        }
    }

    let iso = |d: Option<DateTime<FixedOffset>>| d.map(|d| d.to_rfc3339()).unwrap_or_default();
    let (start, end, mut reminders) = if kind == "PERIOD" {
        // Whole days: first day 00:00 until the day after the last. The end is resolved
        // against the start ("3일부터 6일까지"); without one the period is a single day.
        let midnight = |day: chrono::NaiveDate| reference.offset().from_local_datetime(&day.and_time(NaiveTime::MIN)).single();
        // 「다음 주 내내」: that week's weekdays.
        let week = if end_date_text.is_empty() { week_span(&date_text, reference.date_naive()) } else { None };
        let first = if week.is_some() { super::dates::ResolvedSchedule::default() } else { resolve(&date_text, "", "TODO", reference) };
        reasons.extend(first.review_reasons);
        // 「3일간」 「사흘 동안」 「일주일 동안」 (in the end phrase or the sentence): start + length − 1.
        let length = period_days(&end_date_text).or_else(|| period_days(&sentence)).or_else(|| period_days(&title));
        match (week, first.start_at) {
            (Some((a, b)), _) => (midnight(a), midnight(b + Duration::days(1)), Vec::new()),
            (None, Some(first_at)) => {
                let start_day = first_at.date_naive();
                let by_length = length.map(|n| start_day + Duration::days(n - 1));
                let end_day = match by_length.filter(|_| end_date_text.is_empty() || !end_said || period_days(&end_date_text).is_some()).or_else(|| resolve_period_end(&end_date_text, start_day)).or(by_length) {
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
                (midnight(start_day), midnight(end_day + Duration::days(1)), Vec::new())
            }
            (None, None) => (None, None, Vec::new()),
        }
    } else {
        let mut resolved = resolve(&date_text, &time_text, kind, reference);
        reasons.extend(resolved.review_reasons.drain(..));
        // 「11월 13일 축제 일주일 전에 부스 신청」: counted back from the day said.
        if kind == "TODO" {
            let context = if single_item { source_text } else { sentence.as_str() };
            if let (Some(at), Some(n)) = (resolved.start_at, days_before_said(context, &date_text, &reminder_text)) {
                resolved.start_at = Some(at - Duration::days(n));
                resolved.end_at = resolved.end_at.map(|e| e - Duration::days(n));
            }
        }
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
            // 「30분 전에 알려줘」 「하루 전에 알림」 「전날 저녁 8시」: from the item's own start (2026-10-28 밤샘: these
            // were 「알림 때를 해석하지 못함」 and the default reminder stayed).
            let time = find_time_phrase(&reminder_text).unwrap_or_default();
            let relative = start.and_then(|at| reminder_before(&reminder_text, &time, at, reference));
            relative.or_else(|| {
                let date = find_date_phrase(&reminder_text).unwrap_or_default();
                if time.is_empty() { None } else { resolve(&date, &time, "SCHEDULE", reference).start_at }
            })
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
        suggested_subtasks,
        wait_for,
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
        let keep = |sub: &String| {
            let sub = squash(sub);
            sub != own && !titles.iter().any(|t| *t == sub)
        };
        item.subtasks.retain(keep);
        item.suggested_subtasks.retain(keep);
    }
    items
}

/// 「내일 9시에 한 선생님 연락 오는 거 보고 … 게시」: the condition is the to-do's 「기다림」, not an
/// appointment of its own. A schedule named after what a to-do waits for goes; its day and time
/// become the to-do's when it had none.
fn fold_waited_schedules(mut items: Vec<ProposalItem>) -> Vec<ProposalItem> {
    const GENERIC: [&str; 6] = ["일정", "자료", "명단", "학교", "선생님", "확정"];
    let mut i = 0;
    while i < items.len() {
        let key = items[i].wait_for.split_whitespace().next().unwrap_or("").trim_end_matches("선생님").trim_end_matches("T").to_string();
        let waits = items[i].kind == "TODO" && key.chars().count() >= 2 && !GENERIC.contains(&key.as_str());
        let found = if waits { items.iter().position(|x| x.kind == "SCHEDULE" && x.title.contains(key.as_str())) } else { None };
        if let Some(j) = found {
            let gone = items.remove(j);
            let at = if j < i { i - 1 } else { i };
            let todo = &mut items[at];
            if todo.start_at.is_empty() {
                todo.start_at = gone.start_at;
                todo.end_at = gone.end_at;
                todo.reminder_at = gone.reminder_at;
                todo.reminders = gone.reminders;
                todo.evidence.date_text = gone.evidence.date_text;
                todo.evidence.time_text = gone.evidence.time_text;
            }
            i = at;
        }
        i += 1;
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
    Ok(Extraction { transcript, summary, items: fold_waited_schedules(drop_echoed_subtasks(items)) })
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
    fn chat_message_times_are_not_item_times() {
        let text = "[오후 3:12] 김선생님: 내일 학년회의 4시로 바뀌었어요\n[오후 3:13] 김선생님: 회의 자료 미리 출력 부탁드려요";
        assert_eq!(chat_stamps_removed(text), "김선생님: 내일 학년회의 4시로 바뀌었어요\n김선생님: 회의 자료 미리 출력 부탁드려요");
        assert_eq!(chat_stamps_removed("2026년 10월 27일 화요일\n오후 8:01, 교무부장 : 노트북 지참"), "\n교무부장 : 노트북 지참");
        assert_eq!(chat_stamps_removed("[김선생님] [오후 3:12] 자료 출력"), "[김선생님] 자료 출력");
        // A plain line that starts with a time is not a chat stamp.
        assert_eq!(chat_stamps_removed("오후 3:30 회의"), "오후 3:30 회의");
    }

    #[test]
    fn reminders_said_against_the_start() {
        // reference(): Wednesday 2026-10-21 09:00.
        let one = |text: &str, date: &str, time: &str, rem: &str| {
            let v = json!({"kind":"SCHEDULE","area":"PERSONAL","title":"치과","details":"","dateText":date,"timeText":time,"endDateText":"","subtasks":[],"reminderText":rem,"evidence":text,"confidence":0.9});
            let e = validate(&answer(vec![v]).to_string(), Some(text), reference()).unwrap();
            (e.items[0].reminders.clone(), e.items[0].review_reasons.clone())
        };
        assert_eq!(one("내일 3시 치과 30분 전에 알려줘", "내일", "3시", "30분 전"), (vec!["2026-10-22T14:30:00+09:00".to_string()], vec![]));
        assert_eq!(one("내일 3시 치과 한 시간 전에 알려줘", "내일", "3시", "한 시간 전").0, vec!["2026-10-22T14:00:00+09:00"]);
        assert_eq!(one("금요일 3시 치과 하루 전에 알림", "금요일", "3시", "하루 전").0, vec!["2026-10-22T15:00:00+09:00"]);
        assert_eq!(one("금요일 3시 치과 전날 저녁 8시에 알려줘", "금요일", "3시", "전날 저녁 8시").0, vec!["2026-10-22T20:00:00+09:00"]);
        assert_eq!(one("금요일 3시 치과 목요일 9시에 알려줘", "금요일", "3시", "목요일 9시").0, vec!["2026-10-22T09:00:00+09:00"]);
    }

    #[test]
    fn period_lengths_weeks_and_a_made_up_end() {
        // reference(): Wednesday 2026-10-21.
        let one = |text: &str, date: &str, end: &str| {
            let v = json!({"kind":"PERIOD","area":"SCHOOL","title":"기간","details":"","dateText":date,"timeText":"","endDateText":end,"subtasks":[],"reminderText":"","evidence":text,"confidence":0.8});
            let e = validate(&answer(vec![v]).to_string(), Some(text), reference()).unwrap();
            (e.items[0].start_at[..10].to_string(), e.items[0].end_at[..10].to_string())
        };
        let s = |a: &str, b: &str| (a.to_string(), b.to_string());
        // 「일주일 뒤」 is not in the text: the said length wins (7 days, not 8).
        assert_eq!(one("오늘부터 일주일 동안 독서 주간", "오늘", "일주일 뒤"), s("2026-10-21", "2026-10-28"));
        assert_eq!(one("3일간 연수 11월 4일부터", "11월 4일", ""), s("2026-11-04", "2026-11-07"));
        assert_eq!(one("다음 주 내내 공개수업 주간", "다음 주", ""), s("2026-10-26", "2026-10-31"));
        // The model's 「11월 6일」 for 「6일까지」 still ends it.
        assert_eq!(one("11월 3일부터 6일까지 상담 주간", "11월 3일", "11월 6일"), s("2026-11-03", "2026-11-07"));
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
        // A step the source does not say is kept apart as 「AI 제안」, not a reason for review.
        assert_eq!(t.suggested_subtasks, vec!["명단 출력"]);
        assert!(!t.review_reasons.iter().any(|r| r.contains("하위 할 일")));
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

    /// 2026-10-28 실제 입력: 「1029 3학년 기말고사 … 1209~1210 기말고사 … 1221 복도」. The model said
    /// 「10월 29일」 and gave 「1029」 as the time: it went in as 10:29 tomorrow, date dropped.
    #[test]
    fn compact_month_day_list_is_days_not_times() {
        let text = "1029 3학년 기말고사\n1030 3학년 기말고사\n1113 대왕제\n1209~1210 기말고사\n\n급식지도 일정\n1221 복도";
        let it = |kind: &str, title: &str, date: &str, time: &str, ev: &str| json!({"kind":kind,"area":"SCHOOL","title":title,"details":"","dateText":date,"timeText":time,"evidence":ev,"confidence":0.9});
        let raw = json!({"summary":"학사 일정","items":[
            it("SCHEDULE", "3학년 기말고사", "10월 29일", "1029", "1029 3학년 기말고사"),
            it("SCHEDULE", "대왕제", "1113", "", "1113 대왕제"),
            it("PERIOD", "기말고사", "12월 9일", "", "1209~1210 기말고사"),
            it("SCHEDULE", "급식지도 (복도)", "12월 21일", "1221", "1221 복도"),
        ]}).to_string();
        let e = validate(&raw, Some(text), reference()).unwrap();
        let day = |i: usize| e.items[i].start_at.clone();
        assert!(day(0).starts_with("2026-10-29"), "{}", day(0));
        assert!(e.items[0].evidence.time_text.is_empty());
        assert!(day(1).starts_with("2026-11-13"), "{}", day(1));
        assert!(day(2).starts_with("2026-12-09"), "{}", day(2));
        assert!(day(3).starts_with("2026-12-21"), "{}", day(3));
        for x in &e.items {
            assert!(!x.review_reasons.iter().any(|r| r.contains("원문에 없는 날짜")), "{:?}", x.review_reasons);
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

    fn said(kind: &str, title: &str, date: &str, time: &str, evidence: &str) -> Value {
        json!({"kind":kind,"area":"SCHOOL","title":title,"details":"","dateText":date,"timeText":time,"endDateText":"","subtasks":[],"reminderText":"","waitFor":"","evidence":evidence,"confidence":0.9})
    }

    #[test]
    fn owner_style_glued_days_at_a_line_head_are_days() {
        let text = "1029 3학년 기말고사\n1209~1210 기말고사\n오늘 1620~2120 초과근무";
        let items = vec![
            said("SCHEDULE", "3학년 기말고사", "", "1029", "1029 3학년 기말고사"),
            said("PERIOD", "기말고사", "", "1209~1210", "1209~1210 기말고사"),
            said("SCHEDULE", "초과근무", "오늘", "1620~2120", "오늘 1620~2120 초과근무"),
        ];
        let e = validate(&answer(items).to_string(), Some(text), reference()).unwrap();
        assert!(e.items[0].start_at.starts_with("2026-10-29"), "{}", e.items[0].start_at);
        assert_eq!(e.items[0].evidence.time_text, "");
        assert_eq!(e.items[1].start_at, "2026-12-09T00:00:00+09:00");
        assert_eq!(e.items[1].end_at, "2026-12-11T00:00:00+09:00");
        assert_eq!(e.items[2].start_at, "2026-10-21T16:20:00+09:00");
        assert_eq!(e.items[2].end_at, "2026-10-21T21:20:00+09:00");
    }

    #[test]
    fn a_day_not_decided_yet_is_not_filled_in() {
        let text = "인사자문위원회 안내 메세지 일정 확정되면 보내기(지금은 수요일일지 목요일일지 알지 못함)";
        for date in ["수요일", ""] {
            let e = validate(&answer(vec![said("TODO", "인사자문위원회 안내 메세지 보내기", date, "", text)]).to_string(), Some(text), reference()).unwrap();
            assert_eq!(e.items[0].start_at, "", "dateText 「{date}」");
            assert!(!e.items[0].review_reasons.iter().any(|r| r.contains("날짜")), "{:?}", e.items[0].review_reasons);
        }
    }

    #[test]
    fn days_counted_back_from_the_day_said() {
        let text = "11월 13일 축제 일주일 전에 부스 신청 받기";
        for date in ["11월 13일", "11월 13일 축제 일주일 전"] {
            let e = validate(&answer(vec![said("TODO", "부스 신청 받기", date, "", text)]).to_string(), Some(text), reference()).unwrap();
            assert!(e.items[0].start_at.starts_with("2026-11-06"), "dateText 「{date}」: {}", e.items[0].start_at);
        }
        let text = "11월 13일 축제 전날 풍선 사기";
        let e = validate(&answer(vec![said("TODO", "풍선 사기", "11월 13일", "", text)]).to_string(), Some(text), reference()).unwrap();
        assert!(e.items[0].start_at.starts_with("2026-11-12"));
    }

    #[test]
    fn what_a_to_do_waits_for_is_not_an_appointment() {
        let text = "내일 9시에 한지수선생님께 연락오는거 보고 수행평가 안내문 게시";
        let call = said("SCHEDULE", "한지수 선생님 연락 확인", "내일", "9시", "내일 9시에 한지수선생님께 연락오는거 보고");
        let mut post = said("TODO", "수행평가 안내문 게시", "", "", "수행평가 안내문 게시");
        post["waitFor"] = json!("한지수 선생님 연락");
        let e = validate(&answer(vec![call, post]).to_string(), Some(text), reference()).unwrap();
        assert_eq!(e.items.len(), 1);
        assert_eq!(e.items[0].kind, "TODO");
        assert_eq!(e.items[0].wait_for, "한지수 선생님 연락");
        assert_eq!(e.items[0].start_at, "2026-10-22T09:00:00+09:00");
    }

    #[test]
    fn schema_lists_required_fields() {
        assert_eq!(output_schema(false)["required"], json!(["summary", "items"]));
        assert_eq!(output_schema(true)["required"][0], "transcript");
    }
}
