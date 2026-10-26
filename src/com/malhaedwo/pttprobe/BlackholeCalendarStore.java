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
    /** 알람 id → 달력 알림 key(「항목id@시각」). 휴대폰 알람에서 누른 것을 Mac에 돌려보낼 때 쓴다. */
    static final String PREF_ALARM_KEYS = "calendar_alarm_keys";
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

    /**
     * 사본(Mac 사본 + 휴대폰 초안)의 알림 시각 → 알람 목록 JSON([{key, atMs, title}], 달력 화면이 넘기는 것과 같은 꼴).
     * 지운 것·끝낸 할 일은 빼고, 앞으로 울릴 것만. key = 「항목id@YYYY-MM-DDTHH:MM」(Mac과 같은 규칙).
     */
    static String alarmsFromShared(String shared, long now, java.time.ZoneId zone) {
        JSONArray out = new JSONArray();
        try {
            JSONObject o = new JSONObject(shared == null || shared.isEmpty() ? "{}" : shared);
            for (String list : new String[]{"events", "tasks"}) {
                JSONArray items = o.optJSONArray(list);
                for (int i = 0; items != null && i < items.length(); i++) {
                    JSONObject x = items.optJSONObject(i);
                    if (x == null || x.optBoolean("gone", false) || x.optBoolean("sample", false) || x.optBoolean("done", false)) continue;
                    JSONArray reminders = x.optJSONArray("reminders");
                    for (int j = 0; reminders != null && j < reminders.length(); j++) {
                        String at = reminders.optString(j, "");
                        long ms;
                        try { ms = java.time.LocalDateTime.parse(at).atZone(zone).toInstant().toEpochMilli(); }
                        catch (Exception bad) { continue; }
                        if (ms <= now) continue;
                        out.put(new JSONObject().put("key", x.optString("id", "") + "@" + at).put("atMs", ms).put("title", x.optString("title", "")));
                    }
                }
            }
        } catch (Exception ignored) {}
        return out.toString();
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

    /**
     * 위젯·잠금화면용: Mac이 아직 반영하지 않은 휴대폰 체크(toggleTask)를 사본에 미리 얹는다.
     * 항목 id가 없으면 같은 원본(src)의 항목에 얹는다(휴대폰 초안 → Mac 항목).
     */
    static String withPending(String shared, String pending) {
        JSONArray list = array(pending);
        if (list.length() == 0 || shared == null || shared.isEmpty()) return shared == null ? "" : shared;
        try {
            JSONObject copy = new JSONObject(shared);
            JSONArray tasks = copy.optJSONArray("tasks");
            for (int i = 0; tasks != null && i < list.length(); i++) {
                JSONObject a = list.optJSONObject(i);
                if (a == null || !"toggleTask".equals(a.optString("type", ""))) continue;
                JSONObject hit = null;
                for (int j = 0; j < tasks.length() && hit == null; j++) {
                    JSONObject t = tasks.optJSONObject(j);
                    if (t != null && a.optString("ref", "").equals(t.optString("id", ""))) hit = t;
                }
                String src = a.optString("src", "");
                for (int j = 0; j < tasks.length() && hit == null && !src.isEmpty(); j++) {
                    JSONObject t = tasks.optJSONObject(j);
                    if (t != null && src.equals(t.optString("srcKey", "")) && !t.optBoolean("gone", false)) hit = t;
                }
                if (hit != null) hit.put("done", !hit.optBoolean("done", false));
            }
            return copy.toString();
        } catch (Exception error) {
            return shared;
        }
    }

    /** 잠금화면 「완료」: 할 일 끝내기 동작(Mac에 보내는 것과 같은 형식). */
    static String completeAction(String actionId, String at, String ref, String src) {
        try {
            JSONObject a = new JSONObject().put("id", actionId).put("at", at).put("type", "toggleTask").put("ref", ref);
            if (src != null && !src.isEmpty()) a.put("src", src);
            return a.toString();
        } catch (Exception error) {
            return null;
        }
    }

    /** 시험·한 개짜리 대기 목록. */
    static String addPendingSafe(String actionJson) {
        try { return addPending("[]", actionJson); } catch (Exception error) { return "[]"; }
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
        final String key;
        final String title;
        final long at;
        CalendarAlarm(String id, String key, String title, long at) { this.id = id; this.key = key; this.title = title; this.at = at; }
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
            out.add(new CalendarAlarm(alarmId(key), key, title.isEmpty() ? "블랙홀 알림" : title, at.longValue()));
        }
        return out;
    }

    /** 두 알람 목록을 합친다(같은 key는 한 번, 앞 목록 먼저). */
    static List<CalendarAlarm> union(List<CalendarAlarm> a, List<CalendarAlarm> b) {
        List<CalendarAlarm> out = new ArrayList<>(a);
        Set<String> keys = new HashSet<>();
        for (CalendarAlarm x : a) keys.add(x.key);
        for (CalendarAlarm x : b) if (keys.add(x.key) && out.size() < MAX_ALARMS) out.add(x);
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

    /** 알람 id → key 표(JSON)를 이번에 건 알람으로 바꾼다. */
    static String keys(List<CalendarAlarm> alarms) {
        JSONObject out = new JSONObject();
        try { for (CalendarAlarm alarm : alarms) out.put(alarm.id, alarm.key); } catch (Exception ignored) {}
        return out.toString();
    }

    /**
     * 휴대폰 알람에서 누른 것(확인·완료·10분 뒤)을 Mac에 보낼 동작으로. 달력 알람이 아니면 null.
     * 「확인」은 울림만 끝내고(할 일은 그대로), 「완료」는 할 일을 끝내며, 「10분 뒤」는 Mac 달력에도 다시 알림을 건다.
     */
    static String alarmAction(String keysJson, String alarmId, String answer, String actionId, String at) {
        try {
            String key = new JSONObject(keysJson == null || keysJson.isEmpty() ? "{}" : keysJson).optString(alarmId, "");
            int split = key.indexOf('@');
            if (key.isEmpty() || split <= 0) return null;
            return new JSONObject().put("id", actionId).put("at", at).put("type", "alarm")
                    .put("ref", key.substring(0, split)).put("key", key).put("answer", answer).toString();
        } catch (Exception error) {
            return null;
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
