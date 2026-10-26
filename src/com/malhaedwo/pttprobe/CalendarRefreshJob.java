package com.malhaedwo.pttprobe;

import android.app.WallpaperManager;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.PersistableBundle;
import android.util.DisplayMetrics;

import java.io.File;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Date;
import java.util.Locale;

/**
 * Mac 사본 받기 → 구글 캘린더 반영(켜 둔 경우) → 홈 위젯 → 잠금화면 배경(켜 둔 경우).
 * 앱을 열지 않아도 위젯·잠금화면·캘린더가 새 내용을 따라가게 한다.
 *  - 주기 작업: 안드로이드 최소 간격 15분(+여유 5분). 앱 시작·업데이트·재부팅·위젯·달력 화면에서 등록하고,
 *    예전(30분) 등록이 남아 있으면 새 간격으로 바꾼다.
 *  - 보낸 직후: 업로드가 끝나면 15초·30초·1분·2분·5분 뒤 한 번씩 더 받는다(Mac이 정리해 사본을 쓸 시간).
 *  - 앱·보내기 화면을 열 때와 달력 화면이 보이는 동안(30초마다)은 바로 받는다.
 */
public final class CalendarRefreshJob extends JobService {
    static final int JOB_ID = 491752;
    static final int SOON_JOB_ID = 491753;
    static final long PERIOD_MS = 15 * 60_000L;
    static final long FLEX_MS = 5 * 60_000L;
    /** 보낸 뒤 다시 받는 간격(앞 단계에서 이어서). */
    static final long[] SOON_DELAYS_MS = {15_000L, 30_000L, 60_000L, 120_000L, 300_000L};
    /** 새 사본을 받았음: 열린 블랙홀 달력이 바로 반영한다. */
    static final String ACTION_SHARED = "com.malhaedwo.pttprobe.BLACKHOLE_SHARED";
    private static final String PREF_LOCK_DRAWN = "board_lock_drawn";
    private static final String STEP = "step";
    private static volatile boolean soonRunning;
    private static volatile boolean soonAgain;
    private Thread worker;

    /** 주기 작업 등록. 같은 간격으로 이미 있으면 그대로 둔다(돌던 작업을 멈추지 않게). */
    static void schedule(Context context) {
        Context app = context.getApplicationContext();
        JobScheduler scheduler = app.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        JobInfo pending = scheduler.getPendingJob(JOB_ID);
        if (pending != null && pending.getIntervalMillis() == PERIOD_MS && pending.getFlexMillis() == FLEX_MS) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(app, CalendarRefreshJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD_MS, FLEX_MS)
                .setPersisted(true)
                .build());
    }

    /** 보낸 직후: 짧은 간격으로 몇 번 더 받기(처음 단계부터). */
    static void soon(Context context) {
        if (soonRunning) {
            soonAgain = true;
            return;
        }
        soonStep(context.getApplicationContext(), 0);
    }

    private static void soonStep(Context app, int step) {
        if (step >= SOON_DELAYS_MS.length) return;
        JobScheduler scheduler = app.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        PersistableBundle extras = new PersistableBundle();
        extras.putInt(STEP, step);
        scheduler.schedule(new JobInfo.Builder(SOON_JOB_ID, new ComponentName(app, CalendarRefreshJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(SOON_DELAYS_MS[step])
                .setExtras(extras)
                .build());
    }

    private static volatile long lastScreenOn;

    /** 휴대폰 화면을 켤 때(녹음 대기 서비스가 알려 줌): 1분에 한 번까지 바로 받아 위젯·잠금화면을 새로 그린다. */
    static void onScreenOn(Context context) {
        long now = System.currentTimeMillis();
        if (now - lastScreenOn < 60_000L) return;
        lastScreenOn = now;
        refreshAsync(context);
        // Mac이 막 쓴 사본은 구글 드라이브 서버에 오르기까지 몇 초 걸린다(실기기: 첫 받기가 놓침): 짧게 몇 번 더.
        soon(context);
    }

    /** 화면을 열 때: 기다리지 않고 지금 한 번 받기(작업 등록도 확인). */
    static void refreshAsync(Context context) {
        Context app = context.getApplicationContext();
        schedule(app);
        new Thread(() -> refresh(app), "blackhole-calendar-now").start();
    }

    @Override public boolean onStartJob(JobParameters params) {
        boolean soonJob = params.getJobId() == SOON_JOB_ID;
        int step = soonJob ? params.getExtras().getInt(STEP, 0) : -1;
        if (soonJob) soonRunning = true;
        worker = new Thread(() -> {
            try {
                refresh(this);
            } finally {
                jobFinished(params, false);
                if (soonJob) {
                    soonRunning = false;
                    boolean restart = soonAgain;
                    soonAgain = false;
                    soonStep(getApplicationContext(), restart ? 0 : step + 1);
                }
            }
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
                boolean changed = !text.equals(prefs.getString(BlackholeCalendarStore.PREF_SHARED, ""));
                prefs.edit().putString(BlackholeCalendarStore.PREF_SHARED, text)
                        .putString(BlackholeCalendarStore.PREF_PENDING, pending).commit();
                Blackhole.pruneDrafts(app, text);
                if (changed) app.sendBroadcast(new Intent(ACTION_SHARED).setPackage(app.getPackageName()));
                prefs.edit().putString(BlackholeCalendarMirror.PREF_STATUS, CalendarMirrorWriter.sync(app, text)).apply();
                status = "Mac 사본 받음 " + clock();
            } else {
                status = "Mac이 아직 사본을 쓰지 않았습니다(Mac 블랙홀 설정 「휴대폰과 달력 공유」)";
            }
        } catch (Exception error) {
            String last = prefs.getString(BlackholeCalendarStore.PREF_STATUS, "");
            String kept = last.startsWith("Mac 사본 받음 ") ? " · 마지막으로 받은 때 " + last.substring("Mac 사본 받음 ".length())
                    : last.contains("마지막으로 받은 때 ") ? last.substring(last.indexOf(" · 마지막으로 받은 때 ")) : "";
            status = "Mac 달력 받기 실패 — " + BlackholeUploader.explain(error, "받습니다") + kept;
        }
        prefs.edit().putString(BlackholeCalendarStore.PREF_STATUS, status).apply();
        publish(app);
        return status;
    }

    /** 가진 사본으로 위젯과 잠금화면 배경을 다시 그린다(내용이 같으면 배경은 그대로). */
    static synchronized void publish(Context context) {
        Context app = context.getApplicationContext();
        CalendarWidgetProvider.updateAll(app);
        BlackholeQuickNotification.refresh(app);
        // 달력 화면을 열지 않아도 Mac에서 넣은 알림이 휴대폰 알람으로 걸린다.
        BlackholeAlarms.syncCalendar(app, "[]");
        SharedPreferences prefs = Blackhole.prefs(app);
        if (!prefs.getBoolean(BlackholeBoard.PREF_LOCK, false)) return;
        boolean hide = prefs.getBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, false);
        String shared = Blackhole.boardShared(app);
        BlackholeBoard.Board board = BlackholeBoard.build(shared, LocalDate.now(), LocalTime.now(), hide);
        CalendarBoardRenderer.Look look = CalendarWidgetProvider.look(prefs);
        String signature = LocalDate.now() + "|" + hide + "|" + look.bright + "|" + look.opacity + "|" + shared.hashCode();
        if (signature.equals(prefs.getString(PREF_LOCK_DRAWN, ""))) return;
        try {
            DisplayMetrics metrics = app.getResources().getDisplayMetrics();
            Bitmap bitmap = CalendarBoardRenderer.lock(board, metrics.widthPixels, metrics.heightPixels, metrics.density, look);
            WallpaperManager.getInstance(app).setBitmap(bitmap, null, true, WallpaperManager.FLAG_LOCK);
            prefs.edit().putString(PREF_LOCK_DRAWN, signature).putString(BlackholeBoard.PREF_STATUS, "잠금화면 배경 " + clock()).apply();
        } catch (Exception error) {
            prefs.edit().putString(BlackholeBoard.PREF_STATUS, "잠금화면 배경을 바꾸지 못함 · 설정에서 껐다 켜 보세요").apply();
        }
    }

    /** 설정이 바뀌면 다음에 꼭 다시 그리게 한다. */
    static void forgetLock(Context context) {
        Blackhole.prefs(context).edit().putString(PREF_LOCK_DRAWN, "").apply();
    }

    private static String clock() { return new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date()); }
}
