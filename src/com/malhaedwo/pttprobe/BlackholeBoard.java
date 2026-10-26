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
    /** 위젯·잠금화면 그림의 밝기(-50~50, 0 = 지금 모습)와 판 불투명도(0~150%, 100 = 지금 모습). */
    static final String PREF_BRIGHT = "board_bright";
    static final String PREF_OPACITY = "board_opacity";
    /** 잠금화면 알림에 오늘 할 일·마감을 보이고 「완료」를 받는다. */
    static final String PREF_LOCK_TASKS = "lock_tasks_enabled";
    /** 잠금화면 알림의 할 일 제목을 가린다(「할 일 1」). */
    static final String PREF_LOCK_HIDE_TITLES = "lock_hide_titles";
    static final int MAX_WEEK = 6;
    static final int MAX_EVENTS = 8;
    static final int MAX_TASKS = 8;

    private BlackholeBoard() {}

    static final class Line {
        final String time;
        final String text;
        final boolean provisional;
        final boolean past;
        final String badge;
        /** 항목 id와 원본 작업 id(잠금화면 「완료」가 Mac에 보낼 때 씀). */
        String id = "";
        String srcKey = "";
        /** 위젯에서 이 줄을 누르면 열 날짜(yyyy-MM-dd). */
        String day = "";
        boolean school;
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
        /** 내일부터 엿새 안 일정(「화 15:00」). */
        final List<Line> week = new ArrayList<>();
        /** Mac 사본을 아직 한 번도 받지 못함(빈 위젯과 구별). */
        boolean noCopy;
        boolean empty() { return events.isEmpty() && tasks.isEmpty() && periods.isEmpty() && week.isEmpty(); }
    }

    static Board build(String sharedJson, LocalDate today, LocalTime now, boolean hideSchool) {
        Board board = new Board();
        String[] dow = {"월", "화", "수", "목", "금", "토", "일"};
        board.date = today.getMonthValue() + "월 " + today.getDayOfMonth() + "일 " + dow[today.getDayOfWeek().getValue() - 1] + "요일";
        JSONObject shared;
        try { shared = new JSONObject(sharedJson == null || sharedJson.isEmpty() ? "{}" : sharedJson); } catch (Exception error) { board.noCopy = true; return board; }
        board.noCopy = shared.optJSONArray("events") == null;
        String key = today.toString();

        List<JSONObject> events = live(shared.optJSONArray("events"));
        events.removeIf(e -> !key.equals(e.optString("date", "")));
        events.sort(Comparator.comparing(e -> text(e, "start", "00:00")));
        for (JSONObject e : events) {
            if (board.events.size() >= MAX_EVENTS) break;
            String start = text(e, "start", "");
            String end = text(e, "end", "");
            boolean past = !end.isEmpty() && !end.equals("null") && parse(end) != null && parse(end).isBefore(now);
            Line line = new Line(start.isEmpty() ? "종일" : start, title(e, hideSchool, "학교 일정"),
                    e.optBoolean("provisional", false), past, "");
            line.day = key;
            board.events.add(line);
        }

        List<JSONObject> week = live(shared.optJSONArray("events"));
        String weekEnd = today.plusDays(MAX_WEEK).toString();
        week.removeIf(e -> e.optString("date", "").compareTo(key) <= 0 || e.optString("date", "").compareTo(weekEnd) > 0);
        week.sort(Comparator.comparing((JSONObject e) -> e.optString("date", "")).thenComparing(e -> text(e, "start", "00:00")));
        for (JSONObject e : week) {
            if (board.week.size() >= MAX_WEEK) break;
            try {
                LocalDate d = LocalDate.parse(e.optString("date", ""));
                String start = text(e, "start", "");
                Line line = new Line(dow[d.getDayOfWeek().getValue() - 1] + " " + (start.isEmpty() ? "종일" : start),
                        title(e, hideSchool, "학교 일정"), e.optBoolean("provisional", false), false, "");
                line.day = d.toString();
                board.week.add(line);
            } catch (Exception skip) {}
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
            String dueTime = text(t, "dueTime", "");
            String badge = t.optBoolean("done", false) || t.optBoolean("noDue", false) ? ""
                    : days < 0 ? (-days) + "일 지남" : days == 0 ? (dueTime.isEmpty() ? "오늘" : "오늘 " + dueTime) : "D-" + days;
            String subs = subCount(t.optJSONArray("subs"));
            Line line = new Line(t.optBoolean("done", false) ? "☑" : "☐", title(t, hideSchool, "학교 할 일") + subs, false,
                    t.optBoolean("done", false), badge);
            line.id = t.optString("id", "");
            line.srcKey = t.optString("srcKey", "");
            line.school = "school".equals(t.optString("area", ""));
            line.day = due.toString();
            board.tasks.add(line);
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

    /** 잠금화면 알림의 할 일: 끝내지 않은 것 중 지난·오늘·이틀 안 마감(마감 없는 할 일은 뺌), 많아야 max개. */
    static List<Line> lockTasks(Board board, int max) {
        List<Line> out = new ArrayList<>();
        for (Line t : board.tasks) {
            if (out.size() >= max) break;
            if (t.past || t.id.isEmpty()) continue;
            if (t.badge.startsWith("오늘") || t.badge.endsWith("지남") || "D-1".equals(t.badge) || "D-2".equals(t.badge)) out.add(t);
        }
        return out;
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
