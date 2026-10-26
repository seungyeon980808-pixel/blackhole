package com.malhaedwo.pttprobe;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import java.io.File;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class TranscriptionManager {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ArrayDeque<Job> QUEUE = new ArrayDeque<>();
    private static final Set<Long> QUEUED_IDS = new HashSet<>();
    private static SpeechFileRecognizer active;
    private static Context appContext;

    private TranscriptionManager() {}

    public static void enqueue(Context context, long captureId, File wavFile) {
        Context app = context.getApplicationContext();
        MAIN.post(() -> {
            appContext = app;
            CaptureItem item = CaptureDatabase.get(app).getItem(captureId);
            if (item != null && QUEUED_IDS.add(captureId)) {
                QUEUE.add(new Job(captureId, wavFile, item.version));
            }
            runNext();
        });
    }

    /**
     * 블랙홀 보내기 녹음(잠금화면·보내기 화면의 「말하기」): 승인 DB에는 넣지 않고, 받아쓴 글로
     * 휴대폰 초안과 Mac용 받아쓰기 파일만 만든다(BlackholeVoiceText).
     */
    public static void enqueueVoice(Context context, File wavFile, String sha256, long capturedAt) {
        Context app = context.getApplicationContext();
        MAIN.post(() -> {
            appContext = app;
            QUEUE.add(Job.voice(wavFile, sha256, capturedAt));
            runNext();
        });
    }

    public static void retry(Context context, long captureId, File wavFile) {
        CaptureDatabase.get(context).beginTranscription(captureId);
        enqueue(context, captureId, wavFile);
    }

    public static void retryPending(Context context) {
        List<CaptureItem> items = CaptureDatabase.get(context).listPendingTranscriptions();
        for (CaptureItem item : items) {
            if (item.audioPath != null) {
                File file = new File(item.audioPath);
                if (file.isFile()) enqueue(context, item.id, file);
            }
        }
    }

    public static boolean isBusy() { return active != null || !QUEUE.isEmpty(); }

    private static void runNext() {
        if (active != null) return;
        Job job = QUEUE.poll();
        if (job == null || appContext == null) return;
        if (job.voiceSha != null) {
            runVoice(job);
            return;
        }
        if (!job.wavFile.isFile()) {
            CaptureDatabase.get(appContext).markTranscriptionError(job.id, job.expectedVersion, "원본 음성 파일이 없습니다");
            QUEUED_IDS.remove(job.id);
            runNext();
            return;
        }
        active = new SpeechFileRecognizer(appContext);
        publish("음성인식 중: " + job.wavFile.getName());
        active.start(job.wavFile, new SpeechFileRecognizer.Callback() {
            @Override public void onSuccess(String transcript, float confidence, boolean onDevice) {
                try {
                    CaptureDatabase database = CaptureDatabase.get(appContext);
                    CaptureItem stored = database.getItem(job.id);
                    long referenceTime = stored == null || stored.createdAt <= 0 ? System.currentTimeMillis() : stored.createdAt;
                    ParsedCommand parsed = KoreanCommandParser.parse(transcript, referenceTime);
                    boolean saved = database.applyParsed(job.id, job.expectedVersion, transcript, parsed);
                    if (!saved) {
                        PttStore.append(appContext, "TRANSCRIPTION_STALE", "speech", "id=" + job.id);
                        publish("사용자가 이미 수정한 항목이라 늦게 도착한 인식 결과는 적용하지 않았습니다");
                        return;
                    }
                    PttStore.append(appContext, "TRANSCRIBED", "speech",
                            "id=" + job.id + ";on_device=" + onDevice + ";confidence=" + confidence + ";kind=" + parsed.kind);
                    publish("승인 대기: " + parsed.title);
                    // 블랙홀: 같은 녹음이 인박스로 갔으므로 받아쓴 글로 휴대폰 초안·Mac 초안을 바로 만든다.
                    BlackholeVoiceText.onPttTranscript(appContext, job.wavFile, transcript, referenceTime, onDevice, confidence);
                } catch (Throwable error) {
                    String message = "인식 결과 저장 실패: " + safe(error);
                    try { CaptureDatabase.get(appContext).markTranscriptionError(job.id, job.expectedVersion, message); } catch (Throwable ignored) {}
                    publish(message + ", 원본 음성은 보존했습니다");
                } finally {
                    finish(job.id);
                }
            }

            @Override public void onFailure(String message) {
                try {
                    try { CaptureDatabase.get(appContext).markTranscriptionError(job.id, job.expectedVersion, message); } catch (Throwable ignored) {}
                    try { PttStore.append(appContext, "TRANSCRIPTION_FAILED", "speech", "id=" + job.id + ";" + message); } catch (Throwable ignored) {}
                    publish(message + ", 원본 음성은 보존했습니다");
                } finally {
                    finish(job.id);
                }
            }
        });
    }

    private static void runVoice(Job job) {
        if (!job.wavFile.isFile()) {
            active = null;
            runNext();
            return;
        }
        active = new SpeechFileRecognizer(appContext);
        active.start(job.wavFile, new SpeechFileRecognizer.Callback() {
            @Override public void onSuccess(String transcript, float confidence, boolean onDevice) {
                try {
                    Context app = appContext;
                    new Thread(() -> BlackholeVoiceText.onTranscript(app, job.voiceSha, transcript, job.capturedAt, onDevice, confidence),
                            "BlackholeVoiceText").start();
                } catch (Throwable ignored) {
                    // 받아쓰기는 덤: 실패해도 녹음은 Mac이 분석한다.
                } finally {
                    active = null;
                    runNext();
                }
            }

            @Override public void onFailure(String message) {
                active = null;
                runNext();
            }
        });
    }

    private static void finish(long id) {
        QUEUED_IDS.remove(id);
        active = null;
        runNext();
    }

    private static void publish(String message) {
        if (appContext == null) return;
        Intent intent = new Intent(PttService.BROADCAST_STATUS).setPackage(appContext.getPackageName());
        intent.putExtra("message", message);
        appContext.sendBroadcast(intent);
    }

    private static String safe(Throwable error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    private static final class Job {
        final long id;
        final File wavFile;
        final int expectedVersion;
        /** 블랙홀 보내기 녹음이면 그 SHA-256(승인 DB 항목 아님). */
        String voiceSha;
        long capturedAt;
        Job(long id, File wavFile, int expectedVersion) {
            this.id = id;
            this.wavFile = wavFile;
            this.expectedVersion = expectedVersion;
        }
        static Job voice(File wavFile, String sha256, long capturedAt) {
            Job job = new Job(-1, wavFile, 0);
            job.voiceSha = sha256;
            job.capturedAt = capturedAt;
            return job;
        }
    }
}
