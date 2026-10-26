//! The quick window's search (local, no API), 「내 기록에 묻기」 (Claude, only over the user's own
//! entries) and 기억 notes for Obsidian.

use crate::calendar;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    /// 일정 · 할 일 · 기간 · 기억 · 비밀
    pub kind: String,
    pub title: String,
    /// When (date, time or deadline) or the detail line.
    pub sub: String,
}

fn kind_word(kind: &str) -> &'static str {
    match kind {
        "event" => "일정",
        "task" => "할 일",
        "period" => "기간",
        _ => "기억",
    }
}

/// Live entries (not cancelled, not fake data) of the saved calendar.
pub fn entries(state: &Value) -> Vec<&Value> {
    ["events", "tasks", "periods", "notes"]
        .iter()
        .flat_map(|k| state[*k].as_array().into_iter().flatten())
        .filter(|x| x["gone"] != true && x["sample"] != true)
        .collect()
}

fn when(x: &Value) -> String {
    let s = |k: &str| x[k].as_str().unwrap_or("").to_string();
    match x["kind"].as_str().unwrap_or("") {
        "event" => format!("{} {}", s("date"), x["start"].as_str().unwrap_or("종일")),
        "task" => format!("{}{}까지{}", s("due"), x["dueTime"].as_str().map(|t| format!(" {t}")).unwrap_or_default(), if x["done"] == true { " · 끝냄" } else { "" }),
        "period" => format!("{} ~ {}", s("from"), s("to")),
        _ => s("details"),
    }
}

/// Every word of the query in the title or details (case-insensitive). Titles first, newest first.
pub fn search(state: Option<&Value>, secrets: &[crate::secret::SecretName], query: &str, limit: usize) -> Vec<Hit> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(u8, String, Hit)> = Vec::new();
    if let Some(state) = state {
        for x in entries(state) {
            let title = x["title"].as_str().unwrap_or("").to_string();
            let hay = format!("{} {}", title, x["details"].as_str().unwrap_or("")).to_lowercase();
            if !words.iter().all(|w| hay.contains(w.as_str())) {
                continue;
            }
            let in_title = words.iter().all(|w| title.to_lowercase().contains(w.as_str()));
            let kind = x["kind"].as_str().unwrap_or("note");
            scored.push((u8::from(!in_title), x["createdAt"].as_str().unwrap_or("").to_string(), Hit { id: x["id"].as_str().unwrap_or("").into(), kind: kind_word(kind).into(), title, sub: when(x) }));
        }
    }
    for s in secrets {
        if words.iter().all(|w| s.name.to_lowercase().contains(w.as_str())) {
            scored.push((0, s.at.clone(), Hit { id: format!("secret:{}", s.name), kind: "비밀".into(), title: s.name.clone(), sub: "키체인 · Touch ID로 복사".into() }));
        }
    }
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    scored.into_iter().take(limit).map(|(_, _, h)| h).collect()
}

/// The user's records as short lines for 「묻기」: the ones matching the question first, then
/// the newest, up to `max_chars`. Secrets are never in the state, so never in here.
pub fn context_lines(state: &Value, question: &str, max_chars: usize) -> Vec<(String, String)> {
    let words: Vec<String> = question.split_whitespace().filter(|w| w.chars().count() >= 2).map(|w| w.to_lowercase().trim_end_matches(['?', '은', '는', '이', '가', '을', '를', '에', '요']).to_string()).collect();
    let mut rows: Vec<(usize, String, String, String)> = entries(state)
        .into_iter()
        .map(|x| {
            let title = x["title"].as_str().unwrap_or("");
            let detail = x["details"].as_str().unwrap_or("");
            let hay = format!("{title} {detail}").to_lowercase();
            let score = words.iter().filter(|w| !w.is_empty() && hay.contains(w.as_str())).count();
            let id = x["id"].as_str().unwrap_or("").to_string();
            let line = format!("[{id}] {} · {} · {}{}", kind_word(x["kind"].as_str().unwrap_or("")), when(x), title, if detail.is_empty() { String::new() } else { format!(" — {detail}") });
            (score, x["createdAt"].as_str().unwrap_or("").to_string(), id, line)
        })
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut out = Vec::new();
    let mut used = 0;
    for (_, _, id, line) in rows {
        used += line.len();
        if used > max_chars {
            break;
        }
        out.push((id, line));
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub answer: String,
    pub hits: Vec<Hit>,
}

const ASK_SYSTEM: &str = "너는 사용자의 개인 일정·할 일·기억 기록에서만 답하는 비서다. 아래 기록 목록에 있는 내용만 근거로 짧은 한국어로 답한다. 기록에 없으면 「기록에 없어요」라고만 답한다. 추측하지 않는다. 근거가 된 기록의 [id]를 ids에 넣는다.";

/// One small Claude call over the given lines (`[id] …`), same budget and usage log as the
/// analyzer. Returns the answer and the ids it used. The caller never puts secret values in.
pub fn ask_lines(question: &str, lines: &[String]) -> Result<(String, Vec<String>), String> {
    use crate::worker::runners::ChatModel;
    let config = crate::worker::config::WorkerConfig::from_env().map_err(|e| e.message)?;
    let chat = crate::worker::claude::ClaudeChat::new(&config.claude_model, "low");
    let today = chrono::Local::now().format("%Y-%m-%d (%a)").to_string();
    let body = format!("오늘: {today}\n기록:\n{}\n\n질문: {question}", lines.join("\n"));
    let schema = json!({"type":"object","properties":{"answer":{"type":"string"},"ids":{"type":"array","items":{"type":"string"}}},"required":["answer","ids"]});
    let raw = chat.chat_json(vec![json!({"role":"system","content":ASK_SYSTEM}), json!({"role":"user","content":body})], &schema).map_err(|e| e.message)?;
    let v: Value = serde_json::from_str(&raw).map_err(|_| "AI 답을 읽지 못했습니다.".to_string())?;
    let ids = v["ids"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
    Ok((v["answer"].as_str().unwrap_or("").to_string(), ids))
}

/// 「내 기록에 묻기」: one Claude call over the user's own lines (same budget and usage log).
pub fn ask(dir: &Path, question: &str) -> Result<Answer, String> {
    let state = calendar::load_state(dir).map_err(|e| e.to_string())?.unwrap_or(Value::Null);
    let lines = context_lines(&state, question, 12_000);
    if lines.is_empty() {
        return Ok(Answer { answer: "아직 기록이 없어요.".into(), hits: Vec::new() });
    }
    let (answer, ids) = ask_lines(question, &lines.iter().map(|(_, l)| l.clone()).collect::<Vec<_>>())?;
    let v = json!({ "answer": answer });
    let hits = entries(&state)
        .into_iter()
        .filter(|x| x["id"].as_str().is_some_and(|id| ids.iter().any(|i| i == id)))
        .map(|x| Hit { id: x["id"].as_str().unwrap_or("").into(), kind: kind_word(x["kind"].as_str().unwrap_or("")).into(), title: x["title"].as_str().unwrap_or("").into(), sub: when(x) })
        .collect();
    Ok(Answer { answer: v["answer"].as_str().unwrap_or("").to_string(), hits })
}

/// An Obsidian note under `<블랙홀>/노트/` for the local answer index (title, start of the body).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteDoc {
    /// Path under `노트/` (shown as where the answer came from).
    pub path: String,
    pub title: String,
    pub text: String,
    /// YYYY-MM-DD of the last change.
    pub date: String,
}

const NOTE_LIMIT: usize = 3000;
const NOTE_CHARS: usize = 1200;

/// Read one note: no front matter, at most NOTE_CHARS characters of the body.
pub fn note_doc(root: &Path, path: &Path) -> Option<NoteDoc> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(path).ok()?.take(16 * 1024).read_to_end(&mut buf).ok()?;
    let raw = String::from_utf8_lossy(&buf);
    let body = if let Some(rest) = raw.strip_prefix("---\n") { rest.split_once("\n---").map(|(_, b)| b).unwrap_or(rest) } else { &raw };
    let text: String = body.trim().chars().take(NOTE_CHARS).collect();
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let date = chrono::DateTime::<chrono::Local>::from(modified).format("%Y-%m-%d").to_string();
    let rel = path.strip_prefix(root.join("노트")).ok()?.to_string_lossy().to_string();
    Some(NoteDoc { path: rel, title: path.file_stem()?.to_string_lossy().to_string(), text, date })
}

/// Every `.md` under `<root>/노트/` (newest first, at most NOTE_LIMIT). Read again only when a
/// file's modified time changed.
pub fn scan_notes(root: &Path) -> Vec<NoteDoc> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::SystemTime;
    static CACHE: Mutex<Option<HashMap<std::path::PathBuf, (SystemTime, NoteDoc)>>> = Mutex::new(None);
    let mut files = Vec::new();
    let mut stack = vec![root.join("노트")];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if name.ends_with(".md") {
                if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                    files.push((m, p));
                }
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(NOTE_LIMIT);
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    let out: Vec<NoteDoc> = files
        .iter()
        .filter_map(|(m, p)| match cache.get(p) {
            Some((t, d)) if t == m => Some(d.clone()),
            _ => {
                let d = note_doc(root, p)?;
                cache.insert(p.clone(), (*m, d.clone()));
                Some(d)
            }
        })
        .collect();
    out
}

fn safe_name(s: &str) -> String {
    s.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n') { ' ' } else { c }).collect::<String>().trim().chars().take(40).collect()
}

/// A 기억 as an Obsidian note: `<블랙홀>/노트/기억/YYYY-MM-DD 제목.md` (never overwrites).
pub fn write_memo_note(root: &Path, text: &str) -> Result<std::path::PathBuf, String> {
    let now = chrono::Local::now();
    let title = safe_name(text.lines().next().unwrap_or("기억"));
    let dir = root.join("노트").join("기억");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut path = dir.join(format!("{} {}.md", now.format("%Y-%m-%d"), if title.is_empty() { "기억".into() } else { title.clone() }));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{} {} ({n}).md", now.format("%Y-%m-%d"), title));
        n += 1;
    }
    let body = format!("---\n종류: 기억\n받은 시각: {}\n출처: Mac 빠른 입력\n---\n\n{}\n", now.format("%Y-%m-%dT%H:%M"), text.trim());
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Value {
        json!({
            "events": [{"id":"e1","kind":"event","title":"치과 예약","date":"2026-10-28","start":"15:00","createdAt":"2026-10-26T10:00"},
                       {"id":"e2","kind":"event","title":"가짜 회의","date":"2026-10-28","start":"09:00","createdAt":"2026-10-26T10:00","sample":true}],
            "tasks": [{"id":"t1","kind":"task","title":"지마켓 반품","details":"반품 기한 11월 2일","due":"2026-11-02","dueTime":null,"done":false,"createdAt":"2026-10-25T09:00"}],
            "periods": [], "notes": [{"id":"n1","kind":"note","title":"교무실 와이파이","details":"공유기는 책장 뒤","createdAt":"2026-10-20T09:00","gone":true}]
        })
    }

    #[test]
    fn local_search_needs_every_word_and_skips_fake_and_cancelled() {
        let s = state();
        let secrets = vec![crate::secret::SecretName { name: "지마켓 비번".into(), at: "2026-10-26T11:00".into() }];
        let hits = search(Some(&s), &secrets, "지마켓", 8);
        assert_eq!(hits.iter().map(|h| h.kind.as_str()).collect::<Vec<_>>(), vec!["비밀", "할 일"]);
        assert_eq!(hits[1].sub, "2026-11-02까지");
        assert!(search(Some(&s), &[], "반품 기한", 8)[0].id == "t1", "details are searched too");
        assert!(search(Some(&s), &[], "회의", 8).is_empty(), "fake data hidden");
        assert!(search(Some(&s), &[], "와이파이", 8).is_empty(), "cancelled hidden");
        assert!(search(Some(&s), &[], "  ", 8).is_empty());
    }

    #[test]
    fn ask_context_puts_matching_records_first() {
        let lines = context_lines(&state(), "지마켓 반품 기한이 언제야?", 10_000);
        assert_eq!(lines[0].0, "t1");
        assert!(lines[0].1.contains("반품 기한 11월 2일"));
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn notes_are_indexed_without_front_matter() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_memo_note(dir.path(), "지마켓 반품은 11월 2일까지\n택배 기사님께 맡김").unwrap();
        std::fs::create_dir_all(dir.path().join("노트").join(".숨김")).unwrap();
        std::fs::write(dir.path().join("노트").join(".숨김").join("x.md"), "숨김").unwrap();
        let notes = scan_notes(dir.path());
        assert_eq!(notes.len(), 1);
        assert!(notes[0].path.starts_with("기억"));
        assert!(notes[0].text.starts_with("지마켓 반품은"));
        assert!(!notes[0].text.contains("종류: 기억"));
        assert_eq!(scan_notes(dir.path()), notes, "second scan comes from the cache");
        assert!(p.exists());
    }

    #[test]
    fn memo_notes_go_to_the_memory_folder() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_memo_note(dir.path(), "학교 행정실 내선 1234").unwrap();
        let b = write_memo_note(dir.path(), "학교 행정실 내선 1234").unwrap();
        assert!(a.starts_with(dir.path().join("노트").join("기억")));
        assert_ne!(a, b);
        assert!(std::fs::read_to_string(&a).unwrap().contains("종류: 기억"));
    }
}
