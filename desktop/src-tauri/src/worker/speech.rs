//! Speech to text without local models, in this order:
//! 1. the phone's own transcript (`인박스/*.bhstt`, matched by the recording's SHA-256);
//! 2. macOS speech recognition (`blackhole-stt`, on-device when available);
//! 3. whisper.cpp, only when the user turned local models on.
//! None available → `SttUnavailable` (a 「waiting」 code: the recording is kept and retried).

use super::{
    error::{ErrorCode, WorkerError},
    runners::Transcriber,
    source::sha256_hex,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The helper built from `mac-stt/main.swift` (empty when no Swift compiler was available).
static HELPER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/blackhole-stt"));

/// Phone transcript for a recording, from the `.bhstt` files in `inbox` (read only).
pub fn phone_transcript(inbox: &Path, wav_sha256: &str) -> Option<String> {
    let entries = fs::read_dir(inbox).ok()?;
    for path in entries.filter_map(|e| e.ok().map(|e| e.path())) {
        if !path.extension().is_some_and(|e| e == super::inbox::PHONE_STT_EXT) {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
        if v["kind"] == "blackhole-stt" && v["sha256"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(wav_sha256)) {
            let text = v["text"].as_str().unwrap_or("").trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// Write the embedded helper next to the app's other local files, once per version.
fn helper_path() -> Result<PathBuf, WorkerError> {
    if HELPER.is_empty() || !cfg!(target_os = "macos") {
        return Err(WorkerError::new(ErrorCode::SttUnavailable, "이 Mac용 음성 인식 도우미가 없습니다."));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".local").join("share").join("blackhole").join("bin");
    let path = dir.join(format!("blackhole-stt-{}", &sha256_hex(HELPER)[..12]));
    if !path.is_file() {
        fs::create_dir_all(&dir)?;
        let part = dir.join("blackhole-stt.part");
        fs::write(&part, HELPER)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&part, fs::Permissions::from_mode(0o755))?;
        }
        fs::rename(&part, &path)?;
    }
    Ok(path)
}

/// macOS speech recognition (Korean). Empty text when nothing was said.
pub struct MacSpeech;

impl MacSpeech {
    pub fn run(&self, wav: &Path) -> Result<String, WorkerError> {
        let helper = helper_path()?;
        let out = Command::new(&helper)
            .arg(wav)
            .output()
            .map_err(|e| WorkerError::new(ErrorCode::SttUnavailable, format!("음성 인식 도우미를 실행할 수 없습니다: {e}")))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // Killed by macOS (no speech permission for whoever started it) or crashed: nothing on stderr.
        if message.is_empty() {
            return Err(WorkerError::new(
                ErrorCode::SttUnavailable,
                "macOS 음성 인식이 멈췄어요(권한 없음) · 시스템 설정 → 개인정보 보호 및 보안 → 음성 인식에서 블랙홀을 허용해 주세요",
            ));
        }
        let code = if message.starts_with("NOT_AUTHORIZED") || message.starts_with("UNAVAILABLE") || message.starts_with("TIMEOUT") {
            ErrorCode::SttUnavailable
        } else {
            ErrorCode::SttFailed
        };
        Err(WorkerError::new(code, format!("macOS 음성 인식: {message}")))
    }
}

/// The chain used by the Claude analyzer.
pub struct SpeechChain {
    /// The inbox the recording came from (phone transcripts live there), if any.
    pub inbox: Option<PathBuf>,
    pub mac: Option<MacSpeech>,
    /// whisper.cpp, only with local models turned on.
    pub local: Option<Box<dyn Transcriber>>,
}

impl SpeechChain {
    fn transcribe_with(&self, wav: &Path, plain: bool) -> Result<String, WorkerError> {
        if let Some(inbox) = &self.inbox {
            if let Ok(bytes) = fs::read(wav) {
                if let Some(text) = phone_transcript(inbox, &sha256_hex(&bytes)) {
                    return Ok(text);
                }
            }
        }
        let mut last = WorkerError::new(ErrorCode::SttUnavailable, "음성을 글로 바꿀 방법이 없습니다(휴대폰 받아쓰기 없음, macOS 음성 인식 꺼짐).");
        if let Some(mac) = &self.mac {
            match mac.run(wav) {
                Ok(text) => return Ok(text),
                Err(e) => last = e,
            }
        }
        if let Some(local) = &self.local {
            return if plain { local.transcribe_plain(wav) } else { local.transcribe(wav) };
        }
        Err(last)
    }
}

impl Transcriber for SpeechChain {
    fn model_name(&self) -> String {
        "phone-or-macos-speech".into()
    }
    fn transcribe(&self, wav: &Path) -> Result<String, WorkerError> {
        self.transcribe_with(wav, false)
    }
    fn transcribe_plain(&self, wav: &Path) -> Result<String, WorkerError> {
        self.transcribe_with(wav, true)
    }
    fn hint_words(&self) -> Vec<String> {
        self.local.as_ref().map(|l| l.hint_words()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_transcript_comes_first_and_is_matched_by_the_recording_hash() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("인박스");
        fs::create_dir_all(&inbox).unwrap();
        let wav = dir.path().join("a.wav");
        fs::write(&wav, b"RIFF fake wav").unwrap();
        let sha = sha256_hex(b"RIFF fake wav");
        fs::write(inbox.join("x.bhstt"), serde_json::json!({"kind":"blackhole-stt","sha256":"0000","text":"다른 녹음"}).to_string()).unwrap();
        fs::write(inbox.join("y.bhstt"), serde_json::json!({"kind":"blackhole-stt","sha256":sha.to_uppercase(),"text":" 내일 3시 상담 "}).to_string()).unwrap();
        let chain = SpeechChain { inbox: Some(inbox.clone()), mac: None, local: None };
        assert_eq!(chain.transcribe(&wav).unwrap(), "내일 3시 상담");
        // No transcript, no macOS helper, no local model: wait (not a final failure).
        fs::remove_file(inbox.join("y.bhstt")).unwrap();
        let e = chain.transcribe(&wav).unwrap_err();
        assert!(e.code.is_waiting(), "{e:?}");
    }
}
