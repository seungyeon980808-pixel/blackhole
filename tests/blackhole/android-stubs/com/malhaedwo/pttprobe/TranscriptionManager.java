package com.malhaedwo.pttprobe;

import android.content.Context;

import java.io.File;

/** 컴파일 검사용 모양(실제는 src/TranscriptionManager.java, 음성 인식 API라 스텁 검사에서 빠짐). */
public final class TranscriptionManager {
    public static void enqueueVoice(Context context, File wavFile, String sha256, long capturedAt) {}
    public static void retryPending(Context context) {}
}
