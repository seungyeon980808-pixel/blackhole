package com.malhaedwo.pttprobe;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.content.Intent;

/** 보내기 대기열을 드라이브 「블랙홀/인박스/」로 올리는 작업. 승인 DB 동기화(SyncJobService)와 별개. */
public final class BlackholeUploadJob extends JobService {
    static final String ACTION_CHANGED = "com.malhaedwo.pttprobe.BLACKHOLE_OUTBOX_CHANGED";
    private static final Object RUN_LOCK = new Object();
    private static volatile boolean running;
    private static volatile boolean again;
    private volatile Thread worker;

    /**
     * 같은 번호의 작업을 다시 예약하면 JobScheduler가 돌던 업로드를 멈춰 버린다.
     * 그래서 도는 중이면 예약 대신 「한 번 더」 표시만 하고, 끝난 뒤 이어서 돈다.
     */
    static boolean markAgainIfRunning() {
        if (!running) return false;
        again = true;
        return true;
    }

    @Override public boolean onStartJob(JobParameters params) {
        Context app = getApplicationContext();
        Thread thread = new Thread(() -> {
            boolean retry = false;
            String message;
            synchronized (RUN_LOCK) {
                running = true;
                try {
                    if (!GoogleOAuth.isConnected(app)) {
                        message = "Google 연결이 없어 보내기를 기다림 · 블랙홀 첫 화면에서 「Google 연결」을 눌러 주세요";
                    } else {
                        message = "";
                        do {
                            again = false;
                            try {
                                BlackholeUploader.Report report = Blackhole.uploader(app).run();
                                message = report.message();
                                retry = report.hasFailures();
                                // 올린 것이 있으면 Mac 정리 결과를 곧바로 몇 번 더 받는다.
                                if (report.uploaded > 0) CalendarRefreshJob.soon(app);
                            } catch (InterruptedException interrupted) {
                                return;
                            } catch (Throwable error) {
                                message = "보내기 실패 — " + BlackholeUploader.explain(error, "다시 보냅니다");
                                retry = true;
                            }
                        } while (again && !retry);
                    }
                } finally {
                    running = false;
                }
            }
            Blackhole.prefs(app).edit().putString(Blackhole.PREF_LAST_UPLOAD, message).apply();
            app.sendBroadcast(new Intent(ACTION_CHANGED).setPackage(app.getPackageName()));
            jobFinished(params, retry);
            // 끝나기 직전에 들어온 요청은 여기서 새로 예약한다.
            if (again && !retry) {
                again = false;
                Blackhole.requestUpload(app);
            }
        }, "BlackholeUpload");
        worker = thread;
        thread.start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) {
        Thread thread = worker;
        if (thread != null) thread.interrupt();
        return true;
    }
}
