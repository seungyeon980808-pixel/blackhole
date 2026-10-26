package com.malhaedwo.pttprobe;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import java.util.List;

public final class ReminderScheduler {
    public static final String ACTION_REMIND = "com.malhaedwo.pttprobe.REMIND";
    public static final String EXTRA_ID = "capture_id";
    public static final String EXTRA_REMINDER_AT = "reminder_at";
    public static final String EXTRA_GENERATION = "reminder_generation";
    public static final String CHANNEL_ID = "malhaedwo_reminders";
    static final String CHANNEL_NAME = "블랙홀 일정·할 일 알림";

    private ReminderScheduler() {}

    public static Result schedule(Context context, CaptureItem item) {
        long now = System.currentTimeMillis();
        if (item == null || !item.isReminderEligible(now) || item.reminderGeneration <= 0) return Result.none();
        Readiness readiness = notificationReadiness(context, true);
        if (!readiness.deliveryReady) {
            cancel(context, item.id);
            return Result.blocked(readiness.message);
        }
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        if (manager == null) return Result.blocked("AlarmManager를 사용할 수 없습니다");
        cancel(context, item.id);
        PendingIntent operation = pendingIntent(context, item.id, item.reminderAt, item.reminderGeneration,
                PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            if (manager.canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.reminderAt, operation);
                return Result.exact(readiness.message);
            }
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.reminderAt, operation);
            return Result.inexact("정확한 알람 특별 접근이 없어 정시 알림 불가 · 대체 예약했습니다" +
                    (readiness.message.isEmpty() ? "" : " · " + readiness.message));
        } catch (SecurityException error) {
            cancel(context, item.id);
            return Result.blocked("정확한 알람을 예약할 권한이 없습니다: " + safe(error));
        } catch (Throwable error) {
            cancel(context, item.id);
            return Result.blocked("알림 예약 실패: " + safe(error));
        }
    }

    /** Cancels this record's future alarm and withdraws its already-posted notification. */
    public static void cancel(Context context, long id) {
        try {
            cancelAlarmOnly(context, id);
        } finally {
            NotificationManager notifications = context.getSystemService(NotificationManager.class);
            if (notifications != null) notifications.cancel(notificationId(id));
        }
    }

    /** For reconciliation of an elapsed reminder, not an explicit cancellation. */
    static void cancelAlarmOnly(Context context, long id) {
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        if (manager == null) return;
        PendingIntent operation = pendingIntent(context, id, 0, 0, PendingIntent.FLAG_NO_CREATE);
        if (operation != null) manager.cancel(operation);
    }

    // Keep the pre-existing ID mapping so notifications posted by older APKs can be withdrawn.
    static int notificationId(long id) {
        return (int) (10_000 + id);
    }

    public static void rescheduleAll(Context context) {
        List<CaptureItem> items = CaptureDatabase.get(context).listFutureReminders(System.currentTimeMillis());
        for (CaptureItem item : items) {
            CaptureItem token = CaptureDatabase.get(context).prepareReminder(item.id, System.currentTimeMillis());
            Result result = schedule(context, token);
            CaptureDatabase.get(context).markReminderResult(item.id, result, result.message);
        }
    }

    static boolean notificationsAllowed(Context context) {
        return notificationReadiness(context, false).deliveryReady;
    }

    /** Creates the channel before alarm scheduling; user channel/DND overrides remain authoritative. */
    static Readiness notificationReadiness(Context context, boolean ensureChannel) {
        if (context == null) return Readiness.blocked("알림 컨텍스트를 사용할 수 없습니다");
        if (android.os.Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(
                android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return Readiness.blocked("알림 권한이 없어 기기 알림을 예약하지 않았습니다");
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return Readiness.blocked("NotificationManager를 사용할 수 없습니다");
        if (!manager.areNotificationsEnabled()) return Readiness.blocked("앱 알림이 시스템 설정에서 꺼져 있습니다");
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel != null && !CHANNEL_NAME.contentEquals(channel.getName())) {
            // 옛 이름(말해둬)으로 만든 채널: 이름만 바꾼다(사용자가 정한 중요도·소리는 그대로).
            NotificationChannel renamed = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, channel.getImportance());
            renamed.setDescription(channel.getDescription());
            manager.createNotificationChannel(renamed);
            channel = manager.getNotificationChannel(CHANNEL_ID);
        }
        if (channel == null && ensureChannel) {
            channel = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("음성으로 저장한 일정과 할 일 알림");
            channel.enableVibration(true);
            manager.createNotificationChannel(channel);
            channel = manager.getNotificationChannel(CHANNEL_ID);
        }
        if (channel == null) return Readiness.blocked(ensureChannel
                ? "알림 채널을 만들지 못했습니다"
                : "첫 알림 예약 시 채널 준비");
        if (channel.getImportance() == NotificationManager.IMPORTANCE_NONE)
            return Readiness.blocked("일정 알림 채널이 시스템 설정에서 꺼져 있습니다");
        String warning = channel.getImportance() < NotificationManager.IMPORTANCE_HIGH
                ? "알림 채널 중요도가 낮아 상단 팝업이 표시되지 않을 수 있습니다" : "";
        if (!channel.shouldVibrate()) return Readiness.deliveryOnly(
                (warning.isEmpty() ? "" : warning + " · ") + "일정 알림 채널의 진동이 꺼져 있습니다");
        return new Readiness(true, true, warning);
    }

    static final class Readiness {
        final boolean deliveryReady;
        final boolean vibrationReady;
        final String message;
        private Readiness(boolean deliveryReady, boolean vibrationReady, String message) {
            this.deliveryReady = deliveryReady; this.vibrationReady = vibrationReady; this.message = message;
        }
        static Readiness ready() { return new Readiness(true, true, ""); }
        static Readiness deliveryOnly(String message) { return new Readiness(true, false, message); }
        static Readiness blocked(String message) { return new Readiness(false, false, message); }
    }

    private static PendingIntent pendingIntent(Context context, long id, long reminderAt,
                                               long generation, int behaviorFlag) {
        Intent intent = new Intent(context, ReminderReceiver.class)
                .setAction(ACTION_REMIND)
                .setData(Uri.parse("malhaedwo://reminder/" + id))
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_REMINDER_AT, reminderAt)
                .putExtra(EXTRA_GENERATION, generation);
        return PendingIntent.getBroadcast(context, requestCode(id), intent,
                behaviorFlag | PendingIntent.FLAG_IMMUTABLE);
    }

    private static int requestCode(long id) { return (int) (id ^ (id >>> 32)); }

    private static String safe(Throwable error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    public static final class Result {
        public final String state;
        public final String message;

        private Result(String state, String message) {
            this.state = state;
            this.message = message;
        }

        public static Result none() { return new Result(CalendarReliability.REMINDER_NONE, ""); }
        public static Result exact() { return exact(""); }
        public static Result exact(String warning) { return new Result(CalendarReliability.REMINDER_EXACT, warning); }
        public static Result inexact(String message) {
            return new Result(CalendarReliability.REMINDER_INEXACT_DEGRADED, message);
        }
        public static Result blocked(String message) {
            return new Result(CalendarReliability.REMINDER_BLOCKED, message);
        }
    }
}
