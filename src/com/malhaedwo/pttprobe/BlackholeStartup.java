package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 앱을 열 때 한 번 하는 준비(2026-10-27부터 첫 화면은 달력: 녹음 대기 화면은 설정 안으로 옮김).
 * 예전에 녹음 대기 화면(MainActivity)이 열릴 때 하던 일을 그대로 옮겨 왔다: 처음 설치 안내 또는 권한,
 * 받아쓰기 다시 시도, 로컬 알림·캘린더 맞추기, 동기화 예약, 빠른 넣기 알림.
 */
final class BlackholeStartup {
    static final int REQUEST_PERMISSIONS = 100;
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();

    private BlackholeStartup() {}

    /** 첫 화면(달력)이 처음 열릴 때. */
    static void onLaunch(Activity activity) {
        if (BlackholeAlarmSetupActivity.shouldWelcome(activity)) {
            activity.startActivity(new android.content.Intent(activity, BlackholeAlarmSetupActivity.class));
        } else {
            requestNeededPermissions(activity);
        }
        TranscriptionManager.retryPending(activity);
        reconcile(activity);
        SyncScheduler.ensurePeriodic(activity);
        SyncScheduler.request(activity);
        BlackholeQuickNotification.refresh(activity);
    }

    /** 첫 화면으로 돌아올 때마다(녹음 대기 화면의 onResume과 같은 일). */
    static void onResume(Activity activity) {
        PttService.restoreIfEnabled(activity);
        CalendarRefreshJob.refreshAsync(activity);
        reconcile(activity);
    }

    private static void reconcile(Context context) {
        Context app = context.getApplicationContext();
        WORK.execute(() -> {
            try {
                CaptureAutomation.processAllReady(app);
            } catch (Throwable ignored) {
                // 녹음 대기 화면(설정 → 녹음 대기)에서 다시 확인하고 알려 준다.
            }
        });
    }

    private static void requestNeededPermissions(Activity activity) {
        String[] candidates = android.os.Build.VERSION.SDK_INT >= 33
                ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                : new String[]{Manifest.permission.RECORD_AUDIO};
        List<String> missing = new ArrayList<>();
        for (String permission : candidates) {
            if (activity.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (!missing.isEmpty()) activity.requestPermissions(missing.toArray(new String[0]), REQUEST_PERMISSIONS);
    }
}
