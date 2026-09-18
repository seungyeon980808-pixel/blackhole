package com.malhaedwo.pttprobe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class ReminderReceiver extends BroadcastReceiver {

    @Override public void onReceive(Context context, Intent intent) {
        long id = intent.getLongExtra(ReminderScheduler.EXTRA_ID, -1);
        if (id < 0) return;
        long firedReminderAt = intent.getLongExtra(ReminderScheduler.EXTRA_REMINDER_AT, 0);
        long firedGeneration = intent.getLongExtra(ReminderScheduler.EXTRA_GENERATION, 0);
        CaptureItem item = CaptureDatabase.get(context).getItem(id);
        if (item == null) return;
        ReminderScheduler.Readiness readiness = ReminderScheduler.notificationReadiness(context, true);
        boolean notificationAllowed = readiness.deliveryReady;
        if (!CalendarReliability.shouldPostReminder(item.status, item.kind, item.reminderAt,
                item.reminderGeneration, firedReminderAt, firedGeneration, notificationAllowed)) {
            if (!notificationAllowed) {
                String reason = readiness.message;
                CaptureDatabase.get(context).markReminderResult(id,
                        ReminderScheduler.Result.blocked(reason), reason);
            }
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            CaptureDatabase.get(context).markReminderResult(id,
                    ReminderScheduler.Result.blocked("NotificationManager를 사용할 수 없습니다"),
                    "NotificationManager를 사용할 수 없습니다");
            return;
        }
        Intent open = new Intent(context, InboxActivity.class).putExtra("capture_id", id);
        PendingIntent content = PendingIntent.getActivity(context, (int) id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = item.title == null || item.title.trim().isEmpty() ? "말해둬 알림" : item.title;
        String text = item.isSchedule() ? "예약한 알림 시각입니다" : "저장해 둔 할 일을 확인하세요";
        Notification notification = new Notification.Builder(context, ReminderScheduler.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setPriority(Notification.PRIORITY_HIGH)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setWhen(item.startAt > 0 ? item.startAt : item.reminderAt)
                .build();
        manager.notify(ReminderScheduler.notificationId(id), notification);
    }
}
