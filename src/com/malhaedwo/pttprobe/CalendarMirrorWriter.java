package com.malhaedwo.pttprobe;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

import java.text.SimpleDateFormat;
import java.time.ZoneId;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 4단계 가승인 루프: Mac 사본을 안드로이드 캘린더(→ 구글 캘린더 동기화)에 반영한다.
 * 사용자가 「가승인 캘린더」와 「본 캘린더」를 직접 고르고 켜기 전에는 아무것도 쓰지 않는다.
 * 지우기·바꾸기는 이 앱이 만든 일정(CUSTOM_APP_URI 표시가 맞는 것)에만 한다.
 */
final class CalendarMirrorWriter {
    private CalendarMirrorWriter() {}

    /** 반영 결과 한 줄. 꺼져 있거나 권한·캘린더가 없으면 그 이유. */
    static synchronized String sync(Context context, String sharedJson) {
        SharedPreferences prefs = Blackhole.prefs(context);
        if (!prefs.getBoolean(BlackholeCalendarMirror.PREF_ENABLED, false)) return "구글 캘린더 반영 꺼짐";
        if (!CalendarSync.hasPermission(context)) return "캘린더 권한이 없습니다";
        long provisional = parse(prefs.getString(BlackholeCalendarMirror.PREF_PROVISIONAL, ""));
        long main = parse(prefs.getString(BlackholeCalendarMirror.PREF_MAIN, ""));
        if (!writable(context, provisional) || !writable(context, main) || provisional == main) {
            return "가승인 캘린더와 본 캘린더를 서로 다르게 골라 주세요";
        }
        Map<String,BlackholeCalendarMirror.Placed> placed =
                BlackholeCalendarMirror.parsePlaced(prefs.getString(BlackholeCalendarMirror.PREF_PLACED, "[]"));
        List<BlackholeCalendarMirror.Op> ops = BlackholeCalendarMirror.plan(
                BlackholeCalendarMirror.wanted(sharedJson, ZoneId.systemDefault()), placed, provisional, main);
        ContentResolver resolver = context.getContentResolver();
        int done = 0;
        int failed = 0;
        for (BlackholeCalendarMirror.Op op : ops) {
            try {
                switch (op.kind) {
                    case DELETE:
                        if (ownedBy(resolver, op.placed.eventId, op.placed.entryId)) {
                            resolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, op.placed.eventId), null, null);
                        }
                        placed.remove(op.placed.entryId);
                        break;
                    case UPDATE:
                        if (ownedBy(resolver, op.placed.eventId, op.placed.entryId)) {
                            resolver.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, op.placed.eventId),
                                    values(context, op.want, op.calendarId), null, null);
                            op.placed.hash = op.want.hash;
                        } else {
                            // 사용자가 지운 일정: 다시 넣는다(장부를 새로 씀).
                            placed.remove(op.placed.entryId);
                            insert(context, resolver, op, placed);
                        }
                        break;
                    case INSERT:
                        insert(context, resolver, op, placed);
                        break;
                }
                done++;
            } catch (Exception error) {
                failed++;
            }
        }
        prefs.edit().putString(BlackholeCalendarMirror.PREF_PLACED, BlackholeCalendarMirror.placedJson(placed)).apply();
        String when = new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date());
        return "구글 캘린더 반영 " + when + " · 바꾼 것 " + done + (failed > 0 ? " · 실패 " + failed : "") + " · 일정 " + placed.size();
    }

    private static void insert(Context context, ContentResolver resolver, BlackholeCalendarMirror.Op op,
                               Map<String,BlackholeCalendarMirror.Placed> placed) {
        Uri uri = resolver.insert(CalendarContract.Events.CONTENT_URI, values(context, op.want, op.calendarId));
        if (uri == null) throw new IllegalStateException("캘린더에 넣지 못했습니다");
        BlackholeCalendarMirror.Placed p = new BlackholeCalendarMirror.Placed();
        p.entryId = op.want.entryId;
        p.calendarId = op.calendarId;
        p.eventId = ContentUris.parseId(uri);
        p.hash = op.want.hash;
        placed.put(p.entryId, p);
    }

    private static ContentValues values(Context context, BlackholeCalendarMirror.Want w, long calendarId) {
        ContentValues values = new ContentValues();
        values.put(CalendarContract.Events.CALENDAR_ID, calendarId);
        values.put(CalendarContract.Events.TITLE, w.title);
        values.put(CalendarContract.Events.DESCRIPTION, BlackholeCalendarMirror.description(w));
        values.put(CalendarContract.Events.DTSTART, w.start);
        values.put(CalendarContract.Events.DTEND, w.end);
        values.put(CalendarContract.Events.ALL_DAY, w.allDay ? 1 : 0);
        values.put(CalendarContract.Events.EVENT_TIMEZONE, w.allDay ? "UTC" : ZoneId.systemDefault().getId());
        values.put(CalendarContract.Events.AVAILABILITY,
                w.provisional ? CalendarContract.Events.AVAILABILITY_TENTATIVE : CalendarContract.Events.AVAILABILITY_BUSY);
        values.put(CalendarContract.Events.CUSTOM_APP_PACKAGE, context.getPackageName());
        values.put(CalendarContract.Events.CUSTOM_APP_URI, BlackholeCalendarMirror.marker(w.entryId));
        return values;
    }

    /** 이 앱이 만든 같은 항목의 일정인지(지워지지 않았고 표시가 맞는지). */
    private static boolean ownedBy(ContentResolver resolver, long eventId, String entryId) {
        try (Cursor cursor = resolver.query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
                new String[]{CalendarContract.Events.CUSTOM_APP_URI, CalendarContract.Events.DELETED}, null, null, null)) {
            return cursor != null && cursor.moveToFirst()
                    && BlackholeCalendarMirror.marker(entryId).equals(cursor.getString(0)) && cursor.getInt(1) == 0;
        }
    }

    private static boolean writable(Context context, long id) {
        if (id < 0) return false;
        for (CalendarSync.CalendarOption option : CalendarSync.listWritable(context)) if (option.id == id) return true;
        return false;
    }

    private static long parse(String value) {
        try { return Long.parseLong(value); } catch (Exception error) { return -1; }
    }
}
