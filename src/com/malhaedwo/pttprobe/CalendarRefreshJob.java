package com.malhaedwo.pttprobe;

import android.app.WallpaperManager;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.util.DisplayMetrics;

import java.io.File;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Date;
import java.util.Locale;

/**
 * 30분마다(네트워크가 있을 때): Mac 사본 받기 → 구글 캘린더 반영(켜 둔 경우) → 홈 위젯 → 잠금화면 배경(켜 둔 경우).
 * 앱을 열지 않아도 위젯·잠금화면·캘린더가 새 내용을 따라가게 한다.
 */
public final class CalendarRefreshJob extends JobService {
    static final int JOB_ID = 491752;
    private static final long PERIOD_MS = 30 * 60_000L;
    private static final String PREF_LOCK_DRAWN = "board_lock_drawn";
    private Thread worker;

    static void schedule(Context context) {
        Context app = context.getApplicationContext();
        JobScheduler scheduler = app.getSystemService(JobScheduler.class);
        if (scheduler == null || scheduler.getPendingJob(JOB_ID) != null) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(app, CalendarRefreshJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD_MS)
                .setPersisted(true)
                .build());
    }

    @Override public boolean onStartJob(JobParameters params) {
        worker = new Thread(() -> {
            refresh(this);
            jobFinished(params, false);
        }, "blackhole-calendar-refresh");
        worker.start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) {
        if (worker != null) worker.interrupt();
        return true;
    }

    /** 받기·반영·그리기를 한 번. 화면(CalendarWebActivity)과 작업이 같은 길을 쓴다. 상태 한 줄을 돌려준다. */
    static synchronized String refresh(Context context) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = Blackhole.prefs(app);
        String status;
        try {
            BlackholeCalendarSync sync = new BlackholeCalendarSync(Blackhole.uploader(app), new DriveTransfer(),
                    Blackhole.tokens(app), Blackhole.folderCache(app), new File(app.getCacheDir(), "blackhole-calendar"));
            String text = sync.fetch();
            if (BlackholeCalendarStore.isShared(text)) {
                String pending = BlackholeCalendarStore.prune(prefs.getString(BlackholeCalendarStore.PREF_PENDING, "[]"), text);
                prefs.edit().putString(BlackholeCalendarStore.PREF_SHARED, text)
                        .putString(BlackholeCalendarStore.PREF_PENDING, pending).apply();
                prefs.edit().putString(BlackholeCalendarMirror.PREF_STATUS, CalendarMirrorWriter.sync(app, text)).apply();
                status = "Mac 사본 받음 " + clock();
            } else {
                status = "Mac이 아직 사본을 쓰지 않았습니다(Mac 블랙홀 설정 「휴대폰과 달력 공유」)";
            }
        } catch (Exception error) {
            status = "사본 받기 실패: " + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
        }
        prefs.edit().putString(BlackholeCalendarStore.PREF_STATUS, status).apply();
        publish(app);
        return status;
    }

    /** 가진 사본으로 위젯과 잠금화면 배경을 다시 그린다(내용이 같으면 배경은 그대로). */
    static void publish(Context context) {
        Context app = context.getApplicationContext();
        CalendarWidgetProvider.updateAll(app);
        SharedPreferences prefs = Blackhole.prefs(app);
        if (!prefs.getBoolean(BlackholeBoard.PREF_LOCK, false)) return;
        boolean hide = prefs.getBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, false);
        String shared = prefs.getString(BlackholeCalendarStore.PREF_SHARED, "");
        BlackholeBoard.Board board = BlackholeBoard.build(shared, LocalDate.now(), LocalTime.now(), hide);
        String signature = LocalDate.now() + "|" + hide + "|" + shared.hashCode();
        if (signature.equals(prefs.getString(PREF_LOCK_DRAWN, ""))) return;
        try {
            DisplayMetrics metrics = app.getResources().getDisplayMetrics();
            Bitmap bitmap = CalendarBoardRenderer.lock(board, metrics.widthPixels, metrics.heightPixels, metrics.density);
            WallpaperManager.getInstance(app).setBitmap(bitmap, null, true, WallpaperManager.FLAG_LOCK);
            prefs.edit().putString(PREF_LOCK_DRAWN, signature).putString(BlackholeBoard.PREF_STATUS, "잠금화면 배경 " + clock()).apply();
        } catch (Exception error) {
            prefs.edit().putString(BlackholeBoard.PREF_STATUS, "잠금화면 배경 실패: " + error.getMessage()).apply();
        }
    }

    /** 설정이 바뀌면 다음에 꼭 다시 그리게 한다. */
    static void forgetLock(Context context) {
        Blackhole.prefs(context).edit().putString(PREF_LOCK_DRAWN, "").apply();
    }

    private static String clock() { return new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date()); }
}
