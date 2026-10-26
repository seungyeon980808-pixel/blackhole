package com.malhaedwo.pttprobe;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;

/**
 * 녹음의 받아쓰기(휴대폰 기기 안 음성 인식)를 Mac보다 먼저 쓴다. 받아쓴 글로 휴대폰 초안을 바로 만들고,
 * 같은 글을 「*.bhstt」 작은 파일로 녹음과 함께 인박스에 올려 Mac이 whisper를 기다리지 않고 초안을 만들게 한다.
 * 녹음(WAV)은 그대로 올라가고 Mac의 whisper·AI 결과가 나중에 같은 항목을 다듬는다(작업 id = WAV의 SHA-256).
 */
final class BlackholeVoiceText {
    static final String EXT = "bhstt";

    private BlackholeVoiceText() {}

    /** Mac이 읽는 받아쓰기 파일 내용. */
    static String sidecar(String wavSha256, String text, long capturedAt, boolean onDevice, float confidence) throws Exception {
        return new JSONObject().put("kind", "blackhole-stt").put("sha256", wavSha256).put("text", text)
                .put("at", capturedAt).put("onDevice", onDevice).put("confidence", (double) confidence).toString();
    }

    /** 보내기 대기열에 들어간 녹음을 기기 안에서 받아쓴다(평소 PTT 녹음은 TranscriptionManager가 이미 한다). */
    static void transcribe(Context context, BlackholeOutbox.Entry entry) {
        if (entry == null || entry.file == null || !BlackholeOutbox.KIND_VOICE.equals(entry.kind)) return;
        TranscriptionManager.enqueueVoice(context, entry.file, entry.sha256, entry.createdAt);
    }

    /** 받아쓴 글이 생겼을 때: 휴대폰 초안 + Mac에 보낼 받아쓰기 파일. 실패해도 녹음 보내기에는 영향이 없다. */
    static void onTranscript(Context context, String wavSha256, String transcript, long capturedAt, boolean onDevice, float confidence) {
        String text = transcript == null ? "" : transcript.trim();
        if (text.isEmpty() || wavSha256 == null || wavSha256.length() < 16) return;
        Context app = context.getApplicationContext();
        Blackhole.draftText(app, text, capturedAt, BlackholeDrafts.jobId(wavSha256));
        try {
            byte[] body = sidecar(wavSha256, text, capturedAt, onDevice, confidence).getBytes(StandardCharsets.UTF_8);
            Blackhole.outbox(app).addStream(new ByteArrayInputStream(body), BlackholeOutbox.KIND_FILE, BlackholeOutbox.SOURCE_PTT,
                    "받아쓰기." + EXT, "application/json", System.currentTimeMillis());
            Blackhole.requestUpload(app);
        } catch (Exception error) {
            Blackhole.prefs(app).edit().putString(BlackholePttHandoff.LAST_ERROR, "받아쓰기 보내기 실패: " + error.getMessage()).apply();
        }
    }

    /** 평소 PTT 녹음: 인박스로 넘긴 복사본과 같은 바이트라 같은 작업 id가 된다. */
    static void onPttTranscript(Context context, File wav, String transcript, long capturedAt, boolean onDevice, float confidence) {
        Context app = context.getApplicationContext();
        // 음성 인식 결과는 화면 스레드로 온다: 해시·파일 쓰기는 따로.
        new Thread(() -> {
            try {
                onTranscript(app, BlackholeOutbox.sha256(wav), transcript, capturedAt, onDevice, confidence);
            } catch (Exception ignored) {
                // 원본을 못 읽으면 초안 없이 Mac 분석만 기다린다.
            }
        }, "BlackholeVoiceText").start();
    }

    /** 대화 화면에 보이지 않는 기계용 파일(동작·받아쓰기). */
    static boolean hidden(BlackholeOutbox.Entry entry) {
        return entry != null && BlackholeOutbox.KIND_FILE.equals(entry.kind) && ("bhact".equals(entry.ext) || EXT.equals(entry.ext));
    }
}
