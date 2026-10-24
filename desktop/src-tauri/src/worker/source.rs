//! Reading originals without changing them: hashing and WAV silence detection.

use super::error::{ErrorCode, WorkerError};
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn read_original(path: &Path) -> Result<Vec<u8>, WorkerError> {
    std::fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            WorkerError::new(ErrorCode::InputMissing, format!("원본 파일이 없습니다: {}", path.display()))
        } else {
            WorkerError::from(error)
        }
    })
}

/// RMS below this (on a 0..32767 scale) counts as silence. `say` speech is ~2000+.
const SILENCE_RMS: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WavInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_ms: u64,
    pub rms: f64,
}

/// Parses a 16-bit PCM RIFF/WAVE file (the format Ya Android records).
pub fn inspect_wav(bytes: &[u8]) -> Result<WavInfo, WorkerError> {
    let unsupported = |why: &str| WorkerError::new(ErrorCode::UnsupportedAudio, format!("지원하지 않는 음성 파일: {why}"));
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(unsupported("RIFF/WAVE 형식이 아님"));
    }
    let mut offset = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let body_start = offset + 8;
        let body_end = body_start.saturating_add(size).min(bytes.len());
        let body = &bytes[body_start..body_end];
        if id == b"fmt " && body.len() >= 16 {
            format = Some((
                u16::from_le_bytes([body[0], body[1]]),
                u16::from_le_bytes([body[2], body[3]]),
                u32::from_le_bytes(body[4..8].try_into().unwrap()),
                u16::from_le_bytes([body[14], body[15]]),
            ));
        } else if id == b"data" {
            data = Some(body);
        }
        offset = body_start.saturating_add(size + (size & 1));
    }
    let (audio_format, channels, sample_rate, bits) = format.ok_or_else(|| unsupported("fmt 구간 없음"))?;
    if audio_format != 1 || bits != 16 || channels == 0 || sample_rate == 0 {
        return Err(unsupported("16비트 PCM이 아님"));
    }
    let data = data.unwrap_or(&[]);
    let samples = data.len() / 2;
    let sum_sq: f64 = data
        .chunks_exact(2)
        .map(|s| {
            let v = i16::from_le_bytes([s[0], s[1]]) as f64;
            v * v
        })
        .sum();
    let rms = if samples == 0 { 0.0 } else { (sum_sq / samples as f64).sqrt() };
    let frames = samples as u64 / channels as u64;
    Ok(WavInfo { sample_rate, channels, duration_ms: frames * 1000 / sample_rate as u64, rms })
}

/// Rejects empty or silent recordings before any model runs, so silence is never
/// turned into a hallucinated transcript.
pub fn ensure_speech(info: &WavInfo) -> Result<(), WorkerError> {
    if info.duration_ms < 200 || info.rms < SILENCE_RMS {
        return Err(WorkerError::new(
            ErrorCode::EmptyAudio,
            format!("빈 음성입니다(길이 {}ms, 음량 {:.0}).", info.duration_ms, info.rms),
        ));
    }
    Ok(())
}

/// Builds a mono 16-bit PCM WAV. Test and fixture helper only.
pub fn pcm16_wav(sample_rate: u32, samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_hex() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn silent_and_zero_length_wavs_are_empty_audio() {
        let silent = inspect_wav(&pcm16_wav(16_000, &vec![0; 16_000])).unwrap();
        assert_eq!(silent.duration_ms, 1000);
        assert_eq!(ensure_speech(&silent).unwrap_err().code, ErrorCode::EmptyAudio);

        let empty = inspect_wav(&pcm16_wav(16_000, &[])).unwrap();
        assert_eq!(ensure_speech(&empty).unwrap_err().code, ErrorCode::EmptyAudio);
    }

    #[test]
    fn tone_is_speech_like() {
        let tone: Vec<i16> = (0..16_000).map(|i| ((i as f64 * 0.06).sin() * 8000.0) as i16).collect();
        let info = inspect_wav(&pcm16_wav(16_000, &tone)).unwrap();
        assert!(ensure_speech(&info).is_ok());
    }

    #[test]
    fn non_wav_is_unsupported() {
        assert_eq!(inspect_wav(b"not a wav file at all").unwrap_err().code, ErrorCode::UnsupportedAudio);
    }

    #[test]
    fn missing_original_is_input_missing() {
        let err = read_original(Path::new("/nonexistent/ya-worker-test.wav")).unwrap_err();
        assert_eq!(err.code, ErrorCode::InputMissing);
    }
}
