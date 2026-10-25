//! Obsidian 「원본 노트」: one Markdown note per input, so everything thrown into
//! 블랙홀 can be found again with Obsidian search. The note links back to the kept
//! original and lists what was made from it as a checklist.

use super::proposal::{Proposal, ProposalItem};
use chrono::{DateTime, Datelike, FixedOffset, Timelike};
use std::path::{Path, PathBuf};

const DOW: [&str; 7] = ["월", "화", "수", "목", "금", "토", "일"];

/// "10. 27.(화)" and, when the instant is not midnight, " 14:00".
fn when(iso: &str) -> String {
    match DateTime::parse_from_rfc3339(iso) {
        Ok(d) => {
            let day = format!("{}. {}.({})", d.month(), d.day(), DOW[d.weekday().num_days_from_monday() as usize]);
            if d.hour() == 0 && d.minute() == 0 { day } else { format!("{day} {:02}:{:02}", d.hour(), d.minute()) }
        }
        Err(_) => String::new(),
    }
}

fn time_only(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso).map(|d| format!("{:02}:{:02}", d.hour(), d.minute())).unwrap_or_default()
}

fn same_day(a: &str, b: &str) -> bool {
    match (DateTime::parse_from_rfc3339(a), DateTime::parse_from_rfc3339(b)) {
        (Ok(a), Ok(b)) => a.date_naive() == b.date_naive(),
        _ => false,
    }
}

/// YAML double-quoted scalar (JSON escaping is valid YAML).
fn q(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// 학교 / 개인 by majority of items; 미분류 when nothing was found.
pub fn area_folder(proposal: &Proposal) -> &'static str {
    let school = proposal.items.iter().filter(|i| i.area == "SCHOOL").count();
    let personal = proposal.items.len() - school;
    match (school, personal) {
        (0, 0) => "미분류",
        (s, p) if s >= p => "학교",
        _ => "개인",
    }
}

fn clean_title(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if "/\\:*?\"<>|#^[]\n\r\t".contains(c) { ' ' } else { c })
        .collect();
    let squashed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    squashed.chars().take(40).collect::<String>().trim().to_string()
}

pub fn note_title(proposal: &Proposal, fallback: &str) -> String {
    let candidate = proposal
        .items
        .first()
        .map(|i| i.title.as_str())
        .filter(|t| !t.is_empty())
        .unwrap_or(proposal.summary.as_str());
    let title = clean_title(candidate);
    if title.is_empty() { clean_title(fallback) } else { title }
}

/// `노트/{학교|개인|미분류}/YYYY/MM/YYYY-MM-DD 제목 (해시8).md`, relative to the 블랙홀 root.
pub fn note_relative_path(proposal: &Proposal, received: DateTime<FixedOffset>, fallback_title: &str) -> PathBuf {
    let sha8 = &proposal.source.sha256[..8];
    Path::new("노트")
        .join(area_folder(proposal))
        .join(format!("{:04}", received.year()))
        .join(format!("{:02}", received.month()))
        .join(format!(
            "{:04}-{:02}-{:02} {} ({sha8}).md",
            received.year(),
            received.month(),
            received.day(),
            note_title(proposal, fallback_title)
        ))
}

fn item_lines(item: &ProposalItem) -> Vec<String> {
    let details = if item.details.is_empty() { String::new() } else { format!(" — {}", item.details) };
    let reminders = if item.reminders.is_empty() {
        String::new()
    } else {
        let list: Vec<String> = item
            .reminders
            .iter()
            .map(|r| if same_day(r, &item.start_at) { time_only(r) } else { when(r) })
            .collect();
        format!(" · 알림 {}", list.join(", "))
    };
    let mut lines = vec![match item.kind.as_str() {
        "SCHEDULE" => {
            let span = if item.start_at.is_empty() {
                "날짜 미정".to_string()
            } else {
                format!("{}–{}", when(&item.start_at), time_only(&item.end_at))
            };
            format!("- [ ] 일정 · {span} **{}**{details}{reminders}", item.title)
        }
        "TODO" => {
            let due = if item.start_at.is_empty() {
                String::new()
            } else if time_only(&item.start_at) == "09:00" && item.evidence.time_text.is_empty() {
                format!(" · {}까지", when(&item.start_at).split(' ').take(2).collect::<Vec<_>>().join(" "))
            } else {
                format!(" · {}까지", when(&item.start_at))
            };
            format!("- [ ] 할 일 · **{}**{due}{details}{reminders}", item.title)
        }
        "PERIOD" => {
            let last = DateTime::parse_from_rfc3339(&item.end_at)
                .map(|d| (d - chrono::Duration::days(1)).to_rfc3339())
                .unwrap_or_default();
            format!("- 기간 · **{}** · {} ~ {}{details}", item.title, when(&item.start_at), when(&last))
        }
        _ => format!("- 기억 · **{}**{details}", item.title),
    }];
    for sub in &item.subtasks {
        lines.push(format!("    - [ ] {sub}"));
    }
    for reason in &item.review_reasons {
        lines.push(format!("    - ※ 검토: {reason}"));
    }
    lines
}

/// The note body. `original` is the original's path relative to the 블랙홀 root.
pub fn render_note(proposal: &Proposal, original: &str, received: DateTime<FixedOffset>, origin: &str) -> String {
    let area = area_folder(proposal);
    let analysis = [
        format!("엔진 {}", match proposal.engine.id { super::proposal::EngineId::TextFirst => "A", super::proposal::EngineId::Direct => "B" }),
        proposal.engine.reader.clone(),
        proposal.engine.llm_model.clone(),
        proposal.engine.prompt_version.clone(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let title = note_title(proposal, origin);
    let mut out = vec![
        "---".to_string(),
        format!("블랙홀: {}", q(&proposal.source.sha256)),
        format!("받은 시각: {}", q(&received.to_rfc3339())),
        format!("출처: {}", q(origin)),
        format!("원본: {}", q(&format!("[[{original}]]"))),
        format!("구분: {area}"),
        "상태: 미확정".to_string(),
        format!("요약: {}", q(&proposal.summary)),
        format!("분석: {}", q(&analysis)),
        format!("tags: [블랙홀, {area}]"),
        "---".to_string(),
        String::new(),
        format!("# {title}"),
        String::new(),
    ];
    if !proposal.summary.is_empty() {
        out.push(format!("> {}", proposal.summary));
        out.push(String::new());
    }
    out.push("## 정리".to_string());
    if proposal.items.is_empty() {
        out.push("- 정리할 일정·할 일·기억을 찾지 못함".to_string());
    }
    for item in &proposal.items {
        out.extend(item_lines(item));
    }
    for reason in &proposal.review_reasons {
        out.push(format!("- ※ 검토: {reason}"));
    }
    out.push(String::new());
    out.push("## 원문".to_string());
    out.push(String::new());
    out.push(proposal.source_text.trim().to_string());
    out.push(String::new());
    out.push("## 원본".to_string());
    out.push(String::new());
    out.push(format!("![[{original}]]"));
    out.push(String::new());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::proposal::Proposal;

    fn sample() -> Proposal {
        serde_json::from_str(include_str!("../../../tests/fixtures/proposal-sample.json")).unwrap()
    }

    fn received() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-10-21T09:05:00+09:00").unwrap()
    }

    #[test]
    fn note_path_is_area_month_and_hash() {
        let p = sample();
        let path = note_relative_path(&p, received(), "fallback");
        let text = path.to_string_lossy();
        assert!(text.starts_with("노트/학교/2026/10/2026-10-21 "), "{text}");
        assert!(text.ends_with(&format!("({}).md", &p.source.sha256[..8])), "{text}");
    }

    #[test]
    fn note_lists_items_subtasks_reminders_and_original() {
        let p = sample();
        let note = render_note(&p, "원본/2026/10/abcd1234-memo.txt", received(), "인박스 · txt");
        assert!(note.starts_with("---\n블랙홀: \""));
        assert!(note.contains("상태: 미확정"));
        assert!(note.contains("- [ ] 일정 · 10. 22.(목) 15:00–16:00 **학부모 상담** · 알림 14:30"), "{note}");
        assert!(note.contains("- [ ] 할 일 · **연수 보고서 제출** · 10. 23.(금) 18:00까지 · 알림 10. 22.(목) 09:00"), "{note}");
        assert!(note.contains("    - [ ] 자료 정리"));
        assert!(note.contains("- 기간 · **상담 주간** · 11. 3.(화) ~ 11. 6.(금)"), "{note}");
        assert!(note.contains("## 원문\n\n내일 오후 3시에 학부모 상담"));
        assert!(note.contains("![[원본/2026/10/abcd1234-memo.txt]]"));
    }

    #[test]
    fn titles_are_safe_file_names() {
        assert_eq!(clean_title("a/b:c*d?\"e<f>g|h#i"), "a b c d e f g h i");
        assert_eq!(clean_title(&"가".repeat(60)).chars().count(), 40);
    }
}
