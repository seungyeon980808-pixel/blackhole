package com.malhaedwo.pttprobe;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

/**
 * 잠금화면 알림의 「완료」: 잠금을 풀지 않고 할 일을 끝낸다. 휴대폰 달력·위젯·잠금화면에는 바로 보이고
 * (Mac이 반영할 때까지 대기 동작으로 얹음), Mac에는 기존 동작 파일(*.bhact) 길로 간다. 끝내기만 하고 지우기·고치기는 없다.
 * 누른 뒤 「완료: 제목 · 되돌리기」 알림을 2분 동안 남긴다. 되돌리기는 같은 체크를 한 번 더 보내 Mac도 되돌린다.
 */
public final class BlackholeTaskReceiver extends BroadcastReceiver {
    static final String ACTION_DONE = "com.malhaedwo.pttprobe.BLACKHOLE_TASK_DONE";
    static final String EXTRA_ID = "task_id";
    static final String EXTRA_SRC = "task_src";
    static final String EXTRA_TITLE = "task_title";
    static final String ACTION_UNDO = "com.malhaedwo.pttprobe.BLACKHOLE_TASK_UNDO";
    static final int UNDO_NOTIFICATION_ID = 0x5B50;
    static final long UNDO_MS = 2 * 60_000L;

    @Override public void onReceive(Context context, Intent intent) {
        boolean undo = intent != null && ACTION_UNDO.equals(intent.getAction());
        if (intent == null || (!ACTION_DONE.equals(intent.getAction()) && !undo)) return;
        String id = intent.getStringExtra(EXTRA_ID);
        if (id == null || id.isEmpty()) return;
        Context app = context.getApplicationContext();
        String title = intent.getStringExtra(EXTRA_TITLE);
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                String at = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.ROOT).format(new Date());
                String action = BlackholeCalendarStore.completeAction("lock-" + UUID.randomUUID().toString().substring(0, 12), at, id,
                        intent.getStringExtra(EXTRA_SRC));
                if (action != null) BlackholeCalendarActions.record(app, action);
                if (undo) cancelUndo(app);
                else showUndo(app, id, intent.getStringExtra(EXTRA_SRC), title);
                app.sendBroadcast(new Intent(Blackhole.ACTION_DRAFTS).setPackage(app.getPackageName()));
                CalendarRefreshJob.publish(app);
            } catch (Exception ignored) {
                // 기록하지 못하면 알림은 그대로 남아 다시 누를 수 있다.
            } finally {
                pending.finish();
            }
        }, "BlackholeTaskDone").start();
    }

    /** 「완료: 제목」 + 되돌리기. 잠금 중에도 누를 수 있고(잠금 해제 요구 없음), 2분 뒤 스스로 사라진다. */
    static void showUndo(Context app, String id, String src, String title) {
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager == null) return;
        PendingIntent back = PendingIntent.getBroadcast(app, UNDO_NOTIFICATION_ID,
                new Intent(app, BlackholeTaskReceiver.class).setAction(ACTION_UNDO).putExtra(EXTRA_ID, id).putExtra(EXTRA_SRC, src),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Action action = new Notification.Action.Builder(null, "되돌리기", back).setAuthenticationRequired(false).build();
        Notification note = new Notification.Builder(app, BlackholeQuickNotification.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.checkbox_on_background)
                .setContentTitle(undoTitle(title))
                .setContentText("잘못 눌렀으면 되돌리기")
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setAutoCancel(true)
                .setTimeoutAfter(UNDO_MS)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_STATUS)
                .setSortKey("s")
                .addAction(action)
                .build();
        try { manager.notify(UNDO_NOTIFICATION_ID, note); } catch (SecurityException ignored) {}
    }

    static String undoTitle(String title) {
        return title == null || title.isEmpty() ? "완료했어요" : "완료: " + title;
    }

    static void cancelUndo(Context app) {
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(UNDO_NOTIFICATION_ID);
    }
}
