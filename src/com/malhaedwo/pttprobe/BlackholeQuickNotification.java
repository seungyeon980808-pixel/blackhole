package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 잠금화면에서 쓰는 고정 입력 알림: [말하기] [적기(바로 답장 = 메모 추가)] [사진].
 * 그 아래 묶음으로 오늘까지·이틀 안 마감 할 일을 몇 개(설정, 기본 켬) 보이고 항목마다 「완료」를 받는다.
 * 잠금 상태에서 되는 것은 보내기·완료 체크·메모 추가까지다. 지우기·고치기와 대화 화면은 잠금을 풀어야 열린다.
 * 할 일 제목은 위젯·잠금화면 배경과 같은 규칙(학교 일정 가리기)을 따르고, 「제목 가리기」를 켜면 「할 일 1」로만 보인다.
 */
final class BlackholeQuickNotification {
    static final String CHANNEL_ID = "blackhole_quick_v1";
    static final int NOTIFICATION_ID = 0x5B10;
    static final String KEY_TEXT = "blackhole_text";
    static final String TITLE = "블랙홀";
    static final String IDLE_TEXT = "말하기 · 적기 · 사진 — 잠금 중에는 보내기·완료 체크만 됩니다";
    static final String TASK_GROUP = "blackhole_lock_tasks";
    /** 할 일 알림 번호: TASK_BASE + 0..MAX_TASKS-1. */
    static final int TASK_BASE = 0x5B40;
    static final int MAX_TASKS = 4;

    private BlackholeQuickNotification() {}

    static boolean isEnabled(Context context) {
        return Blackhole.prefs(context).getBoolean(Blackhole.PREF_QUICK_ENABLED, false);
    }

    /** 켜고 끈다. 알림 권한이 없으면 켜지 않고 이유를 돌려준다. */
    static String setEnabled(Context context, boolean enabled) {
        if (enabled && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return "알림 권한을 먼저 허용해 주세요 (첫 화면의 「마이크·알림 권한 허용」)";
        }
        Blackhole.prefs(context).edit().putBoolean(Blackhole.PREF_QUICK_ENABLED, enabled).apply();
        if (enabled) show(context, IDLE_TEXT);
        else {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null) manager.cancel(NOTIFICATION_ID);
        }
        return null;
    }

    /** 앱 시작·재부팅·보낸 뒤에 다시 건다(안드로이드 14부터는 사용자가 밀어서 지울 수 있다). */
    static void refresh(Context context) {
        if (isEnabled(context)) show(context, IDLE_TEXT);
        // 할 일 묶음은 고정 입력 알림을 꺼 두어도 따로 보인다(설정 「잠금화면 알림에 할 일」).
        else showTasks(context, true);
    }

    /** 잠금화면에 보일 할 일: 끝내지 않은, 오늘까지(지난 것 포함)와 이틀 안 마감. */
    static List<BlackholeBoard.Line> lockTasks(String boardShared, LocalDate today, boolean hideSchool) {
        return BlackholeBoard.lockTasks(BlackholeBoard.build(boardShared, today, LocalTime.now(), hideSchool), MAX_TASKS);
    }

    /** 잠금화면에 보일 제목(가리기 설정). */
    static String lockTitle(BlackholeBoard.Line t, int index, boolean hideTitles) {
        return hideTitles ? "할 일 " + (index + 1) : t.text;
    }

    private static void showTasks(Context context, boolean on) {
        Context app = context.getApplicationContext();
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager == null) return;
        ensureChannel(manager);
        android.content.SharedPreferences prefs = Blackhole.prefs(app);
        List<BlackholeBoard.Line> tasks = on && prefs.getBoolean(BlackholeBoard.PREF_LOCK_TASKS, true)
                ? lockTasks(Blackhole.boardShared(app), LocalDate.now(), prefs.getBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, false))
                : new ArrayList<>();
        boolean hideTitles = prefs.getBoolean(BlackholeBoard.PREF_LOCK_HIDE_TITLES, false);
        for (int i = 0; i < MAX_TASKS; i++) {
            if (i >= tasks.size()) {
                manager.cancel(TASK_BASE + i);
                continue;
            }
            BlackholeBoard.Line t = tasks.get(i);
            String title = lockTitle(t, i, hideTitles);
            PendingIntent done = PendingIntent.getBroadcast(app, TASK_BASE + i,
                    new Intent(app, BlackholeTaskReceiver.class).setAction(BlackholeTaskReceiver.ACTION_DONE)
                            .putExtra(BlackholeTaskReceiver.EXTRA_ID, t.id).putExtra(BlackholeTaskReceiver.EXTRA_SRC, t.srcKey)
                            .putExtra(BlackholeTaskReceiver.EXTRA_TITLE, title),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Action check = new Notification.Action.Builder(null, "완료", done).setAuthenticationRequired(false).build();
            // 묶음 표시는 시스템에 맡긴다(삼성은 같은 앱 알림을 「블랙홀」 아래 모아 보임).
            Notification item = new Notification.Builder(app, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.checkbox_off_background)
                    .setContentTitle(title)
                    .setContentText(t.badge.isEmpty() ? "할 일" : "마감 " + t.badge)
                    .setOnlyAlertOnce(true)
                    .setShowWhen(false)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setSortKey("t" + i)
                    .addAction(check)
                    .build();
            try { manager.notify(TASK_BASE + i, item); } catch (SecurityException ignored) {}
        }
    }

    static void show(Context context, String line) {
        Context app = context.getApplicationContext();
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager == null) return;
        ensureChannel(manager);
        PendingIntent voice = PendingIntent.getActivity(app, 0x5B11,
                BlackholeLockCaptureActivity.intent(app, BlackholeLockCaptureActivity.MODE_VOICE),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent photo = PendingIntent.getActivity(app, 0x5B12,
                BlackholeLockCaptureActivity.intent(app, BlackholeLockCaptureActivity.MODE_PHOTO),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // 바로 답장은 시스템이 글을 채워 넣어야 하므로 MUTABLE이어야 한다(받는 곳은 이 앱의 비공개 수신기로 고정).
        PendingIntent reply = PendingIntent.getBroadcast(app, 0x5B13,
                new Intent(app, BlackholeReplyReceiver.class).setAction(BlackholeReplyReceiver.ACTION_REPLY),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        PendingIntent open = PendingIntent.getActivity(app, 0x5B14, new Intent(app, BlackholeSendActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        RemoteInput input = new RemoteInput.Builder(KEY_TEXT).setLabel("메모·할 일 적기").build();
        Notification.Action write = new Notification.Action.Builder(null, "적기", reply)
                .addRemoteInput(input)
                .setAllowGeneratedReplies(false)
                .setAuthenticationRequired(false)
                .build();
        Notification.Action speak = new Notification.Action.Builder(null, "말하기", voice)
                .setAuthenticationRequired(false).build();
        Notification.Action shoot = new Notification.Action.Builder(null, "사진", photo)
                .setAuthenticationRequired(false).build();
        Notification publicVersion = base(app, line).build();
        // 할 일 알림과 같은 묶음에 넣지 않는다: 삼성은 묶음 대표 알림을 숨겨 [말하기][적기][사진]이 사라진다(실기기 확인).
        Notification notification = base(app, line)
                .setContentIntent(open)
                .addAction(speak)
                .addAction(write)
                .addAction(shoot)
                .setPublicVersion(publicVersion)
                .build();
        try { manager.notify(NOTIFICATION_ID, notification); }
        catch (SecurityException ignored) {}
        showTasks(app, true);
    }

    private static void ensureChannel(NotificationManager manager) {
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "블랙홀 잠금화면 입력", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("잠금화면에서 말하기·적기·사진을 보내고 오늘 할 일을 끝내는 알림 (소리 없음)");
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    private static Notification.Builder base(Context app, String line) {
        return new Notification.Builder(app, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .setContentTitle(TITLE)
                .setContentText(line)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_SERVICE);
    }
}
