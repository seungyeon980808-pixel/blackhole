package com.malhaedwo.pttprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 홈 위젯·잠금화면 배경에 그릴 내용(안드로이드 API 없음, 호스트 시험 대상).
 * Mac 사본에서 오늘 일정, 마감 순 할 일, 진행 중 기간을 뽑는다. 「학교 일정 제목 가리기」를 켜면
 * 학교 항목 제목을 「학교 일정」·「학교 할 일」로 바꿔 잠금화면에 학생 이름 등이 보이지 않게 한다.
 */
final class BlackholeBoard {
    static final String PREF_LOCK = "board_lock_enabled";
    static final String PREF_HIDE_SCHOOL = "board_hide_school";
    static final String PREF_STATUS = "board_status";
    static final int MAX_EVENTS = 8;
    static final int MAX_TASKS = 8;

    private BlackholeBoard() {}

    static final class Line {
        final String time;
        final String text;
        final boolean provisional;
        final boolean past;
        final String badge;
        Line(String time, String text, boolean provisional, boolean past, String badge) {
            this.time = time;
            this.text = text;
            this.provisional = provisional;
            this.past = past;
            this.badge = badge;
        }
    }

    static final class Board {
        String date = "";
        final List<Line> events = new ArrayList<>();
        final List<Line> tasks = new ArrayList<>();
        final List<String> periods = new ArrayList<>();
        boolean empty() { return events.isEmpty() && tasks.isEmpty() && periods.isEmpty(); }
    }

    static Board build(String sharedJson, LocalDate today, LocalTime now, boolean hideSchool) {
        Board board = new Board();
        String[] dow = {"월", "화", "수", "목", "금", "토", "일"};
        board.date = today.getMonthValue() + "월 " + today.getDayOfMonth() + "일 " + dow[today.getDayOfWeek().getValue() - 1] + "요일";
        JSONObject shared;
        try { shared = new JSONObject(sharedJson == null || sharedJson.isEmpty() ? "{}" : sharedJson); } catch (Exception error) { return board; }
        String key = today.toString();

        List<JSONObject> events = live(shared.optJSONArray("events"));
        events.removeIf(e -> !key.equals(e.optString("date", "")));
        events.sort(Comparator.comparing(e -> text(e, "start", "00:00")));
        for (JSONObject e : events) {
            if (board.events.size() >= MAX_EVENTS) break;
            String start = text(e, "start", "");
            String end = text(e, "end", "");
            boolean past = !end.isEmpty() && !end.equals("null") && parse(end) != null && parse(end).isBefore(now);
            board.events.add(new Line(start.isEmpty() ? "종일" : start, title(e, hideSchool, "학교 일정"),
                    e.optBoolean("provisional", false), past, ""));
        }

        List<JSONObject> tasks = live(shared.optJSONArray("tasks"));
        String limit = today.plusDays(7).toString();
        tasks.removeIf(t -> t.optBoolean("done", false) && !key.equals(t.optString("due", "")));
        tasks.removeIf(t -> t.optString("due", "").compareTo(limit) > 0);
        tasks.sort(Comparator.comparing((JSONObject t) -> t.optString("due", "")).thenComparing(t -> text(t, "dueTime", "99")));
        for (JSONObject t : tasks) {
            if (board.tasks.size() >= MAX_TASKS) break;
            LocalDate due;
            try { due = LocalDate.parse(t.optString("due", "")); } catch (Exception error) { continue; }
            long days = ChronoUnit.DAYS.between(today, due);
            String badge = t.optBoolean("done", false) ? "" : days < 0 ? (-days) + "일 지남" : days == 0 ? "오늘" : "D-" + days;
            String subs = subCount(t.optJSONArray("subs"));
            board.tasks.add(new Line(t.optBoolean("done", false) ? "☑" : "☐", title(t, hideSchool, "학교 할 일") + subs, false,
                    t.optBoolean("done", false), badge));
        }

        for (JSONObject p : live(shared.optJSONArray("periods"))) {
            String from = p.optString("from", "");
            String to = p.optString("to", "");
            if (from.compareTo(key) > 0 || to.compareTo(key) < 0) continue;
            try {
                long nth = ChronoUnit.DAYS.between(LocalDate.parse(from), today) + 1;
                long total = ChronoUnit.DAYS.between(LocalDate.parse(from), LocalDate.parse(to)) + 1;
                board.periods.add(title(p, hideSchool, "학교 기간") + " " + nth + "/" + total + "일");
            } catch (Exception ignored) {}
        }
        return board;
    }

    private static List<JSONObject> live(JSONArray list) {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject x = list.optJSONObject(i);
            if (x != null && !x.optBoolean("gone", false) && !x.optBoolean("sample", false)) out.add(x);
        }
        return out;
    }

    private static String title(JSONObject x, boolean hideSchool, String hidden) {
        if (hideSchool && "school".equals(x.optString("area", ""))) return hidden;
        String t = x.optString("title", "");
        return t.length() > 40 ? t.substring(0, 40) + "…" : t;
    }

    private static String subCount(JSONArray subs) {
        if (subs == null || subs.length() == 0) return "";
        int done = 0;
        for (int i = 0; i < subs.length(); i++) {
            JSONObject s = subs.optJSONObject(i);
            if (s != null && s.optBoolean("done", false)) done++;
        }
        return " " + done + "/" + subs.length();
    }

    private static String text(JSONObject x, String key, String fallback) {
        String v = x.optString(key, fallback);
        return v == null || v.isEmpty() || "null".equals(v) ? fallback : v;
    }

    private static LocalTime parse(String hm) {
        try { return LocalTime.parse(hm); } catch (Exception error) { return null; }
    }
}
