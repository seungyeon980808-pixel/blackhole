//! Discord·Slack input (stage 5): the user's own messages in one chosen channel become
//! inbox files (text as .txt, attachments as they are), so they follow the same analysis
//! path as phone and desktop input. Read-only towards Discord/Slack: nothing is posted,
//! edited or deleted there.
//!
//! Configuration lives outside the repository (`~/.config/blackhole/messenger.json` or
//! `BLACKHOLE_MESSENGER_CONFIG`):
//! `{"discord": {"botToken", "channelId", "allowedUserId"}, "slack": {"botToken", "channelId", "allowedUserId"}}`.
//! On the first poll only the position is remembered: old history is never imported.

use super::error::{ErrorCode, WorkerError};
use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const STATE_FILE: &str = "messenger-v1.json";
const MAX_ATTACHMENT: u64 = 25 * 1024 * 1024;
const ATTACHMENT_EXTS: [&str; 12] = ["png", "jpg", "jpeg", "webp", "pdf", "hwp", "hwpx", "docx", "xlsx", "txt", "wav", "md"];

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Channel {
    pub bot_token: String,
    pub channel_id: String,
    /// Only this user's messages are taken (the owner). Required.
    pub allowed_user_id: String,
    /// Test override of the API base (loopback fake server).
    #[serde(default)]
    pub api_base: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MessengerConfig {
    #[serde(default)]
    pub discord: Option<Channel>,
    #[serde(default)]
    pub slack: Option<Channel>,
}

impl MessengerConfig {
    pub fn path() -> PathBuf {
        if let Some(p) = std::env::var_os("BLACKHOLE_MESSENGER_CONFIG") {
            return PathBuf::from(p);
        }
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        home.join(".config").join("blackhole").join("messenger.json")
    }

    /// `Ok(None)` when no configuration file exists.
    pub fn load() -> Result<Option<Self>, WorkerError> {
        let path = Self::path();
        if !path.is_file() {
            return Ok(None);
        }
        let config: Self = serde_json::from_slice(&fs::read(&path)?)
            .map_err(|e| WorkerError::new(ErrorCode::Io, format!("메신저 설정 형식 오류({}): {e}", path.display())))?;
        for (name, ch) in [("discord", &config.discord), ("slack", &config.slack)] {
            if let Some(ch) = ch {
                if ch.bot_token.trim().is_empty() || ch.channel_id.trim().is_empty() || ch.allowed_user_id.trim().is_empty() {
                    return Err(WorkerError::new(ErrorCode::Io, format!("메신저 설정({name})에 botToken·channelId·allowedUserId가 모두 필요합니다.")));
                }
            }
        }
        Ok(Some(config))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct State {
    /// Newest Discord message id seen (snowflake).
    discord_after: Option<String>,
    /// Newest Slack message ts seen.
    slack_oldest: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PollReport {
    /// Inbox file names written on this poll.
    pub written: Vec<String>,
    pub errors: Vec<String>,
}

struct Message {
    id: String,
    text: String,
    /// (file name, download url)
    files: Vec<(String, String)>,
}

fn load_state(dir: &Path) -> State {
    fs::read(dir.join(STATE_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_state(dir: &Path, state: &State) -> Result<(), WorkerError> {
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(state).unwrap_or_default();
    AtomicFile::new(dir.join(STATE_FILE), AllowOverwrite)
        .write(|f| f.write_all(&bytes))
        .map_err(|e| WorkerError::new(ErrorCode::Io, e.to_string()))
}

fn http_error(service: &str, e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => format!("{service} HTTP {code}: {}", resp.into_string().unwrap_or_default().chars().take(200).collect::<String>()),
        ureq::Error::Transport(t) => format!("{service} 연결 실패: {t}"),
    }
}

fn get_json(url: &str, auth: &str, service: &str) -> Result<serde_json::Value, String> {
    ureq::get(url)
        .set("Authorization", auth)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| http_error(service, e))?
        .into_json()
        .map_err(|e| format!("{service} 응답 형식 오류: {e}"))
}

fn download(url: &str, auth: Option<&str>, service: &str) -> Result<Vec<u8>, String> {
    let mut req = ureq::get(url).timeout(Duration::from_secs(60));
    if let Some(auth) = auth {
        req = req.set("Authorization", auth);
    }
    let resp = req.call().map_err(|e| http_error(service, e))?;
    let mut bytes = Vec::new();
    resp.into_reader().take(MAX_ATTACHMENT + 1).read_to_end(&mut bytes).map_err(|e| format!("{service} 첨부 받기 실패: {e}"))?;
    if bytes.len() as u64 > MAX_ATTACHMENT {
        return Err(format!("{service} 첨부가 25MB를 넘어 건너뜀"));
    }
    Ok(bytes)
}

/// Discord: messages after the remembered id, oldest first, from the allowed user only.
fn discord_messages(ch: &Channel, after: Option<&str>) -> Result<(Vec<Message>, Option<String>), String> {
    let base = ch.api_base.clone().unwrap_or_else(|| "https://discord.com/api/v10".into());
    let mut url = format!("{base}/channels/{}/messages?limit=50", ch.channel_id);
    if let Some(after) = after {
        url.push_str(&format!("&after={after}"));
    }
    let list = get_json(&url, &format!("Bot {}", ch.bot_token), "디스코드")?;
    let mut items: Vec<&serde_json::Value> = list.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let id_num = |v: &serde_json::Value| v["id"].as_str().and_then(|s| s.parse::<u128>().ok()).unwrap_or(0);
    items.sort_by_key(|v| id_num(v));
    let newest = items.last().and_then(|v| v["id"].as_str()).map(str::to_string).or_else(|| after.map(str::to_string));
    if after.is_none() {
        return Ok((Vec::new(), newest));
    }
    let messages = items
        .into_iter()
        .filter(|v| v["author"]["id"].as_str() == Some(ch.allowed_user_id.as_str()))
        .map(|v| Message {
            id: v["id"].as_str().unwrap_or_default().to_string(),
            text: v["content"].as_str().unwrap_or_default().to_string(),
            files: v["attachments"]
                .as_array()
                .map(|a| a.iter().filter_map(|f| Some((f["filename"].as_str()?.to_string(), f["url"].as_str()?.to_string()))).collect())
                .unwrap_or_default(),
        })
        .collect();
    Ok((messages, newest))
}

/// Slack: messages newer than the remembered ts, oldest first, from the allowed user only.
fn slack_messages(ch: &Channel, oldest: Option<&str>) -> Result<(Vec<Message>, Option<String>), String> {
    let base = ch.api_base.clone().unwrap_or_else(|| "https://slack.com/api".into());
    let mut url = format!("{base}/conversations.history?channel={}&limit=50", ch.channel_id);
    if let Some(oldest) = oldest {
        url.push_str(&format!("&oldest={oldest}"));
    }
    let body = get_json(&url, &format!("Bearer {}", ch.bot_token), "슬랙")?;
    if body["ok"].as_bool() != Some(true) {
        return Err(format!("슬랙 오류: {}", body["error"].as_str().unwrap_or("알 수 없음")));
    }
    let mut items: Vec<&serde_json::Value> = body["messages"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let ts = |v: &serde_json::Value| v["ts"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    items.sort_by(|a, b| ts(a).partial_cmp(&ts(b)).unwrap_or(std::cmp::Ordering::Equal));
    let newest = items.last().and_then(|v| v["ts"].as_str()).map(str::to_string).or_else(|| oldest.map(str::to_string));
    if oldest.is_none() {
        return Ok((Vec::new(), newest));
    }
    let messages = items
        .into_iter()
        .filter(|v| v["user"].as_str() == Some(ch.allowed_user_id.as_str()) && v["subtype"].is_null())
        .filter(|v| Some(v["ts"].as_str().unwrap_or_default()) != oldest)
        .map(|v| Message {
            id: v["ts"].as_str().unwrap_or_default().replace('.', ""),
            text: v["text"].as_str().unwrap_or_default().to_string(),
            files: v["files"]
                .as_array()
                .map(|a| a.iter().filter_map(|f| Some((f["name"].as_str()?.to_string(), f["url_private_download"].as_str()?.to_string()))).collect())
                .unwrap_or_default(),
        })
        .collect();
    Ok((messages, newest))
}

fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim_start_matches('.').trim();
    if cleaned.is_empty() { "첨부".into() } else { cleaned.chars().take(60).collect() }
}

/// Write one message as inbox files; returns the names written. Never overwrites.
fn write_message(inbox: &Path, label: &str, m: &Message, auth: Option<&str>, report: &mut PollReport) {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let text = m.text.trim();
    if !text.is_empty() {
        let name = format!("{stamp}-{label}-{}.txt", m.id);
        let path = inbox.join(&name);
        if !path.exists() && fs::write(&path, format!("{text}\n")).is_ok() {
            report.written.push(name);
        }
    }
    for (file_name, url) in &m.files {
        let ext = Path::new(file_name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !ATTACHMENT_EXTS.contains(&ext.as_str()) {
            report.errors.push(format!("{label} 첨부 「{file_name}」는 읽지 않는 형식이라 건너뜀"));
            continue;
        }
        let name = format!("{stamp}-{label}-{}-{}", m.id, safe_name(file_name));
        let path = inbox.join(&name);
        if path.exists() {
            continue;
        }
        match download(url, auth, label) {
            Ok(bytes) => {
                if fs::write(&path, bytes).is_ok() {
                    report.written.push(name);
                }
            }
            Err(e) => report.errors.push(e),
        }
    }
}

/// One poll of every configured channel into `root/인박스/`. State goes to `root/.블랙홀/`.
pub fn poll(root: &Path, config: &MessengerConfig) -> Result<PollReport, WorkerError> {
    let inbox = root.join("인박스");
    let state_dir = root.join(".블랙홀");
    fs::create_dir_all(&inbox)?;
    let mut state = load_state(&state_dir);
    let mut report = PollReport::default();
    if let Some(ch) = &config.discord {
        match discord_messages(ch, state.discord_after.as_deref()) {
            Ok((messages, newest)) => {
                for m in &messages {
                    // Discord attachment URLs are signed; no token is sent with them.
                    write_message(&inbox, "디스코드", m, None, &mut report);
                }
                state.discord_after = newest;
            }
            Err(e) => report.errors.push(e),
        }
    }
    if let Some(ch) = &config.slack {
        match slack_messages(ch, state.slack_oldest.as_deref()) {
            Ok((messages, newest)) => {
                let auth = format!("Bearer {}", ch.bot_token);
                for m in &messages {
                    write_message(&inbox, "슬랙", m, Some(&auth), &mut report);
                }
                state.slack_oldest = newest;
            }
            Err(e) => report.errors.push(e),
        }
    }
    save_state(&state_dir, &state)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// Minimal loopback HTTP server. Each route answers once (by path prefix, first match);
    /// "BASE" in a body becomes this server's address. Records "path authorization".
    fn fake(routes: Vec<(&'static str, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let mut routes: Vec<(String, String)> = routes.into_iter().map(|(p, b)| (p.to_string(), b.replace("BASE", &base))).collect();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut auth = String::new();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    if h.to_lowercase().starts_with("authorization:") {
                        auth = h.trim().to_string();
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{path} {auth}"));
                let body = routes.iter().position(|(p, _)| path.starts_with(p.as_str())).map(|i| routes.remove(i).1).unwrap_or_else(|| "[]".into());
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        (base, seen)
    }

    fn state(root: &Path) -> String {
        fs::read_to_string(root.join(".블랙홀").join(STATE_FILE)).unwrap()
    }

    #[test]
    fn discord_first_poll_remembers_position_then_takes_only_the_owners_messages() {
        let root = tempfile::tempdir().unwrap();
        let (base, seen) = fake(vec![
            ("/channels/C1/messages", r#"[{"id":"100","author":{"id":"me"},"content":"예전 메시지"}]"#),
            ("/channels/C1/messages?limit=50&after=100", r#"[{"id":"102","author":{"id":"someone"},"content":"남의 말"},{"id":"101","author":{"id":"me"},"content":"내일 3시 회의","attachments":[{"filename":"공문.pdf","url":"BASE/files/a.pdf"},{"filename":"x.exe","url":"BASE/files/x"}]}]"#),
            ("/files/a.pdf", "%PDF-1.4"),
        ]);
        let config = MessengerConfig { discord: Some(Channel { bot_token: "t".into(), channel_id: "C1".into(), allowed_user_id: "me".into(), api_base: Some(base) }), slack: None };
        assert!(poll(root.path(), &config).unwrap().written.is_empty(), "old history is not imported");
        assert!(state(root.path()).contains("\"discordAfter\": \"100\""));
        let report = poll(root.path(), &config).unwrap();
        let mut kinds: Vec<String> = report.written.iter().map(|n| n.splitn(3, '-').nth(2).unwrap().to_string()).collect();
        kinds.sort();
        assert_eq!(kinds, vec!["디스코드-101-공문.pdf".to_string(), "디스코드-101.txt".to_string()], "{report:?}");
        assert!(report.errors.iter().any(|e| e.contains("x.exe")), "unsupported attachment skipped: {report:?}");
        let txt = report.written.iter().find(|n| n.ends_with(".txt")).unwrap();
        assert_eq!(fs::read_to_string(root.path().join("인박스").join(txt)).unwrap(), "내일 3시 회의\n");
        assert!(state(root.path()).contains("\"discordAfter\": \"102\""));
        let log = seen.lock().unwrap();
        assert!(log[0].contains("Authorization: Bot t"));
        assert!(log.iter().any(|l| l.starts_with("/files/a.pdf") && !l.contains("Authorization")), "no token sent to attachment urls");
    }

    #[test]
    fn slack_takes_owner_messages_without_subtype_and_downloads_files_with_token() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".블랙홀")).unwrap();
        fs::write(root.path().join(".블랙홀").join(STATE_FILE), r#"{"slackOldest":"1700000000.000100"}"#).unwrap();
        let (base, seen) = fake(vec![
            ("/conversations.history", r#"{"ok":true,"messages":[{"ts":"1700000000.000300","user":"U1","text":"금요일까지 보고서","files":[{"name":"memo.txt","url_private_download":"BASE/files/memo.txt"}]},{"ts":"1700000000.000200","user":"U1","subtype":"channel_join","text":"joined"},{"ts":"1700000000.000250","user":"U2","text":"남의 말"}]}"#),
            ("/files/memo.txt", "첨부 내용"),
        ]);
        let config = MessengerConfig { discord: None, slack: Some(Channel { bot_token: "xoxb".into(), channel_id: "C9".into(), allowed_user_id: "U1".into(), api_base: Some(base) }) };
        let report = poll(root.path(), &config).unwrap();
        let mut kinds: Vec<String> = report.written.iter().map(|n| n.splitn(3, '-').nth(2).unwrap().to_string()).collect();
        kinds.sort();
        assert_eq!(kinds, vec!["슬랙-1700000000000300-memo.txt".to_string(), "슬랙-1700000000000300.txt".to_string()], "{report:?}");
        assert!(state(root.path()).contains("1700000000.000300"));
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|l| l.contains("Authorization: Bearer xoxb")), "{log:?}");
    }

    #[test]
    fn config_requires_owner_and_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        std::env::set_var("BLACKHOLE_MESSENGER_CONFIG", &path);
        assert_eq!(MessengerConfig::load().unwrap(), None);
        fs::write(&path, r#"{"discord":{"botToken":"t","channelId":"c","allowedUserId":""}}"#).unwrap();
        assert!(MessengerConfig::load().is_err());
        fs::write(&path, r#"{"slack":{"botToken":"t","channelId":"c","allowedUserId":"u"}}"#).unwrap();
        assert!(MessengerConfig::load().unwrap().unwrap().slack.is_some());
        std::env::remove_var("BLACKHOLE_MESSENGER_CONFIG");
    }
}
