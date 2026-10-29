//! 넣기·질문·설정 나누기 and 근거 달린 답 (Claude, small calls): the app finds the records, the
//! model only splits the words and puts the found lines together.

use serde_json::{json, Value};

const ROUTE_SYSTEM: &str = "너는 교사의 개인 일정 비서 앱이 받은 글을 나누는 분류기다. 글을 부분으로 나누고 부분마다 무엇을 시키는지 정한다.
- put: 일정·할 일·기억으로 넣을 것, 이미 있는 일정을 옮기기·취소·완료하라는 말, 그냥 적어 두는 사실. 특정 일정 하나의 알림(「회의 10분 전에 알려줘」)도 put이다.
- ask: 사용자가 자기 기록에 대해 궁금해서 묻는 말(「진도 다 끝났는지?」 「치과 언제야」).
- setting: 앱 전체 설정을 바꾸라는 말. 바꿀 수 있는 설정(key: 값 형식): remindMinutes: 일정 알림을 시작 몇 분 전에 울릴지(숫자) · onWork: 출근 시각(HH:MM) · offWork: 퇴근 시각(HH:MM) · lunch: 점심시간(HH:MM-HH:MM) · eventMinutes: 끝 없는 일정의 기본 길이(분, 숫자) · mode: 화면 dark 또는 light. 목록에 없는 설정이면 key를 \"unknown\"으로.
규칙:
- 남이 보낸 메시지·공문을 붙여 넣은 것 안의 물음은 ask가 아니라 put이다.
- part.text는 원문을 고치지 않고 그대로 잘라 넣는다. 같은 종류가 이어지면 한 부분으로 합친다.
- ask에는 question(앞뒤 문맥을 넣어 혼자 읽어도 뜻이 통하게 다시 쓴 질문)과 terms(기록에서 찾을 짧은 검색어 5~15개: 사람·반·과목·주제와 그 비슷한 말, 「진도」라면 종료·끝·다음 시간·단원명처럼)를 준다. 「나머지 학급」처럼 가리키는 말은 같은 글에서 무엇인지 찾아 terms와 question에 풀어 쓴다.
- setting에는 key와 value(문자열)를 준다.
- 해당하지 않는 칸(question·terms·key·value)은 빈 문자열이나 빈 목록으로 둔다.";

/// 넣기·질문·설정 나누기: one small Claude call. The parts as said, with a self-contained
/// question and search words for each question.
pub fn route_text(text: &str, today: &str) -> Result<Value, String> {
    use crate::worker::runners::ChatModel;
    let config = crate::worker::config::WorkerConfig::from_env().map_err(|e| e.message)?;
    let chat = crate::worker::claude::ClaudeChat::new(&config.claude_model, "low");
    let schema = json!({"type":"object","properties":{"parts":{"type":"array","items":{"type":"object","properties":{
        "kind":{"type":"string","enum":["put","ask","setting"]},"text":{"type":"string"},"question":{"type":"string"},
        "terms":{"type":"array","items":{"type":"string"}},"key":{"type":"string"},"value":{"type":"string"}},"required":["kind","text","question","terms","key","value"]}}},"required":["parts"]});
    let raw = chat.chat_json(vec![json!({"role":"system","content":ROUTE_SYSTEM}), json!({"role":"user","content":format!("오늘: {today}\n글:\n{text}")})], &schema).map_err(|e| e.message)?;
    serde_json::from_str(&raw).map_err(|_| "AI 답을 읽지 못했습니다.".to_string())
}

const ANSWER_SYSTEM: &str = "너는 교사의 개인 비서다. 아래 기록 목록만 근거로 질문에 답한다.
- 답은 짧은 줄 여러 개로, 반·사람·날짜처럼 질문이 묻는 단위로 묶어 정리한다. 줄마다 text와 근거가 된 기록 [id]들을 ids에 넣는다.
- 기록에 없는 것은 추측하지 않는다. 물어본 대상인데 기록이 없으면 「○○: 기록 없음」처럼 쓰고 missing을 true로 한다.
- 다른 기록에서 미루어 짐작한 결론은 쓰지 않는다. 적힌 그대로만 옮긴다.
- 이 목록으로는 답할 근거가 부족해 더 오래되거나 먼 기록이 필요해 보이면 enough를 false로 한다.
- 날짜는 10/28(수)처럼 짧게 쓰고, 올해가 아닌 기록만 2025년 12/10(수)처럼 연도를 붙인다.
- 「어디까지」 「언제」처럼 지금 상태나 하나를 물으면 가장 최근(가까운) 것만 답한다. 목록을 물을 때만 늘어놓고, 그때도 12줄을 넘기지 않는다.
- 끝난 할 일(끝냄)과 지난 일은 묻지 않으면 빼고, 할 일·일정을 물으면 그 기간 것만 답한다.";

/// 질문 답하기: the found lines (`[id] …`) → answer lines, each with the ids it rests on, and
/// whether the lines were enough.
pub fn answer_lines(question: &str, lines: &[String], today: &str) -> Result<Value, String> {
    use crate::worker::runners::ChatModel;
    let config = crate::worker::config::WorkerConfig::from_env().map_err(|e| e.message)?;
    let chat = crate::worker::claude::ClaudeChat::new(&config.claude_model, "low");
        let body = format!("오늘: {today}\n기록:\n{}\n\n질문: {question}", lines.join("\n"));
    let schema = json!({"type":"object","properties":{"lines":{"type":"array","items":{"type":"object","properties":{
        "text":{"type":"string"},"ids":{"type":"array","items":{"type":"string"}},"missing":{"type":"boolean"}},"required":["text","ids","missing"]}},
        "enough":{"type":"boolean"}},"required":["lines","enough"]});
    let raw = chat.chat_json(vec![json!({"role":"system","content":ANSWER_SYSTEM}), json!({"role":"user","content":body})], &schema).map_err(|e| e.message)?;
    serde_json::from_str(&raw).map_err(|_| "AI 답을 읽지 못했습니다.".to_string())
}
