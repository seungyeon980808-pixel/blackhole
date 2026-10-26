package com.malhaedwo.pttprobe;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.io.File;
import java.io.IOException;
import java.time.ZoneId;

/** 블랙홀 휴대폰 쪽 공용 진입점: 보내기 대기열 위치, 업로드 예약, 설정 값. */
final class Blackhole {
    static final String PREFS = "blackhole_runtime";
    static final String PREF_QUICK_ENABLED = "quick_notification_enabled";
    static final String PREF_ALARMS = "alarms";
    static final String PREF_LAST_UPLOAD = "last_upload_message";
    private static final int UPLOAD_JOB_ID = 491751;
    /** 휴대폰 초안이 바뀜: 열린 블랙홀 달력이 다시 그린다. */
    static final String ACTION_DRAFTS = "com.malhaedwo.pttprobe.BLACKHOLE_DRAFTS_CHANGED";
    private static final Object DRAFT_LOCK = new Object();

    private Blackhole() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static BlackholeOutbox outbox(Context context) {
        return new BlackholeOutbox(new File(context.getApplicationContext().getFilesDir(), "blackhole-outbox"),
                ZoneId.systemDefault());
    }

    /** 녹음·카메라 임시 파일 자리(보내기 전까지만 쓴다). */
    static File captureDir(Context context) {
        File dir = new File(context.getApplicationContext().getFilesDir(), "blackhole-capture");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** 네트워크가 잡히면 인박스로 올린다. 실패하면 JobScheduler가 간격을 늘려 다시 시도한다. */
    static void requestUpload(Context context) {
        Context app = context.getApplicationContext();
        if (BlackholeUploadJob.markAgainIfRunning()) return;
        JobScheduler scheduler = app.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        JobInfo info = new JobInfo.Builder(UPLOAD_JOB_ID, new ComponentName(app, BlackholeUploadJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .setPersisted(true)
                .build();
        scheduler.schedule(info);
    }

    /** 문장 보내기: 대기열에 넣고, 규칙 파서 초안을 휴대폰 달력에 바로 두고, 업로드를 예약한다. */
    static BlackholeOutbox.Entry sendText(Context context, String text, String source) throws IOException {
        Context app = context.getApplicationContext();
        BlackholeOutbox.Entry entry = outbox(app).addText(text, source, System.currentTimeMillis());
        requestUpload(app);
        draftText(app, text, entry.createdAt, BlackholeDrafts.jobId(entry.sha256));
        return entry;
    }

    static void draftText(Context context, String text, long capturedAt, String srcKey) {
        try {
            keepDrafts(context, BlackholeDrafts.fromText(text, capturedAt, srcKey, ZoneId.systemDefault()).toString());
        } catch (Exception ignored) {
            // 초안이 없어도 보내기는 그대로 간다(Mac이 정리하면 들어옴).
        }
    }

    /** 초안(하나 또는 JSON 목록)을 보관하고, 열린 달력·위젯·잠금화면에 알린다. */
    static void keepDrafts(Context context, String entriesJson) {
        Context app = context.getApplicationContext();
        synchronized (DRAFT_LOCK) {
            SharedPreferences p = prefs(app);
            p.edit().putString(BlackholeDrafts.PREF, BlackholeDrafts.addAll(p.getString(BlackholeDrafts.PREF, "[]"), entriesJson)).commit();
        }
        app.sendBroadcast(new Intent(ACTION_DRAFTS).setPackage(app.getPackageName()));
        new Thread(() -> CalendarRefreshJob.publish(app), "BlackholeDraftBoard").start();
    }

    /** Mac 사본을 받은 뒤: Mac이 다룬 원본의 초안은 뺀다. */
    static void pruneDrafts(Context context, String shared) {
        Context app = context.getApplicationContext();
        synchronized (DRAFT_LOCK) {
            SharedPreferences p = prefs(app);
            String before = p.getString(BlackholeDrafts.PREF, "[]");
            String after = BlackholeDrafts.prune(before, shared, System.currentTimeMillis(), ZoneId.systemDefault());
            if (!after.equals(before)) p.edit().putString(BlackholeDrafts.PREF, after).commit();
        }
    }

    static String drafts(Context context) {
        return prefs(context).getString(BlackholeDrafts.PREF, "[]");
    }

    static BlackholeUploader uploader(Context context) {
        Context app = context.getApplicationContext();
        return new BlackholeUploader(outbox(app), new DriveTransfer(), tokens(app), folderCache(app), System::currentTimeMillis);
    }

    static BlackholeUploader.TokenSource tokens(Context context) {
        Context app = context.getApplicationContext();
        return new BlackholeUploader.TokenSource() {
            @Override public String token() throws Exception { return GoogleOAuth.getAccessToken(app); }
            @Override public void invalidate() { GoogleOAuth.clearCachedAccessToken(app); }
        };
    }

    static BlackholeUploader.FolderCache folderCache(Context context) {
        SharedPreferences prefs = prefs(context);
        return new BlackholeUploader.FolderCache() {
            @Override public String get(String key) { return prefs.getString(key, ""); }
            @Override public void put(String key, String value) { prefs.edit().putString(key, value).apply(); }
        };
    }
}
