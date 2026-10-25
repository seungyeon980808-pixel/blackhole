package com.malhaedwo.pttprobe;

import android.content.Context;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

/**
 * 휴대폰에서 손으로 바꾼 것(달력 화면의 확정·체크, 알람의 확인·완료·10분 뒤)을 Mac에 보낸다.
 * Mac이 반영할 때까지 대기 목록에 두고, 「*.bhact」 작은 파일로 드라이브 인박스에 올린다(Mac 블랙홀 앱이 읽음).
 */
final class BlackholeCalendarActions {
    private static final Object LOCK = new Object();

    private BlackholeCalendarActions() {}

    static void record(Context context, String actionJson) throws Exception {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            String pending = BlackholeCalendarStore.addPending(
                    Blackhole.prefs(app).getString(BlackholeCalendarStore.PREF_PENDING, "[]"), actionJson);
            Blackhole.prefs(app).edit().putString(BlackholeCalendarStore.PREF_PENDING, pending).commit();
        }
        Blackhole.outbox(app).addStream(new ByteArrayInputStream(actionJson.getBytes(StandardCharsets.UTF_8)),
                BlackholeOutbox.KIND_FILE, BlackholeOutbox.SOURCE_CHAT, "동작.bhact", "application/json", System.currentTimeMillis());
        Blackhole.requestUpload(app);
    }

    /** 달력 알람(cal-…)에서 누른 것. 다른 알람이면 아무것도 안 한다. */
    static void alarmAnswered(Context context, String alarmId, String answer) {
        if (alarmId == null || !alarmId.startsWith(BlackholeCalendarStore.ALARM_PREFIX)) return;
        Context app = context.getApplicationContext();
        String at = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.ROOT).format(new Date());
        String action = BlackholeCalendarStore.alarmAction(Blackhole.prefs(app).getString(BlackholeCalendarStore.PREF_ALARM_KEYS, "{}"),
                alarmId, answer, "alarm-" + UUID.randomUUID().toString().substring(0, 12), at);
        if (action == null) return;
        try { record(app, action); } catch (Exception ignored) {}
    }
}
