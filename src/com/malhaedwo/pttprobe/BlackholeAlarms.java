package com.malhaedwo.pttprobe;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 블랙홀 전화식 알람. setAlarmClock 정확 알람 → 전체 화면 알림(BlackholeAlarmActivity).
 * 소리는 알람 오디오 스트림(USAGE_ALARM)으로, 소리·진동은 FLAG_INSISTENT로 「확인/완료/10분 뒤」를 누를 때까지 반복한다.
 * 화면이 켜져 있거나 전체 화면 알림 권한이 없으면 시스템이 위쪽 알림으로 대신 띄우지만 소리·진동은 같다.
 */
final class BlackholeAlarms {
    static final String CHANNEL_ID = "blackhole_alarm_v1";
    static final String ACTION_FIRE = "com.malhaedwo.pttprobe.BLACKHOLE_ALARM_FIRE";
    static final String ACTION_ACK = "com.malhaedwo.pttprobe.BLACKHOLE_ALARM_ACK";
    static final String ACTION_DONE = "com.malhaedwo.pttprobe.BLACKHOLE_ALARM_DONE";
    static final String ACTION_SNOOZE = "com.malhaedwo.pttprobe.BLACKHOLE_ALARM_SNOOZE";
    static final String ACTION_CLOSED = "com.malhaedwo.pttprobe.BLACKHOLE_ALARM_CLOSED";
    static final String EXTRA_ID = "alarm_id";
    static final long[] VIBRATION = {0, 900, 600, 900, 600};
    /** 아무도 안 누르면 이만큼 울린 뒤 그친다(전화 수신과 비슷하게). */
    static final long RING_TIMEOUT_MS = 5 * 60_000L;

    private static final Object LOCK = new Object();

    private BlackholeAlarms() {}

    static final class Result {
        final boolean ok;
        final String message;
        Result(boolean ok, String message) { this.ok = ok; this.message = message; }
    }

    static BlackholeAlarmBook load(Context context) {
        return BlackholeAlarmBook.parse(Blackhole.prefs(context).getString(Blackhole.PREF_ALARMS, ""));
    }

    static void save(Context context, BlackholeAlarmBook book) {
        Blackhole.prefs(context).edit().putString(Blackhole.PREF_ALARMS, book.serialize()).commit();
    }

    static boolean canExact(Context context) {
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        return manager != null && manager.canScheduleExactAlarms();
    }

    /** 안드로이드 14(API 34)부터 전화·알람 앱이 아니면 사용자가 「전체 화면 알림」을 따로 허용해야 한다. */
    static boolean canFullScreen(Context context) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager != null && manager.canUseFullScreenIntent();
    }

    static Result schedule(Context context, String id, String title, long at) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            BlackholeAlarmBook book = load(app);
            book.schedule(id, title, at);
            save(app, book);
            return arm(app, id, at);
        }
    }

    static void cancel(Context context, String id) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            BlackholeAlarmBook book = load(app);
            book.cancel(id);
            save(app, book);
        }
        AlarmManager manager = app.getSystemService(AlarmManager.class);
        if (manager != null) manager.cancel(firePending(app, id));
        stopRinging(app, id);
    }

    /** 재부팅·앱 교체·시간 변경 뒤 다시 건다. */
    static void restoreAll(Context context) {
        Context app = context.getApplicationContext();
        List<BlackholeAlarmBook.Alarm> again;
        synchronized (LOCK) {
            BlackholeAlarmBook book = load(app);
            again = book.restore(System.currentTimeMillis());
            save(app, book);
        }
        for (BlackholeAlarmBook.Alarm alarm : again) arm(app, alarm.id, alarm.at);
    }

    private static Result arm(Context app, String id, long at) {
        AlarmManager manager = app.getSystemService(AlarmManager.class);
        if (manager == null) return new Result(false, "AlarmManager를 쓸 수 없습니다");
        if (!manager.canScheduleExactAlarms()) return new Result(false, "「알람 및 리마인더」 권한이 꺼져 있어 알람을 걸지 못했습니다");
        PendingIntent show = PendingIntent.getActivity(app, BlackholeAlarmBook.requestCode(id) ^ 1,
                new Intent(app, BlackholeSendActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            manager.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), firePending(app, id));
        } catch (SecurityException denied) {
            return new Result(false, "알람 권한이 없어 걸지 못했습니다");
        }
        return new Result(true, new SimpleDateFormat("M월 d일 HH:mm", Locale.KOREA).format(new Date(at)) + "에 울립니다");
    }

    private static PendingIntent firePending(Context app, String id) {
        Intent fire = new Intent(app, BlackholeAlarmReceiver.class).setAction(ACTION_FIRE).putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(app, BlackholeAlarmBook.requestCode(id), fire,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 알람 시각: 장부를 「울리는 중」으로 바꾸고 전체 화면 알림을 건다. 이미 끝낸 알람이면 아무것도 안 한다. */
    static void fire(Context context, String id) {
        Context app = context.getApplicationContext();
        BlackholeAlarmBook.Alarm alarm;
        synchronized (LOCK) {
            BlackholeAlarmBook book = load(app);
            if (!book.startRinging(id, System.currentTimeMillis())) return;
            save(app, book);
            alarm = book.get(id);
        }
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager == null) return;
        ensureChannel(manager);
        Intent screen = BlackholeAlarmActivity.intent(app, id);
        PendingIntent fullScreen = PendingIntent.getActivity(app, BlackholeAlarmBook.requestCode(id) ^ 2, screen,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = alarm.title.isEmpty() ? "블랙홀 알람" : alarm.title;
        String when = new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date(System.currentTimeMillis()));
        Notification notification = new Notification.Builder(app, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(title)
                .setContentText(when + " · 블랙홀 알람")
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setTimeoutAfter(RING_TIMEOUT_MS)
                .setFullScreenIntent(fullScreen, true)
                .setContentIntent(fullScreen)
                .addAction(action(app, id, ACTION_ACK, "확인"))
                .addAction(action(app, id, ACTION_DONE, "완료"))
                .addAction(action(app, id, ACTION_SNOOZE, "10분 뒤"))
                .build();
        notification.flags |= Notification.FLAG_INSISTENT;
        try { manager.notify(notificationId(id), notification); }
        catch (SecurityException ignored) {}
    }

    private static Notification.Action action(Context app, String id, String action, String label) {
        Intent intent = new Intent(app, BlackholeAlarmReceiver.class).setAction(action).putExtra(EXTRA_ID, id);
        int code = BlackholeAlarmBook.requestCode(id) ^ (ACTION_ACK.equals(action) ? 0x10 : ACTION_DONE.equals(action) ? 0x20 : 0x30);
        PendingIntent pending = PendingIntent.getBroadcast(app, code, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(null, label, pending).build();
    }

    /** 「확인/완료/10분 뒤」. 알림을 내려 소리·진동을 멈추고, 열려 있는 알람 화면도 닫는다. */
    static String handle(Context context, String id, String action) {
        Context app = context.getApplicationContext();
        String message;
        synchronized (LOCK) {
            BlackholeAlarmBook book = load(app);
            if (ACTION_SNOOZE.equals(action)) {
                BlackholeAlarmBook.Alarm alarm = book.snooze(id, System.currentTimeMillis());
                save(app, book);
                message = alarm == null ? "알람을 찾지 못했습니다" : arm(app, id, alarm.at).message;
            } else if (ACTION_DONE.equals(action)) {
                book.complete(id);
                save(app, book);
                message = "완료로 표시했습니다";
            } else {
                book.acknowledge(id);
                save(app, book);
                message = "확인했습니다";
            }
        }
        stopRinging(app, id);
        BlackholeCalendarActions.alarmAnswered(app, id,
                ACTION_SNOOZE.equals(action) ? "snooze" : ACTION_DONE.equals(action) ? "done" : "ack");
        return message;
    }

    static void stopRinging(Context app, String id) {
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(notificationId(id));
        app.sendBroadcast(new Intent(ACTION_CLOSED).putExtra(EXTRA_ID, id).setPackage(app.getPackageName()));
    }

    static int notificationId(String id) { return BlackholeAlarmBook.requestCode(id); }

    private static void ensureChannel(NotificationManager manager) {
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "블랙홀 알람 (전화처럼 울림)", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("정해 둔 시각에 전체 화면으로 뜨고, 누를 때까지 소리·진동을 반복합니다");
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        channel.setSound(sound, attributes);
        channel.enableVibration(true);
        channel.setVibrationPattern(VIBRATION);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setBypassDnd(true);
        manager.createNotificationChannel(channel);
    }
}
