package com.malhaedwo.pttprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 휴대폰 블랙홀 달력의 순수 규칙(안드로이드 API 없음, 호스트 시험 대상).
 * Mac이 드라이브 「블랙홀/달력.json」에 둔 사본을 확인하고, 휴대폰에서 손으로 바꾼 것(확정·체크…)을
 * Mac이 반영할 때까지 들고 있으며, 달력의 알림 시각을 전화식 알람 목록으로 바꾼다.
 */
final class BlackholeCalendarStore {
    static final String PREF_SHARED = "calendar_shared";
    static final String PREF_PENDING = "calendar_pending_actions";
    static final String PREF_ALARM_IDS = "calendar_alarm_ids";
    static final String PREF_STATUS = "calendar_sync_status";
    static final String ALARM_PREFIX = "cal-";
    /** 한 번에 거는 달력 알람 수 상한(알람 장부가 너무 커지지 않게). */
    static final int MAX_ALARMS = 100;

    private BlackholeCalendarStore() {}

    /** Mac 사본 형식(kind·schemaVersion·events 등)이 맞으면 true. 빈 파일 「{}」은 아직 Mac이 안 쓴 것. */
    static boolean isShared(String json) {
        try {
            JSONObject o = new JSONObject(json == null || json.isEmpty() ? "{}" : json);
            Number version = number(o.opt("schemaVersion"));
            return "blackhole-calendar".equals(o.optString("kind")) && version != null && version.doubleValue() == 1
                    && o.optJSONArray("events") != null && o.optJSONArray("tasks") != null
                    && o.optJSONArray("periods") != null && o.optJSONArray("notes") != null;
        } catch (Exception error) {
            return false;
        }
    }

    static String exportedAt(String shared) {
        try { return new JSONObject(shared).optString("exportedAt", ""); } catch (Exception error) { return ""; }
    }

    /** 대기 목록에 동작 하나를 더한다(같은 id는 한 번). */
    static String addPending(String pending, String actionJson) throws Exception {
        JSONObject action = new JSONObject(actionJson);
        String id = action.optString("id", "");
        if (id.isEmpty() || action.optString("type", "").isEmpty()) throw new Exception("동작 형식이 아닙니다");
        JSONArray list = array(pending);
        for (int i = 0; i < list.length(); i++) {
            JSONObject x = list.optJSONObject(i);
            if (x != null && id.equals(x.optString("id", ""))) return list.toString();
        }
        list.put(action);
        return list.toString();
    }

    /** Mac 사본의 appliedActions에 들어간 동작은 대기 목록에서 뺀다. */
    static String prune(String pending, String shared) {
        Set<String> applied = new HashSet<>();
        try {
            JSONArray done = new JSONObject(shared).optJSONArray("appliedActions");
            if (done != null) for (int i = 0; i < done.length(); i++) applied.add(done.optString(i, ""));
        } catch (Exception ignored) {}
        JSONArray kept = new JSONArray();
        JSONArray list = array(pending);
        for (int i = 0; i < list.length(); i++) {
            JSONObject x = list.optJSONObject(i);
            if (x != null && !applied.contains(x.optString("id", ""))) kept.put(x);
        }
        return kept.toString();
    }

    static final class CalendarAlarm {
        final String id;
        final String title;
        final long at;
        CalendarAlarm(String id, String title, long at) { this.id = id; this.title = title; this.at = at; }
    }

    /** 달력이 넘긴 알림 목록([{key, atMs, title}]) 중 앞으로 울릴 것만, 같은 key는 같은 알람 id로. */
    static List<CalendarAlarm> alarms(String json, long now) {
        List<CalendarAlarm> out = new ArrayList<>();
        JSONArray list = array(json);
        for (int i = 0; i < list.length() && out.size() < MAX_ALARMS; i++) {
            JSONObject x = list.optJSONObject(i);
            if (x == null) continue;
            Number at = number(x.opt("atMs"));
            String key = x.optString("key", "");
            String title = x.optString("title", "");
            if (at == null || key.isEmpty() || at.longValue() <= now) continue;
            out.add(new CalendarAlarm(alarmId(key), title.isEmpty() ? "블랙홀 알림" : title, at.longValue()));
        }
        return out;
    }

    static String alarmId(String key) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(ALARM_PREFIX);
            for (int i = 0; i < 8; i++) hex.append(String.format("%02x", hash[i]));
            return hex.toString();
        } catch (Exception error) {
            return ALARM_PREFIX + Integer.toHexString(key.hashCode());
        }
    }

    /** 쉼표로 이은 알람 id 목록. */
    static List<String> ids(String joined) {
        List<String> out = new ArrayList<>();
        if (joined == null) return out;
        for (String id : joined.split(",")) if (id.startsWith(ALARM_PREFIX)) out.add(id);
        return out;
    }

    private static JSONArray array(String json) {
        try { return new JSONArray(json == null || json.isEmpty() ? "[]" : json); } catch (Exception error) { return new JSONArray(); }
    }

    private static Number number(Object value) {
        if (value instanceof Number) return (Number) value;
        try { return value == null ? null : Double.valueOf(String.valueOf(value)); } catch (Exception error) { return null; }
    }
}
