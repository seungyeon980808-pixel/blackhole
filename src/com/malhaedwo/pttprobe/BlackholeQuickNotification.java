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

/**
 * 잠금화면에서 쓰는 고정 입력 알림: [말하기] [적기(바로 답장)] [사진].
 * 잠금 상태에서는 보내기만 된다. 알림에는 지난 내용이 한 글자도 들어가지 않으며(공개 판도 같은 문구),
 * 알림을 눌러 여는 대화 화면은 잠금을 풀어야 열린다.
 */
final class BlackholeQuickNotification {
    static final String CHANNEL_ID = "blackhole_quick_v1";
    static final int NOTIFICATION_ID = 0x5B10;
    static final String KEY_TEXT = "blackhole_text";
    static final String TITLE = "블랙홀";
    static final String IDLE_TEXT = "말하기 · 적기 · 사진 — 잠금 중에는 보내기만 됩니다";

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
    }

    static void show(Context context, String line) {
        Context app = context.getApplicationContext();
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "블랙홀 잠금화면 입력", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("잠금화면에서 말하기·적기·사진을 보내는 고정 알림 (소리 없음)");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(channel);
        }
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
        RemoteInput input = new RemoteInput.Builder(KEY_TEXT).setLabel("블랙홀에 적기").build();
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
        Notification notification = base(app, line)
                .setContentIntent(open)
                .addAction(speak)
                .addAction(write)
                .addAction(shoot)
                .setPublicVersion(publicVersion)
                .build();
        try { manager.notify(NOTIFICATION_ID, notification); }
        catch (SecurityException ignored) {}
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
