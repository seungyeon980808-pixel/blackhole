package com.malhaedwo.pttprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 4단계 가승인 루프의 계산(안드로이드 API 없음, 호스트 시험 대상).
 * Mac 사본의 일정 중 가승인은 「가승인 캘린더」, 확정된 일정과 기간은 「본 캘린더」에 둔다. 취소·되돌린 것은 뺀다.
 * 이 앱이 만든 일정(장부에 있는 것)만 바꾸거나 지우며, 사용자가 직접 넣은 일정은 건드리지 않는다.
 * 실제 쓰기는 CalendarMirrorWriter(안드로이드 캘린더 → 구글 캘린더 동기화)가 한다.
 */
final class BlackholeCalendarMirror {
    static final String PREF_ENABLED = "mirror_enabled";
    static final String PREF_PROVISIONAL = "mirror_provisional_calendar";
    static final String PREF_MAIN = "mirror_main_calendar";
    static final String PREF_PLACED = "mirror_placed";
    static final String PREF_STATUS = "mirror_status";
    /** 한 번에 반영하는 일정 수 상한(사본이 커져도 캘린더를 한꺼번에 흔들지 않게). */
    static final int MAX_EVENTS = 1000;

    private BlackholeCalendarMirror() {}

    /** 캘린더에 둘 일정 하나. 시각은 epoch ms, 종일이면 UTC 자정 기준(안드로이드 캘린더 규칙). */
    static final class Want {
        String entryId;
        boolean provisional;
        boolean allDay;
        String title;
        long start;
        long end;
        String hash;
    }

    /** 장부: 이 앱이 캘린더에 넣은 일정. */
    static final class Placed {
        String entryId;
        long calendarId;
        long eventId;
        String hash;
    }

    enum Kind { INSERT, UPDATE, DELETE }

    static final class Op {
        final Kind kind;
        final Want want;
        final Placed placed;
        final long calendarId;
        Op(Kind kind, Want want, Placed placed, long calendarId) {
            this.kind = kind;
            this.want = want;
            this.placed = placed;
            this.calendarId = calendarId;
        }
    }

    /** Mac 사본에서 캘린더에 둘 것: 지워지지 않은 일정(가승인/확정)과 기간. 가짜 자료는 사본에 없다. */
    static List<Want> wanted(String sharedJson, ZoneId zone) {
        List<Want> out = new ArrayList<>();
        JSONObject shared;
        try { shared = new JSONObject(sharedJson); } catch (Exception error) { return out; }
        JSONArray events = shared.optJSONArray("events");
        for (int i = 0; events != null && i < events.length() && out.size() < MAX_EVENTS; i++) {
            JSONObject e = events.optJSONObject(i);
            if (e == null || e.optBoolean("gone", false) || e.optBoolean("sample", false)) continue;
            try {
                LocalDate date = LocalDate.parse(e.optString("date", ""));
                Want w = new Want();
                w.entryId = e.optString("id", "");
                w.title = e.optString("title", "");
                w.provisional = e.optBoolean("provisional", false);
                String start = e.optString("start", "");
                String end = e.optString("end", "");
                if (start.isEmpty() || "null".equals(start)) {
                    w.allDay = true;
                    w.start = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
                    w.end = date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
                } else {
                    LocalTime s = LocalTime.parse(start);
                    LocalTime f = end.isEmpty() || "null".equals(end) ? s.plusHours(1) : LocalTime.parse(end);
                    w.start = date.atTime(s).atZone(zone).toInstant().toEpochMilli();
                    w.end = date.atTime(f).atZone(zone).toInstant().toEpochMilli();
                    if (w.end <= w.start) w.end = w.start + 3_600_000L;
                }
                if (w.entryId.isEmpty() || w.title.isEmpty()) continue;
                w.hash = hash(w);
                out.add(w);
            } catch (Exception skip) {
                // 날짜 형식이 틀린 일정은 캘린더에 두지 않는다.
            }
        }
        JSONArray periods = shared.optJSONArray("periods");
        for (int i = 0; periods != null && i < periods.length() && out.size() < MAX_EVENTS; i++) {
            JSONObject p = periods.optJSONObject(i);
            if (p == null || p.optBoolean("gone", false) || p.optBoolean("sample", false)) continue;
            try {
                LocalDate from = LocalDate.parse(p.optString("from", ""));
                LocalDate to = LocalDate.parse(p.optString("to", ""));
                Want w = new Want();
                w.entryId = p.optString("id", "");
                w.title = p.optString("title", "");
                w.allDay = true;
                w.start = from.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
                w.end = (to.isBefore(from) ? from : to).plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
                if (w.entryId.isEmpty() || w.title.isEmpty()) continue;
                w.hash = hash(w);
                out.add(w);
            } catch (Exception skip) {}
        }
        return out;
    }

    /**
     * 할 일 목록. 가승인 → 가승인 캘린더, 확정·기간 → 본 캘린더. 캘린더가 바뀌면(확정) 지우고 새로 넣는다.
     * 두 캘린더가 같거나 정해지지 않았으면 아무것도 하지 않는다(본 캘린더를 가승인으로 더럽히지 않게).
     */
    static List<Op> plan(List<Want> wanted, Map<String,Placed> placed, long provisionalCalendar, long mainCalendar) {
        List<Op> ops = new ArrayList<>();
        if (provisionalCalendar < 0 || mainCalendar < 0 || provisionalCalendar == mainCalendar) return ops;
        Set<String> seen = new HashSet<>();
        for (Want w : wanted) {
            seen.add(w.entryId);
            long target = w.provisional ? provisionalCalendar : mainCalendar;
            Placed p = placed.get(w.entryId);
            if (p == null) {
                ops.add(new Op(Kind.INSERT, w, null, target));
            } else if (p.calendarId != target) {
                ops.add(new Op(Kind.DELETE, null, p, p.calendarId));
                ops.add(new Op(Kind.INSERT, w, null, target));
            } else if (!w.hash.equals(p.hash)) {
                ops.add(new Op(Kind.UPDATE, w, p, target));
            }
        }
        for (Placed p : placed.values()) {
            if (!seen.contains(p.entryId)) ops.add(new Op(Kind.DELETE, null, p, p.calendarId));
        }
        return ops;
    }

    static Map<String,Placed> parsePlaced(String json) {
        Map<String,Placed> out = new LinkedHashMap<>();
        try {
            JSONArray list = new JSONArray(json == null || json.isEmpty() ? "[]" : json);
            for (int i = 0; i < list.length(); i++) {
                JSONObject x = list.optJSONObject(i);
                if (x == null) continue;
                Placed p = new Placed();
                p.entryId = x.optString("entryId", "");
                p.calendarId = Long.parseLong(x.optString("calendarId", "-1"));
                p.eventId = Long.parseLong(x.optString("eventId", "-1"));
                p.hash = x.optString("hash", "");
                if (!p.entryId.isEmpty() && p.eventId >= 0) out.put(p.entryId, p);
            }
        } catch (Exception ignored) {}
        return out;
    }

    static String placedJson(Map<String,Placed> placed) {
        JSONArray out = new JSONArray();
        try {
            for (Placed p : placed.values()) {
                out.put(new JSONObject().put("entryId", p.entryId).put("calendarId", String.valueOf(p.calendarId))
                        .put("eventId", String.valueOf(p.eventId)).put("hash", p.hash));
            }
        } catch (Exception ignored) {}
        return out.toString();
    }

    /** 캘린더 일정 설명(앱이 만든 것임을 알 수 있게). */
    static String description(Want w) {
        return w.provisional ? "블랙홀 가승인 · 확정/취소는 블랙홀 앱에서" : "블랙홀";
    }

    /** 이 앱이 만든 일정 표시(CUSTOM_APP_URI). 지우기·바꾸기 전에 이 표시를 확인한다. */
    static String marker(String entryId) {
        return "blackhole://calendar/" + entryId;
    }

    private static String hash(Want w) {
        String text = w.title + "|" + w.start + "|" + w.end + "|" + w.allDay + "|" + w.provisional;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 8; i++) hex.append(String.format("%02x", digest[i]));
            return hex.toString();
        } catch (Exception error) {
            return Integer.toHexString(text.hashCode());
        }
    }
}
