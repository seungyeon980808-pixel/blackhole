package com.malhaedwo.pttprobe;

import android.Manifest;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

import java.util.ArrayList;
import java.util.List;
import java.util.TimeZone;

public final class CalendarSync {
    private static final String PREFS = "malhaedwo_settings";
    private static final String CALENDAR_ID = "calendar_id";

    private CalendarSync() {}

    public static boolean hasPermission(Context context) {
        return context.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED &&
                context.checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    public static List<CalendarOption> listWritable(Context context) {
        ArrayList<CalendarOption> result = new ArrayList<>();
        if (!hasPermission(context)) return result;
        String[] projection = {
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_NAME,
                CalendarContract.Calendars.ACCOUNT_TYPE,
                CalendarContract.Calendars.IS_PRIMARY,
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL
        };
        String selection = CalendarContract.Calendars.VISIBLE + "=1 AND " +
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + ">=?";
        String[] args = {String.valueOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)};
        try (Cursor cursor = context.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI,
                projection, selection, args, CalendarContract.Calendars.IS_PRIMARY + " DESC")) {
            if (cursor == null) return result;
            while (cursor.moveToNext()) {
                CalendarOption option = new CalendarOption();
                option.id = cursor.getLong(0);
                option.displayName = cursor.getString(1);
                option.accountName = cursor.getString(2);
                option.accountType = cursor.getString(3);
                option.primary = cursor.getInt(4) == 1;
                result.add(option);
            }
        }
        return result;
    }

    public static long selectedCalendarId(Context context) {
        long saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(CALENDAR_ID, -1);
        List<CalendarOption> options = listWritable(context);
        for (CalendarOption option : options) if (option.id == saved) return saved;
        return -1;
    }

    public static void selectCalendar(Context context, long id) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(CALENDAR_ID, id).apply();
    }

    public static long upsert(Context context, CaptureItem item) {
        if (!hasPermission(context)) throw new SecurityException("캘린더 권한이 없습니다");
        if (item == null || !item.isSchedule() || item.startAt <= 0) {
            throw new IllegalArgumentException("캘린더에 넣을 일정 시간이 없습니다");
        }
        long calendarId = targetCalendarId(context, item);
        if (calendarId < 0) throw new IllegalStateException("쓰기 가능한 캘린더가 없습니다");
        ContentValues values = new ContentValues();
        values.put(CalendarContract.Events.CALENDAR_ID, calendarId);
        values.put(CalendarContract.Events.TITLE, safeTitle(item));
        values.put(CalendarContract.Events.DESCRIPTION,
                CalendarReliability.descriptionWithMarker(
                        "블랙홀에서 음성으로 등록\n\n인식 문장: " + nullToEmpty(item.transcript),
                        item.uuid, CalendarReliability.stableKey(item.calendarIdempotencyKey, item.uuid)));
        values.put(CalendarContract.Events.DTSTART, item.startAt);
        values.put(CalendarContract.Events.DTEND, item.endAt > item.startAt ? item.endAt : item.startAt + 60 * 60_000L);
        values.put(CalendarContract.Events.EVENT_TIMEZONE,
                CalendarReliability.hasText(item.calendarTimezone) ? item.calendarTimezone : TimeZone.getDefault().getID());
        values.put(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_BUSY);
        values.put(CalendarContract.Events.CUSTOM_APP_PACKAGE, context.getPackageName());
        values.put(CalendarContract.Events.CUSTOM_APP_URI,
                CalendarReliability.customAppUri(item.uuid,
                        CalendarReliability.stableKey(item.calendarIdempotencyKey, item.uuid)));
        if (item.calendarEventId > 0) {
            Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, item.calendarEventId);
            int updated = context.getContentResolver().update(uri, values, null, null);
            if (updated > 0) return item.calendarEventId;
        }
        long existing = findExistingEvent(context, calendarId, item);
        if (existing > 0) {
            Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, existing);
            int updated = context.getContentResolver().update(uri, values, null, null);
            if (updated > 0) return existing;
        }
        Uri inserted = context.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, values);
        if (inserted == null) throw new IllegalStateException("캘린더 일정 생성 실패");
        return ContentUris.parseId(inserted);
    }

    public static boolean deleteEvent(Context context, long eventId) {
        if (eventId <= 0) return true;
        if (!hasPermission(context)) return false;
        Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId);
        int deleted = context.getContentResolver().delete(uri, null, null);
        return deleted > 0 || !eventExists(context, eventId);
    }

    public static long targetCalendarId(Context context, CaptureItem item) {
        if (item != null && item.calendarSelectedId > 0) return item.calendarSelectedId;
        if (item != null && item.calendarEventId > 0 && hasPermission(context)) {
            long existing = eventCalendarId(context, item.calendarEventId);
            if (existing > 0) return existing;
        }
        return selectedCalendarId(context);
    }

    private static long findExistingEvent(Context context, long calendarId, CaptureItem item) {
        String key = CalendarReliability.stableKey(item.calendarIdempotencyKey, item.uuid);
        String customUri = CalendarReliability.customAppUri(item.uuid, key);
        long byCustomUri = 0;
        try {
            byCustomUri = findFirstEvent(context,
                    CalendarContract.Events.CALENDAR_ID + "=? AND " +
                            CalendarContract.Events.CUSTOM_APP_PACKAGE + "=? AND " +
                            CalendarContract.Events.CUSTOM_APP_URI + "=?",
                    new String[]{String.valueOf(calendarId), context.getPackageName(), customUri});
        } catch (Throwable ignored) {}
        if (byCustomUri > 0) return byCustomUri;
        String marker = "%" + CalendarReliability.calendarMarker(item.uuid, key) + "%";
        return findFirstEvent(context,
                CalendarContract.Events.CALENDAR_ID + "=? AND " +
                        CalendarContract.Events.DESCRIPTION + " LIKE ?",
                new String[]{String.valueOf(calendarId), marker});
    }

    private static long findFirstEvent(Context context, String selection, String[] args) {
        try (Cursor cursor = context.getContentResolver().query(CalendarContract.Events.CONTENT_URI,
                new String[]{CalendarContract.Events._ID}, selection, args,
                CalendarContract.Events._ID + " ASC")) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getLong(0);
        }
        return 0;
    }

    private static boolean eventExists(Context context, long eventId) {
        return eventCalendarId(context, eventId) > 0;
    }

    private static long eventCalendarId(Context context, long eventId) {
        Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId);
        try (Cursor cursor = context.getContentResolver().query(uri,
                new String[]{CalendarContract.Events.CALENDAR_ID}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getLong(0);
        }
        return 0;
    }

    private static String safeTitle(CaptureItem item) {
        return item.title == null || item.title.trim().isEmpty() ? "음성 일정" : item.title.trim();
    }

    private static String nullToEmpty(String value) { return value == null ? "" : value; }

    public static final class CalendarOption {
        public long id;
        public String displayName;
        public String accountName;
        public String accountType;
        public boolean primary;
        @Override public String toString() {
            String name = displayName == null ? "캘린더" : displayName;
            return name + (accountName == null ? "" : " · " + accountName) + (primary ? " (기본)" : "");
        }
    }
}
