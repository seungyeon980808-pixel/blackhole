//! Deterministic Korean date/time resolution.
//!
//! The model only quotes the date and time phrases it heard ("다음 주 화요일",
//! "오후 3시"). This module turns those phrases into instants against an explicit
//! reference time, using the same rules as the Android `KoreanCommandParser`.
//! Anything it cannot resolve stays empty with a review reason; it never guesses.

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveTime, TimeZone, Timelike, Weekday};
use regex::Regex;
use std::sync::{OnceLock, RwLock};

/// Default clock time for a part of the day said without an hour ("저녁에"). Marked
/// 「대략 시각」 for review. Overridable with `dayparts` in worker-config.json.
pub const DEFAULT_DAYPARTS: [(&str, &str); 8] = [
    ("새벽", "05:00"),
    ("아침", "08:00"),
    ("오전", "09:00"),
    ("점심", "12:00"),
    ("낮", "13:00"),
    ("오후", "15:00"),
    ("저녁", "18:00"),
    ("밤", "21:00"),
];

static DAYPARTS: RwLock<Vec<(String, NaiveTime)>> = RwLock::new(Vec::new());

/// Replace the part-of-day defaults (e.g. {"저녁": "19:00"}). Unknown words or bad times are ignored.
pub fn set_dayparts(overrides: &[(String, String)]) {
    let mut table = default_dayparts();
    for (word, time) in overrides {
        if let (Some(slot), Ok(t)) = (table.iter_mut().find(|(w, _)| w == word), NaiveTime::parse_from_str(time, "%H:%M")) {
            slot.1 = t;
        }
    }
    *DAYPARTS.write().unwrap() = table;
}

fn default_dayparts() -> Vec<(String, NaiveTime)> {
    DEFAULT_DAYPARTS.iter().map(|(w, t)| (w.to_string(), NaiveTime::parse_from_str(t, "%H:%M").expect("default"))).collect()
}

/// The first part-of-day word in `text` with its default time ("오늘 저녁" → 저녁, 18:00).
/// 점심 is checked before 낮 ("점심" never contains 낮, but "낮" is short, so whole words win).
fn daypart_in(text: &str) -> Option<(String, NaiveTime)> {
    let table = { let t = DAYPARTS.read().unwrap(); if t.is_empty() { default_dayparts() } else { t.clone() } };
    table
        .into_iter()
        .filter_map(|(w, t)| text.find(&w).map(|at| (at, w, t)))
        .min_by_key(|(at, w, _)| (*at, std::cmp::Reverse(w.len())))
        .map(|(_, w, t)| (w, t))
}

fn approx_reason(word: &str, time: NaiveTime) -> String {
    format!("대략 시각: 「{word}」을 {}로 둠", time.format("%H:%M"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedSchedule {
    pub start_at: Option<DateTime<FixedOffset>>,
    pub end_at: Option<DateTime<FixedOffset>>,
    pub reminder_at: Option<DateTime<FixedOffset>>,
    pub review_reasons: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum DateOutcome {
    Absent,
    Valid(NaiveDate),
    /// A date was spoken but is not a real calendar day (e.g. 2월 30일).
    Invalid,
    /// Text was given but no rule recognised it.
    Unrecognised,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

fn absolute_date() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일")
}

/// Korean official-document style "2026. 11. 12." (year required, so decimals never match).
fn dotted_date() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?")
}

/// 24-hour clock "15:00", "9:30".
/// 「2026-11-02」 (a spreadsheet cell, a file name).
fn iso_date() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(\d{4})-(\d{1,2})-(\d{1,2})")
}

/// 「11. 3.」 「11. 3.(화)」 (공문 style, no year).
fn spaced_dot_date() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?:^|[^\d.])(\d{1,2})\.\s+(\d{1,2})\.")
}

fn colon_time() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(\d{1,2}):(\d{2})")
}

fn weekday_phrase() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?:(?:다음|이번)\s*주\s*)?[월화수목금토일]요일")
}

fn slash_date() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // Rust regex has no look-around; boundaries are checked by hand in `find_slash_date`.
    re(&R, r"(\d{1,2})[./-](\d{1,2})")
}

fn time_pattern() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?:(오전|오후|아침|낮|저녁|밤|새벽)\s*)?(\d{1,2})시(?:\s*(?:(\d{1,2})분|(반)))?")
}

/// Collapses whitespace and rewrites spoken Korean hours ("세 시") to digits ("3시").
pub fn normalize(text: &str) -> String {
    let mut value = text.split_whitespace().collect::<Vec<_>>().join(" ");
    const HOURS: [(&str, &str); 24] = [
        ("열두 시", "12시"), ("열한 시", "11시"), ("열 시", "10시"),
        ("아홉 시", "9시"), ("여덟 시", "8시"), ("일곱 시", "7시"),
        ("여섯 시", "6시"), ("다섯 시", "5시"), ("네 시", "4시"),
        ("세 시", "3시"), ("두 시", "2시"), ("한 시", "1시"),
        ("열두시", "12시"), ("열한시", "11시"), ("열시", "10시"),
        ("아홉시", "9시"), ("여덟시", "8시"), ("일곱시", "7시"),
        ("여섯시", "6시"), ("다섯시", "5시"), ("네시", "4시"),
        ("세시", "3시"), ("두시", "2시"), ("한시", "1시"),
    ];
    for (from, to) in HOURS {
        value = value.replace(from, to);
    }
    value
}

/// Whitespace-insensitive containment, used to check that model evidence was really heard.
pub fn quoted_in(haystack: &str, needle: &str) -> bool {
    let squash = |s: &str| normalize(s).chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let needle = squash(needle);
    needle.is_empty() || squash(haystack).contains(&needle)
}

fn find_slash_date(text: &str) -> Option<(u32, u32)> {
    for caps in slash_date().captures_iter(text) {
        let whole = caps.get(0)?;
        let before = text[..whole.start()].chars().next_back();
        let after = text[whole.end()..].chars().next();
        if before.is_some_and(|c| c.is_ascii_digit()) || after.is_some_and(|c| c.is_ascii_digit()) {
            continue;
        }
        return Some((caps[1].parse().ok()?, caps[2].parse().ok()?));
    }
    None
}

fn weekday_in(text: &str) -> Option<Weekday> {
    [
        ("월요일", Weekday::Mon), ("화요일", Weekday::Tue), ("수요일", Weekday::Wed),
        ("목요일", Weekday::Thu), ("금요일", Weekday::Fri), ("토요일", Weekday::Sat),
        ("일요일", Weekday::Sun),
    ]
    .into_iter()
    .find(|(word, _)| text.contains(word))
    .map(|(_, day)| day)
}

fn next_or_same(today: NaiveDate, weekday: Weekday) -> NaiveDate {
    let ahead = (weekday.num_days_from_monday() + 7 - today.weekday().num_days_from_monday()) % 7;
    today + Duration::days(ahead as i64)
}

fn parse_date(text: &str, today: NaiveDate) -> DateOutcome {
    if text.trim().is_empty() {
        return DateOutcome::Absent;
    }
    if let Some(caps) = absolute_date().captures(text) {
        let explicit_year = caps.get(1).and_then(|y| y.as_str().parse::<i32>().ok());
        let month = caps[2].parse::<u32>().unwrap_or(0);
        let day = caps[3].parse::<u32>().unwrap_or(0);
        return match NaiveDate::from_ymd_opt(explicit_year.unwrap_or(today.year()), month, day) {
            Some(date) if explicit_year.is_none() && date < today => {
                NaiveDate::from_ymd_opt(today.year() + 1, month, day)
                    .map_or(DateOutcome::Invalid, DateOutcome::Valid)
            }
            Some(date) => DateOutcome::Valid(date),
            None => DateOutcome::Invalid,
        };
    }
    if let Some(caps) = dotted_date().captures(text) {
        let parsed = (caps[1].parse::<i32>(), caps[2].parse::<u32>(), caps[3].parse::<u32>());
        return match parsed {
            (Ok(y), Ok(m), Ok(d)) => NaiveDate::from_ymd_opt(y, m, d).map_or(DateOutcome::Invalid, DateOutcome::Valid),
            _ => DateOutcome::Invalid,
        };
    }
    if let Some(caps) = iso_date().captures(text) {
        let parsed = (caps[1].parse::<i32>(), caps[2].parse::<u32>(), caps[3].parse::<u32>());
        return match parsed {
            (Ok(y), Ok(m), Ok(d)) => NaiveDate::from_ymd_opt(y, m, d).map_or(DateOutcome::Invalid, DateOutcome::Valid),
            _ => DateOutcome::Invalid,
        };
    }
    if let Some(caps) = spaced_dot_date().captures(text) {
        let (month, day) = (caps[1].parse::<u32>().unwrap_or(0), caps[2].parse::<u32>().unwrap_or(0));
        return match NaiveDate::from_ymd_opt(today.year(), month, day) {
            Some(date) if date < today => NaiveDate::from_ymd_opt(today.year() + 1, month, day).map_or(DateOutcome::Invalid, DateOutcome::Valid),
            Some(date) => DateOutcome::Valid(date),
            None => DateOutcome::Invalid,
        };
    }
    if let Some((month, day)) = find_slash_date(text) {
        return match NaiveDate::from_ymd_opt(today.year(), month, day) {
            Some(date) if date < today => NaiveDate::from_ymd_opt(today.year() + 1, month, day)
                .map_or(DateOutcome::Invalid, DateOutcome::Valid),
            Some(date) => DateOutcome::Valid(date),
            None => DateOutcome::Invalid,
        };
    }
    if text.contains("글피") {
        return DateOutcome::Valid(today + Duration::days(3));
    }
    if text.contains("모레") {
        return DateOutcome::Valid(today + Duration::days(2));
    }
    if text.contains("내일") {
        return DateOutcome::Valid(today + Duration::days(1));
    }
    if text.contains("오늘") {
        return DateOutcome::Valid(today);
    }
    if text.contains("그저께") || text.contains("그제") {
        return DateOutcome::Valid(today - Duration::days(2));
    }
    if text.contains("어제") {
        return DateOutcome::Valid(today - Duration::days(1));
    }
    if let Some(weekday) = weekday_in(text) {
        if text.contains("다음 주") || text.contains("다음주") {
            let days_to_next_monday = 7 - today.weekday().num_days_from_monday() as i64;
            let next_monday = today + Duration::days(days_to_next_monday);
            return DateOutcome::Valid(next_monday + Duration::days(weekday.num_days_from_monday() as i64));
        }
        let same_or_next = next_or_same(today, weekday);
        if same_or_next == today && !text.contains("이번") {
            return DateOutcome::Valid(same_or_next + Duration::days(7));
        }
        return DateOutcome::Valid(same_or_next);
    }
    DateOutcome::Unrecognised
}

/// One time phrase found in text: spoken ("오후 3시 반") or 24-hour ("15:30").
struct TimeMatch {
    start: usize,
    end: usize,
    hour: u32,
    minute: u32,
    period: Option<String>,
    rolls: bool,
    /// 「3시」 (spoken), not 「03:00」.
    spoken: bool,
}

fn time_matches(text: &str) -> Vec<TimeMatch> {
    let mut found: Vec<TimeMatch> = time_pattern()
        .captures_iter(text)
        .filter_map(|caps| {
            let whole = caps.get(0)?;
            let hour: u32 = caps[2].parse().ok()?;
            let minute = match (caps.get(3), caps.get(4)) {
                (Some(m), _) => m.as_str().parse().ok()?,
                (None, Some(_)) => 30,
                _ => 0,
            };
            let rolls = hour == 24 && !text[..caps.get(2)?.start()].ends_with(|c: char| c.is_ascii_digit());
            Some(TimeMatch { start: whole.start(), end: whole.end(), hour, minute, period: caps.get(1).map(|p| p.as_str().to_string()), rolls, spoken: true })
        })
        .collect();
    for caps in colon_time().captures_iter(text) {
        let whole = caps.get(0).expect("match");
        let digit_before = text[..whole.start()].ends_with(|c: char| c.is_ascii_digit());
        let digit_after = text[whole.end()..].starts_with(|c: char| c.is_ascii_digit());
        if digit_before || digit_after || found.iter().any(|m| m.start < whole.end() && whole.start() < m.end) {
            continue;
        }
        if let (Ok(hour), Ok(minute)) = (caps[1].parse(), caps[2].parse()) {
            found.push(TimeMatch { start: whole.start(), end: whole.end(), hour, minute, period: None, rolls: hour == 24, spoken: false });
        }
    }
    found.sort_by_key(|m| m.start);
    found
}

fn to_time(m: &TimeMatch) -> Option<NaiveTime> {
    let mut hour = m.hour;
    match m.period.as_deref() {
        Some("오후" | "낮" | "저녁" | "밤") if hour < 12 => hour += 12,
        Some("오전" | "아침" | "새벽") if hour == 12 => hour = 0,
        // A bare 「1시」~「6시」 is the afternoon (nobody puts a meeting at 3 a.m.; the screen's rule too).
        None if m.spoken && (1..=6).contains(&hour) => hour += 12,
        _ => {}
    }
    if hour == 24 {
        hour = 0;
    }
    NaiveTime::from_hms_opt(hour, m.minute, 0)
}

/// Clock times written as bare digits: 「1620」 → 「16:20」, 「16202120」 → 「16:20~21:20」
/// (only valid HHMM groups, not parts of longer numbers).
pub fn colon_times(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let hhmm = |d: &[char]| -> Option<String> {
        let h: u32 = d[..2].iter().collect::<String>().parse().ok()?;
        let m: u32 = d[2..4].iter().collect::<String>().parse().ok()?;
        (h < 24 && m < 60).then(|| format!("{:02}:{:02}", h, m))
    };
    while i < chars.len() {
        if chars[i].is_ascii_digit() && (i == 0 || !chars[i - 1].is_ascii_digit()) {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            let run = &chars[i..j];
            let joined = (i > 0 && matches!(chars[i - 1], ':' | '.' | '/' | '-')) || (j < chars.len() && matches!(chars[j], ':' | '.' | '/' | '-' | '년' | '원' | '개' | '명' | '번' | '호'));
            let converted = match run.len() {
                4 if !joined => hhmm(run),
                8 if !joined => match (hhmm(&run[..4]), hhmm(&run[4..])) {
                    (Some(a), Some(b)) if b > a => Some(format!("{a}~{b}")),
                    _ => None,
                },
                _ => None,
            };
            out.push_str(&converted.unwrap_or_else(|| run.iter().collect()));
            i = j;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Returns `(time, rolls_to_next_day)`; `None` when no valid time phrase is present.
fn parse_time(text: &str) -> Option<(NaiveTime, bool)> {
    let first = time_matches(text).into_iter().next()?;
    to_time(&first).map(|time| (time, first.rolls))
}

/// End of a spoken range such as "오후 3시 ~ 5시", "2시부터 4시까지" or "15:00~17:00".
/// An end without its own 오전/오후 inherits the afternoon shift of the start.
fn parse_range_end(text: &str, start: NaiveTime) -> Option<NaiveTime> {
    let matches = time_matches(text);
    let (first, second) = (matches.first()?, matches.get(1)?);
    let mut end = to_time(second)?;
    if second.period.is_none() && first.period.is_some() && end < start && end.hour() < 12 {
        end = end + Duration::hours(12);
    }
    (end > start).then_some(end)
}

/// The first date phrase the resolver recognises in `text`, as written (after `normalize`).
/// Used to fill a phrase the model skipped; the caller marks the item for review.
pub fn find_date_phrase(text: &str) -> Option<String> {
    let text = normalize(text);
    if let Some(m) = absolute_date().find(&text).or_else(|| dotted_date().find(&text)) {
        return Some(m.as_str().to_string());
    }
    if let Some(m) = slash_date().find_iter(&text).find(|m| {
        !text[..m.start()].ends_with(|c: char| c.is_ascii_digit()) && !text[m.end()..].starts_with(|c: char| c.is_ascii_digit())
    }) {
        return Some(m.as_str().to_string());
    }
    for word in ["글피", "모레", "내일", "오늘", "그저께", "그제", "어제"] {
        if text.contains(word) {
            return Some(word.to_string());
        }
    }
    weekday_phrase().find(&text).map(|m| m.as_str().to_string())
}

/// The first time phrase (with a following range, if any) the resolver recognises in `text`.
pub fn find_time_phrase(text: &str) -> Option<String> {
    let text = normalize(text);
    let matches = time_matches(&text);
    let Some(first) = matches.first() else { return daypart_in(&text).map(|(word, _)| word) };
    // Keep "오후 3시 ~ 5시" / "15:00~17:00" together so the end time survives.
    let end = match matches.get(1) {
        Some(next) if text[first.end..next.start].trim().trim_start_matches(['~', '-', '∼']).trim().is_empty()
            || text[first.end..next.start].contains("부터") => next.end,
        _ => first.end,
    };
    Some(text[first.start..end].to_string())
}

/// End day of a multi-day period ("6일", "11월 6일", "금요일"), never before `start`.
/// A bare day stays in the start's month, or moves to the next month when it would fall
/// before the start ("10월 30일부터 2일까지"). `None` when nothing valid is said.
pub fn resolve_period_end(end_text: &str, start: NaiveDate) -> Option<NaiveDate> {
    let text = normalize(end_text).replace("까지", "").trim().to_string();
    if text.is_empty() {
        return None;
    }
    let bare = text.strip_suffix('일').and_then(|d| d.trim().parse::<u32>().ok()).filter(|_| !text.contains('월'));
    if let Some(day) = bare {
        let same = NaiveDate::from_ymd_opt(start.year(), start.month(), day).filter(|d| *d >= start);
        return same.or_else(|| {
            let (y, m) = if start.month() == 12 { (start.year() + 1, 1) } else { (start.year(), start.month() + 1) };
            NaiveDate::from_ymd_opt(y, m, day)
        });
    }
    match parse_date(&text, start) {
        DateOutcome::Valid(date) if date >= start => Some(date),
        _ => None,
    }
}

/// Resolves quoted phrases against `reference`. `kind` is "SCHEDULE" or "TODO".
pub fn resolve(date_text: &str, time_text: &str, kind: &str, reference: DateTime<FixedOffset>) -> ResolvedSchedule {
    let mut reasons = Vec::new();
    let today = reference.date_naive();
    let date_text = normalize(date_text);
    let time_text = colon_times(&normalize(time_text));

    // Flags that keep the resolved date (unlike `reasons`, which stop resolution).
    let mut soft_reasons = Vec::new();
    let date = match parse_date(&date_text, today) {
        DateOutcome::Absent => None,
        DateOutcome::Valid(date) => {
            // A month/day just behind us is rolled to next year by the Android rule. That is
            // right for "3월 2일" said in October, but a document's own past date ("회의록
            // 10월 20일") would silently become an event a year away, so it is flagged.
            if (date - today).num_days() > 300 && !date_text.contains(&date.year().to_string()) {
                soft_reasons.push(format!("지난 날짜로 보여 내년({})으로 해석함: 「{date_text}」", date.year()));
            }
            Some(date)
        }
        DateOutcome::Invalid => {
            reasons.push(format!("날짜가 달력에 없음: 「{date_text}」"));
            None
        }
        DateOutcome::Unrecognised => {
            reasons.push(format!("날짜 표현을 해석하지 못함: 「{date_text}」"));
            None
        }
    };
    // A part of the day without an hour ("저녁", "오늘 저녁") gets its default time, marked approximate.
    let time = if time_text.is_empty() {
        daypart_in(&date_text).map(|(word, t)| {
            soft_reasons.push(approx_reason(&word, t));
            (t, false)
        })
    } else {
        // "오늘 밤" + "10시": the part of day was quoted with the date; apply it to a bare hour.
        let carried = match (time_matches(&time_text).first(), daypart_in(&date_text)) {
            (Some(m), Some((word, _))) if m.period.is_none() && !time_text.contains(':') => Some(format!("{word} {time_text}")),
            _ => None,
        };
        let parsed = carried.as_deref().and_then(parse_time).or_else(|| parse_time(&time_text)).or_else(|| {
            daypart_in(&time_text).map(|(word, t)| {
                soft_reasons.push(approx_reason(&word, t));
                (t, false)
            })
        });
        if parsed.is_none() {
            reasons.push(format!("시간 표현을 해석하지 못함: 「{time_text}」"));
        }
        parsed
    };

    if !reasons.is_empty() {
        return ResolvedSchedule { start_at: None, end_at: None, reminder_at: None, review_reasons: reasons };
    }

    let local = match (date, time) {
        (Some(date), Some((time, rolls))) => Some(date.and_time(time) + Duration::days(rolls as i64)),
        (None, Some((time, rolls))) => {
            let mut day = today;
            if rolls {
                day += Duration::days(1);
            } else if day.and_time(time) < reference.naive_local() {
                day += Duration::days(1);
            }
            Some(day.and_time(time))
        }
        (Some(date), None) => {
            if kind == "SCHEDULE" {
                reasons.push("날짜만 있어 오전 9시로 임시 지정".to_string());
            }
            Some(date.and_time(NaiveTime::from_hms_opt(9, 0, 0).expect("09:00")))
        }
        (None, None) => None,
    };

    reasons.extend(soft_reasons);
    let start = local.and_then(|naive| reference.offset().from_local_datetime(&naive).single());
    let range_end = time.and_then(|(t, _)| parse_range_end(&time_text, t));
    ResolvedSchedule {
        start_at: start,
        end_at: start.map(|s| match range_end {
            Some(end) => s + (end - s.time()),
            None => s + Duration::hours(1),
        }),
        reminder_at: start,
        review_reasons: reasons,
    }
}

/// True when the resolver recognises a date phrase in `text`.
pub fn mentions_date(text: &str, today: NaiveDate) -> bool {
    matches!(parse_date(&normalize(text), today), DateOutcome::Valid(_) | DateOutcome::Invalid)
}

/// True when the resolver recognises a time phrase in `text`.
pub fn mentions_time(text: &str) -> bool {
    let text = normalize(text);
    parse_time(&text).is_some() || daypart_in(&text).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_digit_times_get_colons() {
        assert_eq!(colon_times("1320"), "13:20");
        assert_eq!(colon_times("16202120"), "16:20~21:20");
        assert_eq!(colon_times("1620~2120"), "16:20~21:20");
        assert_eq!(colon_times("20261027"), "20261027");
        assert_eq!(colon_times("2026-1027"), "2026-1027");
        assert_eq!(colon_times("오후 3시"), "오후 3시");
    }

    /// Wednesday 2026-10-21 09:00 KST.
    fn reference() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-10-21T09:00:00+09:00").unwrap()
    }

    fn start(date: &str, time: &str, kind: &str) -> String {
        resolve(date, time, kind, reference())
            .start_at
            .map(|d| d.to_rfc3339())
            .unwrap_or_default()
    }

    #[test]
    fn period_end_days() {
        let start = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        assert_eq!(resolve_period_end("6일", start), NaiveDate::from_ymd_opt(2026, 11, 6));
        assert_eq!(resolve_period_end("6일까지", start), NaiveDate::from_ymd_opt(2026, 11, 6));
        assert_eq!(resolve_period_end("11월 20일", start), NaiveDate::from_ymd_opt(2026, 11, 20));
        assert_eq!(resolve_period_end("2일", NaiveDate::from_ymd_opt(2026, 10, 30).unwrap()), NaiveDate::from_ymd_opt(2026, 11, 2));
        assert_eq!(resolve_period_end("금요일", start), NaiveDate::from_ymd_opt(2026, 11, 6));
        assert_eq!(resolve_period_end("", start), None);
        assert_eq!(resolve_period_end("언젠가", start), None);
    }

    #[test]
    fn relative_days() {
        assert_eq!(start("오늘", "오후 3시", "SCHEDULE"), "2026-10-21T15:00:00+09:00");
        assert_eq!(start("내일", "오후 세 시", "SCHEDULE"), "2026-10-22T15:00:00+09:00");
        assert_eq!(start("모레", "10시 반", "SCHEDULE"), "2026-10-23T10:30:00+09:00");
        assert_eq!(start("글피", "아침 7시", "SCHEDULE"), "2026-10-24T07:00:00+09:00");
    }

    #[test]
    fn weekdays_and_next_week() {
        assert_eq!(start("다음 주 화요일", "오후 2시", "SCHEDULE"), "2026-10-27T14:00:00+09:00");
        assert_eq!(start("금요일", "오후 4시", "SCHEDULE"), "2026-10-23T16:00:00+09:00");
        // Same weekday as today without 이번 means next week.
        assert_eq!(start("수요일", "오후 1시", "SCHEDULE"), "2026-10-28T13:00:00+09:00");
        assert_eq!(start("이번 주 수요일", "오후 1시", "SCHEDULE"), "2026-10-21T13:00:00+09:00");
    }

    #[test]
    fn date_boundaries() {
        // Month and year rollover.
        let eom = DateTime::parse_from_rfc3339("2026-10-31T20:00:00+09:00").unwrap();
        assert_eq!(resolve("내일", "9시", "SCHEDULE", eom).start_at.unwrap().to_rfc3339(), "2026-11-01T09:00:00+09:00");
        let eoy = DateTime::parse_from_rfc3339("2026-12-31T20:00:00+09:00").unwrap();
        assert_eq!(resolve("모레", "9시", "SCHEDULE", eoy).start_at.unwrap().to_rfc3339(), "2027-01-02T09:00:00+09:00");
        // A past month/day without a year moves to next year.
        assert_eq!(start("3월 2일", "오전 9시", "SCHEDULE"), "2027-03-02T09:00:00+09:00");
        // Leap day exists in 2028 only.
        assert_eq!(start("2028년 2월 29일", "오전 9시", "SCHEDULE"), "2028-02-29T09:00:00+09:00");
        // A time already past today rolls to tomorrow; 24시 means midnight after the day.
        assert_eq!(start("", "오전 8시", "SCHEDULE"), "2026-10-22T08:00:00+09:00");
        assert_eq!(start("", "오후 8시", "SCHEDULE"), "2026-10-21T20:00:00+09:00");
        assert_eq!(start("오늘", "24시", "SCHEDULE"), "2026-10-22T00:00:00+09:00");
        assert_eq!(start("", "오후 12시", "SCHEDULE"), "2026-10-21T12:00:00+09:00");
        assert_eq!(start("", "새벽 12시", "SCHEDULE"), "2026-10-22T00:00:00+09:00");
    }

    #[test]
    fn parts_of_day_without_an_hour_are_approximate() {
        // 2026-10-25 regression: 「오늘 저녁에 … 식당 좀 알아봐줘」 left the time empty.
        let r = resolve("오늘 저녁", "저녁", "TODO", reference());
        assert_eq!(r.start_at.unwrap().to_rfc3339(), "2026-10-21T18:00:00+09:00");
        assert!(r.review_reasons.iter().any(|x| x.starts_with("대략 시각")), "{:?}", r.review_reasons);
        let only_date = resolve("내일 아침", "", "SCHEDULE", reference());
        assert_eq!(only_date.start_at.unwrap().to_rfc3339(), "2026-10-22T08:00:00+09:00");
        assert_eq!(start("모레", "점심", "SCHEDULE"), "2026-10-23T12:00:00+09:00");
        assert_eq!(start("오늘", "밤", "SCHEDULE"), "2026-10-21T21:00:00+09:00");
        // The date phrase's part of day applies to a bare hour ("오늘 밤" + "10시" → 22:00).
        assert_eq!(start("오늘 밤", "10시", "TODO"), "2026-10-21T22:00:00+09:00");
        assert_eq!(start("내일 아침", "7시", "SCHEDULE"), "2026-10-22T07:00:00+09:00");
        assert_eq!(start("내일 저녁", "15:00", "SCHEDULE"), "2026-10-22T15:00:00+09:00");
        // An hour still wins over the default.
        assert_eq!(start("오늘", "저녁 7시", "SCHEDULE"), "2026-10-21T19:00:00+09:00");
        assert_eq!(find_time_phrase("오늘 저녁에 식당 알아봐줘").as_deref(), Some("저녁"));
        assert!(mentions_time("내일 점심 약속"));
    }

    #[test]
    fn invalid_or_unknown_phrases_are_not_guessed() {
        let invalid = resolve("2월 30일", "오후 3시", "SCHEDULE", reference());
        assert!(invalid.start_at.is_none());
        assert!(invalid.review_reasons[0].contains("달력에 없음"));

        let unknown = resolve("언젠가", "", "SCHEDULE", reference());
        assert!(unknown.start_at.is_none());
        assert!(unknown.review_reasons[0].contains("해석하지 못함"));

        let bad_time = resolve("내일", "25시", "SCHEDULE", reference());
        assert!(bad_time.start_at.is_none());
    }

    #[test]
    fn date_only_schedule_needs_review_but_todo_does_not() {
        let schedule = resolve("내일", "", "SCHEDULE", reference());
        assert_eq!(schedule.start_at.unwrap().to_rfc3339(), "2026-10-22T09:00:00+09:00");
        assert_eq!(schedule.review_reasons.len(), 1);
        let todo = resolve("내일", "", "TODO", reference());
        assert!(todo.review_reasons.is_empty());
        let none = resolve("", "", "TODO", reference());
        assert!(none.start_at.is_none() && none.end_at.is_none());
    }

    #[test]
    fn end_is_one_hour_and_reminder_is_start() {
        let r = resolve("내일", "오후 3시", "SCHEDULE", reference());
        assert_eq!(r.end_at.unwrap().to_rfc3339(), "2026-10-22T16:00:00+09:00");
        assert_eq!(r.reminder_at, r.start_at);
    }

    #[test]
    fn past_days_and_time_ranges() {
        assert_eq!(start("어제", "", "TODO"), "2026-10-20T09:00:00+09:00");
        assert_eq!(start("그저께", "", "TODO"), "2026-10-19T09:00:00+09:00");
        let end = |time: &str| resolve("내일", time, "SCHEDULE", reference()).end_at.unwrap().to_rfc3339();
        assert_eq!(end("오후 3시 ~ 5시"), "2026-10-22T17:00:00+09:00");
        assert_eq!(end("오전 11시부터 오후 1시까지"), "2026-10-22T13:00:00+09:00");
        assert_eq!(end("2시부터 4시 30분까지"), "2026-10-22T16:30:00+09:00"); // bare 1–6시 = afternoon
        // An end before the start is ignored, keeping the one-hour default.
        assert_eq!(end("오후 5시 ~ 오후 3시"), "2026-10-22T18:00:00+09:00");
    }

    #[test]
    fn recently_past_dates_rolled_to_next_year_are_flagged() {
        let r = resolve("10월 20일", "오후 4시", "SCHEDULE", reference());
        assert_eq!(r.start_at.unwrap().to_rfc3339(), "2027-10-20T16:00:00+09:00");
        assert!(r.review_reasons[0].contains("내년"));
        // Far-ahead next-year dates and explicit years are not flagged.
        assert!(resolve("3월 2일", "오전 9시", "SCHEDULE", reference()).review_reasons.is_empty());
        assert!(resolve("2027년 10월 20일", "오후 4시", "SCHEDULE", reference()).review_reasons.is_empty());
    }

    #[test]
    fn official_document_formats() {
        assert_eq!(start("2026. 11. 12.(목)", "15:00~17:00", "SCHEDULE"), "2026-11-12T15:00:00+09:00");
        let r = resolve("2026. 11. 12.", "15:00~17:00", "SCHEDULE", reference());
        assert_eq!(r.end_at.unwrap().to_rfc3339(), "2026-11-12T17:00:00+09:00");
        assert_eq!(start("11/27(금)", "16:00", "SCHEDULE"), "2026-11-27T16:00:00+09:00");
        assert_eq!(start("", "9:30", "SCHEDULE"), "2026-10-21T09:30:00+09:00");
        // Spreadsheet and 공문 dates (2026-10-27 밤 안정화: an xlsx schedule came in with no days).
        assert_eq!(start("2026-11-02", "08:30", "SCHEDULE"), "2026-11-02T08:30:00+09:00");
        assert_eq!(start("11. 3.(화)", "", "TODO"), "2026-11-03T09:00:00+09:00");
        assert_eq!(start("2026. 11. 4.(수)", "15:10", "SCHEDULE"), "2026-11-04T15:10:00+09:00");
        // A bare 1–6시 is the afternoon; 「새벽 3시」 and 「03:00」 stay early (2026-10-27 밤 안정화).
        assert_eq!(start("내일", "3시", "SCHEDULE"), "2026-10-22T15:00:00+09:00");
        assert_eq!(start("내일", "6시 반", "SCHEDULE"), "2026-10-22T18:30:00+09:00");
        assert_eq!(start("내일", "새벽 3시", "SCHEDULE"), "2026-10-22T03:00:00+09:00");
        assert_eq!(start("내일", "03:00", "SCHEDULE"), "2026-10-22T03:00:00+09:00");
        assert_eq!(start("내일", "7시", "SCHEDULE"), "2026-10-22T07:00:00+09:00");
        assert!(resolve("2026. 2. 30.", "", "SCHEDULE", reference()).start_at.is_none());
        // Money and scores are not times.
        assert!(!mentions_time("320,000원 3.5점"));
    }

    #[test]
    fn phrases_are_found_as_written() {
        assert_eq!(find_date_phrase("글피 오후 1시에 미용실 예약").as_deref(), Some("글피"));
        assert_eq!(find_date_phrase("다음 주 화요일 오후 2시에 협의회").as_deref(), Some("다음 주 화요일"));
        assert_eq!(find_date_phrase("일시: 2026. 11. 12.(목) 15:00").as_deref(), Some("2026. 11. 12."));
        assert_eq!(find_date_phrase("11월 3일 15:00 김가상").as_deref(), Some("11월 3일"));
        assert_eq!(find_date_phrase("자료 정리"), None);
        assert_eq!(find_time_phrase("내일 아침 8시 반에 조회").as_deref(), Some("아침 8시 반"));
        assert_eq!(find_time_phrase("오후 세 시 ~ 5시 상담").as_deref(), Some("오후 3시 ~ 5시"));
        assert_eq!(find_time_phrase("15:00~17:00 연수").as_deref(), Some("15:00~17:00"));
        assert_eq!(find_time_phrase("보고서 내기"), None);
    }

    #[test]
    fn quoted_in_ignores_spacing_and_spoken_hours() {
        assert!(quoted_in("다음주 화요일 오후 세 시에 회의", "다음 주 화요일"));
        assert!(quoted_in("오후 세 시에 회의", "오후 3시"));
        assert!(!quoted_in("내일 회의", "모레"));
    }
}
