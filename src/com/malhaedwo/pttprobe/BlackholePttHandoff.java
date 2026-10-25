package com.malhaedwo.pttprobe;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

/** 평소 PTT 녹음도 블랙홀 인박스로 보낸다. 원본 WAV는 그대로 두고 복사본만 넣으며, 실패해도 기존 저장·인식에는 영향이 없다. */
final class BlackholePttHandoff {
    static final String LAST_ERROR = "ptt_handoff_last_error";

    private BlackholePttHandoff() {}

    static void send(Context context, File wav) {
        try (InputStream input = new FileInputStream(wav)) {
            Blackhole.outbox(context).addStream(input, BlackholeOutbox.KIND_VOICE, BlackholeOutbox.SOURCE_PTT,
                    wav.getName(), "audio/wav", System.currentTimeMillis());
            Blackhole.requestUpload(context);
        } catch (Throwable error) {
            String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
            Blackhole.prefs(context).edit().putString(LAST_ERROR, "블랙홀 보내기 대기열 추가 실패: " + message).apply();
        }
    }
}
