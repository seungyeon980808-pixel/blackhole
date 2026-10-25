package com.malhaedwo.pttprobe;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.time.ZoneId;

/** 블랙홀 휴대폰 쪽 공용 진입점: 보내기 대기열 위치, 업로드 예약, 설정 값. */
final class Blackhole {
    static final String PREFS = "blackhole_runtime";
    static final String PREF_QUICK_ENABLED = "quick_notification_enabled";
    static final String PREF_ALARMS = "alarms";
    static final String PREF_LAST_UPLOAD = "last_upload_message";
    private static final int UPLOAD_JOB_ID = 491751;

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

    static BlackholeUploader uploader(Context context) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = prefs(app);
        return new BlackholeUploader(outbox(app), new DriveTransfer(),
                new BlackholeUploader.TokenSource() {
                    @Override public String token() throws Exception { return GoogleOAuth.getAccessToken(app); }
                    @Override public void invalidate() { GoogleOAuth.clearCachedAccessToken(app); }
                },
                new BlackholeUploader.FolderCache() {
                    @Override public String get(String key) { return prefs.getString(key, ""); }
                    @Override public void put(String key, String value) { prefs.edit().putString(key, value).apply(); }
                },
                System::currentTimeMillis);
    }
}
