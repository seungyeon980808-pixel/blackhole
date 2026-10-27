//! 비밀 정보: passwords, PINs, card numbers, keys typed or pasted into Blackhole.
//!
//! Decided by local rules before anything else sees the text. The value goes only to the macOS
//! keychain (service `com.malhaedwo.blackhole.secret`, account = the name); the name alone is
//! kept in app data for search. Never in Drive, notes, 달력.json, the Claude API or a log.
//! Showing or copying asks for Touch ID first; a copied value leaves the clipboard after 30 s.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::Duration,
};

const SERVICE: &str = "com.malhaedwo.blackhole.secret";
const INDEX: &str = "secrets.json";
pub const CLEAR_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq)]
pub enum Guess {
    None,
    /// A secret word (비번, 카드번호 …) and a value: stored without asking.
    Sure { name: String, value: String },
    /// Looks like a password but nothing says so: ask once.
    Maybe { name: String, value: String },
}

fn key_words() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)비번|비밀번호|패스워드|암호|password|passwd|\bpw\b|\bpin\b|핀번호|핀 번호|카드\s*번호|카드|보안\s*코드|cvc|cvv|otp|인증\s*키|api\s*key|api키|토큰|token|계좌\s*번호|계좌|공인인증|아이디|계정|주민\s*(?:등록)?\s*번호|여권\s*번호|면허\s*번호|운전\s*면허|외국인\s*등록\s*번호").unwrap())
}

fn is_hangul(c: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&c) || ('\u{3131}'..='\u{318E}').contains(&c)
}

/// A token that could be a secret value: no Hangul, no link, not a date or a time.
fn value_like(t: &str, with_key: bool) -> bool {
    static DATE: OnceLock<Regex> = OnceLock::new();
    let date = DATE.get_or_init(|| Regex::new(r"^\d{1,4}[:./-]\d{1,2}([:./-]\d{1,4})?$").unwrap());
    let t = t.trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | '「' | '」' | ',' | '.'));
    if t.chars().count() < 4 || t.chars().any(is_hangul) || t.starts_with("http") || date.is_match(t) {
        return false;
    }
    let digits = t.chars().filter(char::is_ascii_digit).count();
    let letters = t.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let symbols = t.chars().filter(|c| c.is_ascii_punctuation()).count();
    if t.starts_with("sk-") || t.starts_with("ghp_") || t.starts_with("AKIA") {
        return true;
    }
    if with_key {
        // After 비번/카드번호…: any code-like token (also a bare PIN 1234 or 1234-5678-…)
        return digits + letters + symbols == t.chars().count() && (digits > 0 || symbols > 0 || letters >= 6);
    }
    // No secret word: only clearly password-shaped strings (8+, letters and digits, mixed case or symbols)
    let mixed_case = t.chars().any(|c| c.is_ascii_uppercase()) && t.chars().any(|c| c.is_ascii_lowercase());
    t.chars().count() >= 8 && digits > 0 && letters > 0 && (symbols > 0 || mixed_case) && !t.contains('@')
}

pub fn guess(text: &str) -> Guess {
    let text = text.trim();
    if text.is_empty() || text.lines().count() > 3 || text.chars().count() > 200 {
        return Guess::None;
    }
    let with_key = key_words().is_match(text);
    let tokens: Vec<&str> = text.split(|c: char| c.is_whitespace() || c == '=' || c == '：').filter(|t| !t.is_empty()).collect();
    let candidate = tokens.iter().rev().map(|t| t.trim_start_matches(':')).find(|t| value_like(t, with_key));
    let Some(value) = candidate else { return Guess::None };
    let value = value.trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | '「' | '」' | ',')).to_string();
    let name = text.replacen(&value, "", 1);
    let name = name.trim().trim_end_matches([':', '=', '-', '：']).trim();
    let name = name.trim_end_matches(['은', '는', '이', '가', '을', '를']).trim();
    let name = if name.is_empty() { format!("비밀 {}", chrono::Local::now().format("%m-%d %H:%M")) } else { name.chars().take(60).collect() };
    if with_key {
        Guess::Sure { name, value }
    } else {
        Guess::Maybe { name, value }
    }
}

/* ---------- keychain ---------- */

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The value goes through `security -i` standard input (never a command line, file or log).
pub fn store(dir: &Path, name: &str, value: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("키체인은 macOS에서만 씁니다.".into());
    }
    let mut child = Command::new("/usr/bin/security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    writeln!(child.stdin.as_mut().ok_or("키체인 입력을 열 수 없습니다.")?, "add-generic-password -U -s {SERVICE} -a {} -l {} -w {}", quote(name), quote(&format!("블랙홀 비밀: {name}")), quote(value))
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() || String::from_utf8_lossy(&out.stderr).contains("error") {
        return Err("키체인에 저장하지 못했습니다.".into());
    }
    let mut names = list(dir);
    names.retain(|s| s.name != name);
    names.push(SecretName { name: name.into(), at: chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string() });
    write_index(dir, &names)
}

fn read_value(name: &str) -> Option<String> {
    let out = Command::new("/usr/bin/security").args(["find-generic-password", "-s", SERVICE, "-a", name, "-w"]).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
}

pub fn remove(dir: &Path, name: &str) -> Result<(), String> {
    let _ = Command::new("/usr/bin/security").args(["delete-generic-password", "-s", SERVICE, "-a", name]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let mut names = list(dir);
    names.retain(|s| s.name != name);
    write_index(dir, &names)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecretName {
    pub name: String,
    pub at: String,
}

/// Names only (for search). The values stay in the keychain.
pub fn list(dir: &Path) -> Vec<SecretName> {
    std::fs::read_to_string(dir.join(INDEX)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_index(dir: &Path, names: &[SecretName]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(INDEX), serde_json::to_string_pretty(names).unwrap_or_default()).map_err(|e| e.to_string())
}

/* ---------- Touch ID ---------- */

static AUTH: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/blackhole-auth"));

fn auth_path() -> Result<PathBuf, String> {
    if AUTH.is_empty() {
        return Err("이 Mac에서는 Touch ID 확인 도우미를 쓸 수 없습니다.".into());
    }
    let dir = crate::worker::claude::data_dir().join("bin");
    let path = dir.join(format!("blackhole-auth-{}", &crate::worker::source::sha256_hex(AUTH)[..12]));
    if !path.is_file() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let part = dir.join("blackhole-auth.part");
        std::fs::write(&part, AUTH).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn confirm_owner(reason: &str) -> Result<(), String> {
    let ok = Command::new(auth_path()?).arg(reason).status().map(|s| s.success()).unwrap_or(false);
    if ok { Ok(()) } else { Err("확인하지 않아 열지 않았습니다.".into()) }
}

fn pbcopy(text: &str) {
    if let Ok(mut child) = Command::new("/usr/bin/pbcopy").stdin(Stdio::piped()).spawn() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
    }
}

/// Touch ID, then the value onto the clipboard; it is taken off again after 30 s (if unchanged).
pub fn copy(name: &str) -> Result<(), String> {
    confirm_owner(&format!("「{name}」 복사"))?;
    let value = read_value(name).ok_or("키체인에서 찾지 못했습니다.")?;
    pbcopy(&value);
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR_AFTER);
        let now = Command::new("/usr/bin/pbpaste").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        if now == value {
            pbcopy("");
        }
    });
    Ok(())
}

/// Touch ID, then the value itself (shown in the quick window only, never stored by the page).
pub fn reveal(name: &str) -> Result<String, String> {
    confirm_owner(&format!("「{name}」 보기"))?;
    read_value(name).ok_or_else(|| "키체인에서 찾지 못했습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sure(t: &str) -> (String, String) {
        match guess(t) {
            Guess::Sure { name, value } => (name, value),
            g => panic!("{t}: {g:?}"),
        }
    }

    #[test]
    fn secret_words_with_a_value_are_secrets() {
        assert_eq!(sure("지마켓 비번 Abc!2345"), ("지마켓 비번".into(), "Abc!2345".into()));
        assert_eq!(sure("현관 비밀번호: 4821"), ("현관 비밀번호".into(), "4821".into()));
        assert_eq!(sure("카드번호 1234-5678-9012-3456"), ("카드번호".into(), "1234-5678-9012-3456".into()));
        assert_eq!(sure("나이스 pw=hello2026").1, "hello2026");
        assert_eq!(sure("claude api key sk-ant-abc123def456").1, "sk-ant-abc123def456");
    }

    #[test]
    fn id_numbers_and_accounts_are_secrets() {
        // 2026-10-27 밤 안정화: 주민·여권·면허 번호도 키체인으로(달력·AI에 가지 않음).
        assert_eq!(sure("주민번호 900101-1234567").1, "900101-1234567");
        assert_eq!(sure("주민등록번호: 900101-1234567").1, "900101-1234567");
        assert_eq!(sure("여권번호 M12345678").1, "M12345678");
        assert_eq!(sure("운전면허 12-34-567890-12").1, "12-34-567890-12");
        assert_eq!(sure("계좌 110-123-456789").1, "110-123-456789");
        assert_eq!(sure("와이파이 비밀번호는 qwer5678").1, "qwer5678");
    }

    #[test]
    fn phone_numbers_times_and_dates_are_not_secrets() {
        for t in ["010-1234-5678 학부모 연락처", "학부모 연락처 010-1234-5678", "15:30 회의", "2026-10-30 연수", "1620~2120 초과근무", "11.5 연수", "차 번호 12가 3456"] {
            assert_eq!(guess(t), Guess::None, "{t}");
        }
    }

    #[test]
    fn ordinary_sentences_are_not_secrets() {
        for t in ["내일 3시 치과", "지마켓 비번 바꾸기", "카드 결제일 25일", "10/30 오후 4:30 면담", "https://example.com/a1b2c3d4", "회의 자료 v2 인쇄", "비번 바꾸기 12월 3일까지", "kim@example.com 에게 메일"] {
            assert_eq!(guess(t), Guess::None, "{t}");
        }
    }

    #[test]
    fn password_shaped_text_without_a_word_is_asked() {
        assert!(matches!(guess("넷플릭스 Qz8!mPw2x"), Guess::Maybe { .. }));
        assert!(matches!(guess("Tr0ub4dor&3xyz"), Guess::Maybe { .. }));
    }

    #[test]
    fn names_are_kept_without_values() {
        let dir = tempfile::tempdir().unwrap();
        write_index(dir.path(), &[SecretName { name: "지마켓 비번".into(), at: "x".into() }]).unwrap();
        let text = std::fs::read_to_string(dir.path().join(INDEX)).unwrap();
        assert!(text.contains("지마켓 비번") && !text.contains("Abc!2345"));
        assert_eq!(list(dir.path()).len(), 1);
    }
}
