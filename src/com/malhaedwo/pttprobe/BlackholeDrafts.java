package com.malhaedwo.pttprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * 휴대폰 안 「초안」(안드로이드 API 없음, 호스트 시험 대상). 보내기·잠금화면 적기·녹음 받아쓰기 직후
 * 규칙 파서(KoreanCommandParser)로 일정·할 일을 바로 만들어 휴대폰 블랙홀 달력·위젯에 보이고,
 * Mac 사본이 같은 원본(작업 id = 「job-」+SHA-256 앞 16자)을 다루면 그때 뺀다. 형식은 달력 화면의
 * Entry(desktop/src/calendar/model.ts)와 같고, 만드는 규칙은 store.ts draftFromText와 같다.
 */
final class BlackholeDrafts {
    static final String PREF = "calendar_local_drafts";
    /** Mac이 끝내 답하지 않아도(꺼져 있음) 초안은 사흘 뒤 정리한다. */
    static final long KEEP_MS = 3L * 24 * 3600_000L;
    static final int MAX = 200;
    static final String SOURCE = "휴대폰";
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm", Locale.ROOT);
    private static final DateTimeFormatter HM = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);

    private BlackholeDrafts() {}

    /** Mac 작업기와 같은 작업 id. */
    static String jobId(String sha256) {
        return "job-" + sha256.substring(0, 16).toLowerCase(Locale.ROOT);
    }

    /** 문장 하나 → 초안 항목 하나(규칙 파서). 일정은 가승인, 알림은 시각 30분 전(날짜만 있는 할 일은 그날 09:00). */
    static JSONObject fromText(String text, long capturedAt, String srcKey, ZoneId zone) throws Exception {
        ParsedCommand parsed = KoreanCommandParser.parse(text, capturedAt);
        boolean clock = KoreanCommandParser.hasClockTime(text);
        LocalDateTime now = LocalDateTime.ofInstant(Instant.ofEpochMilli(capturedAt), zone);
        JSONObject x = new JSONObject()
                .put("title", parsed.title).put("area", "personal").put("source", SOURCE)
                .put("createdAt", STAMP.format(now)).put("draft", true).put("srcKey", srcKey);
        if (parsed.needsReview) x.put("review", new JSONArray().put(parsed.explanation));
        LocalDateTime start = parsed.startAt == 0 ? null : LocalDateTime.ofInstant(Instant.ofEpochMilli(parsed.startAt), zone);
        if ("SCHEDULE".equals(parsed.kind) && start != null) {
            int endMinutes = Math.min(start.getHour() * 60 + start.getMinute() + 60, 23 * 60 + 59);
            return x.put("id", newId("e")).put("kind", "event").put("date", start.toLocalDate().toString())
                    .put("start", HM.format(start)).put("end", String.format(Locale.ROOT, "%02d:%02d", endMinutes / 60, endMinutes % 60))
                    .put("provisional", true).put("reminders", new JSONArray().put(STAMP.format(start.minusMinutes(30))));
        }
        LocalDate due = start == null ? now.toLocalDate() : start.toLocalDate();
        JSONArray reminders = new JSONArray();
        if (start != null) reminders.put(clock ? STAMP.format(start.minusMinutes(30)) : due + "T09:00");
        x.put("id", newId("t")).put("kind", "task").put("due", due.toString())
                .put("dueTime", start != null && clock ? HM.format(start) : JSONObject.NULL)
                .put("done", false).put("reminders", reminders).put("subs", new JSONArray());
        if (start == null) x.put("noDue", true);
        return x;
    }

    /** 초안 목록에 더한다(같은 id는 바꿔 넣음). 달력 화면이 만든 초안 목록(JSON 배열)도 받는다. */
    static String addAll(String drafts, String entries) {
        JSONArray list = array(drafts);
        JSONArray add = array(entries);
        if (add.length() == 0) {
            try { add.put(new JSONObject(entries)); } catch (Exception ignored) {}
        }
        for (int i = 0; i < add.length(); i++) {
            JSONObject e = add.optJSONObject(i);
            if (e == null || e.optString("id", "").isEmpty() || e.optString("srcKey", "").isEmpty()) continue;
            JSONArray kept = new JSONArray();
            for (int j = 0; j < list.length(); j++) {
                JSONObject x = list.optJSONObject(j);
                if (x != null && !e.optString("id").equals(x.optString("id"))) kept.put(x);
            }
            kept.put(e);
            list = kept;
        }
        if (list.length() <= MAX) return list.toString();
        JSONArray recent = new JSONArray();
        for (int i = list.length() - MAX; i < list.length(); i++) recent.put(list.opt(i));
        return recent.toString();
    }

    /** Mac 사본이 다룬 원본(sources 또는 항목의 srcKey)의 초안과 오래된 초안을 뺀다. */
    static String prune(String drafts, String shared, long now, ZoneId zone) {
        Set<String> known = covered(shared);
        JSONArray kept = new JSONArray();
        JSONArray list = array(drafts);
        for (int i = 0; i < list.length(); i++) {
            JSONObject x = list.optJSONObject(i);
            if (x == null || known.contains(x.optString("srcKey", ""))) continue;
            try {
                long made = LocalDateTime.parse(x.optString("createdAt", "")).atZone(zone).toInstant().toEpochMilli();
                if (now - made > KEEP_MS) continue;
            } catch (Exception badDate) {
                continue;
            }
            kept.put(x);
        }
        return kept.toString();
    }

    /** 위젯·잠금화면용: Mac 사본에 아직 다루지 않은 휴대폰 초안을 얹은 사본. */
    static String overlay(String shared, String drafts) {
        JSONArray list = array(drafts);
        if (list.length() == 0) return shared == null ? "" : shared;
        try {
            JSONObject copy = new JSONObject(shared == null || shared.isEmpty() ? "{}" : shared);
            Set<String> known = covered(copy.toString());
            for (String key : new String[]{"events", "tasks", "periods", "notes"}) {
                if (copy.optJSONArray(key) == null) copy.put(key, new JSONArray());
            }
            for (int i = 0; i < list.length(); i++) {
                JSONObject x = list.optJSONObject(i);
                if (x == null || known.contains(x.optString("srcKey", ""))) continue;
                String kind = x.optString("kind", "");
                String key = "event".equals(kind) ? "events" : "task".equals(kind) ? "tasks" : null;
                if (key != null) copy.optJSONArray(key).put(x);
            }
            return copy.toString();
        } catch (Exception error) {
            return shared == null ? "" : shared;
        }
    }

    private static Set<String> covered(String shared) {
        Set<String> known = new HashSet<>();
        try {
            JSONObject o = new JSONObject(shared == null || shared.isEmpty() ? "{}" : shared);
            JSONArray sources = o.optJSONArray("sources");
            for (int i = 0; sources != null && i < sources.length(); i++) known.add(sources.optString(i, ""));
            for (String key : new String[]{"events", "tasks", "periods", "notes"}) {
                JSONArray list = o.optJSONArray(key);
                for (int i = 0; list != null && i < list.length(); i++) {
                    JSONObject x = list.optJSONObject(i);
                    if (x != null && !x.optString("srcKey", "").isEmpty()) known.add(x.optString("srcKey"));
                }
            }
        } catch (Exception ignored) {}
        known.remove("");
        return known;
    }

    private static String newId(String prefix) {
        return prefix + "-d" + Long.toString(System.currentTimeMillis(), 36) + UUID.randomUUID().toString().substring(0, 5);
    }

    private static JSONArray array(String json) {
        try { return new JSONArray(json == null || json.isEmpty() ? "[]" : json); } catch (Exception error) { return new JSONArray(); }
    }
}
