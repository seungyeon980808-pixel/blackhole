package com.malhaedwo.pttprobe;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 블랙홀 전화식 알람의 장부(안드로이드 없이 시험 가능한 부분). 한 줄 = 알람 하나,
 * 「id|울릴시각|상태|제목」을 URL 인코딩해서 저장한다. 재부팅 뒤 다시 걸 알람, 10분 뒤 미루기, 놓친 알람을 계산한다.
 * 승인 DB와는 따로 두며, 「완료」 기록은 나중 단계에서 Mac 쪽으로 돌려보낼 때 쓴다.
 */
final class BlackholeAlarmBook {
    static final String SCHEDULED = "SCHEDULED";
    static final String SNOOZED = "SNOOZED";
    static final String RINGING = "RINGING";
    static final String ACKNOWLEDGED = "ACKNOWLEDGED";
    static final String DONE = "DONE";
    static final String MISSED = "MISSED";
    static final long SNOOZE_MS = 10 * 60_000L;
    /** 재부팅 등으로 늦게 깨어났을 때 이만큼 지난 알람까지는 바로 울린다. 더 지난 것은 놓친 알람. */
    static final long LATE_GRACE_MS = 10 * 60_000L;
    static final int MAX_KEPT = 200;

    static final class Alarm {
        final String id;
        long at;
        String state;
        String title;
        Alarm(String id, long at, String state, String title) {
            this.id = id;
            this.at = at;
            this.state = state;
            this.title = title == null ? "" : title;
        }
        boolean waiting() { return SCHEDULED.equals(state) || SNOOZED.equals(state); }
    }

    private final LinkedHashMap<String,Alarm> alarms = new LinkedHashMap<>();

    static BlackholeAlarmBook parse(String stored) {
        BlackholeAlarmBook book = new BlackholeAlarmBook();
        if (stored == null) return book;
        for (String line : stored.split("\n")) {
            String[] parts = line.split("\\|", -1);
            if (parts.length != 4 || parts[0].isEmpty()) continue;
            try {
                book.alarms.put(parts[0], new Alarm(parts[0], Long.parseLong(parts[1]), parts[2], decode(parts[3])));
            } catch (NumberFormatException ignored) {}
        }
        return book;
    }

    String serialize() {
        StringBuilder out = new StringBuilder();
        for (Alarm alarm : alarms.values()) {
            out.append(alarm.id.replace("|", "_").replace("\n", "_")).append('|').append(alarm.at).append('|')
                    .append(alarm.state).append('|').append(encode(alarm.title)).append('\n');
        }
        return out.toString();
    }

    Alarm get(String id) { return alarms.get(id); }

    List<Alarm> all() { return new ArrayList<>(alarms.values()); }

    Alarm schedule(String id, String title, long at) {
        Alarm alarm = new Alarm(id, at, SCHEDULED, title);
        alarms.remove(id);
        alarms.put(id, alarm);
        trim();
        return alarm;
    }

    /** 울리기 시작. 이미 끝낸(확인·완료) 알람이 늦게 와서 다시 울리는 일은 막는다. */
    boolean startRinging(String id, long firedAt) {
        Alarm alarm = alarms.get(id);
        if (alarm == null || !alarm.waiting()) return false;
        alarm.state = RINGING;
        return true;
    }

    Alarm snooze(String id, long now) {
        Alarm alarm = alarms.get(id);
        if (alarm == null) return null;
        alarm.at = now + SNOOZE_MS;
        alarm.state = SNOOZED;
        return alarm;
    }

    Alarm acknowledge(String id) { return finish(id, ACKNOWLEDGED); }

    Alarm complete(String id) { return finish(id, DONE); }

    private Alarm finish(String id, String state) {
        Alarm alarm = alarms.get(id);
        if (alarm != null) alarm.state = state;
        return alarm;
    }

    Alarm cancel(String id) { return alarms.remove(id); }

    /**
     * 재부팅·시간 변경 뒤: 다시 걸어야 할 알람(아직 안 울렸고, 늦어도 LATE_GRACE_MS 안쪽)을 돌려주고,
     * 너무 지난 것은 놓친 알람으로 바꾼다. 울리던 중 꺼진 알람도 다시 울린다.
     */
    List<Alarm> restore(long now) {
        List<Alarm> out = new ArrayList<>();
        for (Alarm alarm : alarms.values()) {
            if (RINGING.equals(alarm.state)) alarm.state = SNOOZED;
            if (!alarm.waiting()) continue;
            if (alarm.at < now - LATE_GRACE_MS) alarm.state = MISSED;
            else out.add(alarm);
        }
        Collections.sort(out, (a, b) -> Long.compare(a.at, b.at));
        return out;
    }

    Alarm next(long now) {
        Alarm best = null;
        for (Alarm alarm : alarms.values()) {
            if (alarm.waiting() && alarm.at >= now - LATE_GRACE_MS && (best == null || alarm.at < best.at)) best = alarm;
        }
        return best;
    }

    /** PendingIntent 요청 번호. 같은 id는 늘 같은 번호, 다른 알림 번호(ReminderScheduler)와 겹치지 않게 띠를 둔다. */
    static int requestCode(String id) {
        return 0x5B000000 | (id == null ? 0 : id.hashCode() & 0x00FFFFFF);
    }

    private void trim() {
        if (alarms.size() <= MAX_KEPT) return;
        List<String> drop = new ArrayList<>();
        int excess = alarms.size() - MAX_KEPT;
        for (Map.Entry<String,Alarm> entry : alarms.entrySet()) {
            if (excess <= drop.size()) break;
            if (!entry.getValue().waiting() && !RINGING.equals(entry.getValue().state)) drop.add(entry.getKey());
        }
        for (String id : drop) alarms.remove(id);
    }

    private static String encode(String value) {
        try { return URLEncoder.encode(value == null ? "" : value, "UTF-8"); }
        catch (Exception error) { return ""; }
    }

    private static String decode(String value) {
        try { return URLDecoder.decode(value, "UTF-8"); }
        catch (Exception error) { return ""; }
    }
}
