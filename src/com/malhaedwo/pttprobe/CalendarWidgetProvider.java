package com.malhaedwo.pttprobe;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Bundle;
import android.util.SizeF;
import android.util.TypedValue;
import android.widget.RemoteViews;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 홈 위젯 「블랙홀」: 오늘 일정·할 일(Mac 사본). 줄을 누르면 그 날짜의 블랙홀 달력(일 보기), 나머지는 오늘,
 * 「＋ 보내기」는 보내기 대화. 홈 화면이 알려 주는 실제 크기마다 그 크기 그대로 그려(늘이거나 줄이지 않음)
 * 크기를 바꿔도 글자가 찌그러지거나 잘리지 않고, 밝은 판·어두운 판을 함께 넘겨 다크 모드를 바꾸면 홈 화면이 바로 고른다.
 */
public final class CalendarWidgetProvider extends AppWidgetProvider {
    static final int MAX_HITS = 10;
    /** 그림 하나의 픽셀 수 한도(크기 두 가지 × 밝음·어두움 네 장이 위젯 그림 한도 안에 들게). */
    static final int MAX_PIXELS = 450_000;

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        update(context, manager, ids);
        CalendarRefreshJob.schedule(context);
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        update(context, manager, new int[]{id});
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        if (manager == null) return;
        update(context, manager, manager.getAppWidgetIds(new ComponentName(context, CalendarWidgetProvider.class)));
    }

    static CalendarBoardRenderer.Look look(SharedPreferences prefs) {
        return new CalendarBoardRenderer.Look(prefs.getInt(BlackholeBoard.PREF_BRIGHT, 0), prefs.getInt(BlackholeBoard.PREF_OPACITY, 100));
    }

    /** 위젯·알림에서 그 날짜의 달력 열기. */
    static Intent openDay(Context app, String day) {
        Intent intent = new Intent(app, CalendarWebActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (day != null && !day.isEmpty()) {
            intent.putExtra(CalendarWebActivity.EXTRA_DAY, day);
            // 날짜마다 다른 PendingIntent가 되게(엑스트라만 다르면 같은 것으로 본다).
            intent.setData(Uri.parse("blackhole-widget://day/" + day));
        }
        return intent;
    }

    static void update(Context context, AppWidgetManager manager, int[] ids) {
        if (ids == null || ids.length == 0) return;
        Context app = context.getApplicationContext();
        SharedPreferences prefs = Blackhole.prefs(app);
        BlackholeBoard.Board board = BlackholeBoard.build(Blackhole.boardShared(app),
                LocalDate.now(), LocalTime.now(), prefs.getBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, false));
        String pkg = app.getPackageName();
        if (id(app, "layout", "blackhole_widget") == 0 || id(app, "id", "widget_board") == 0) return;
        float density = app.getResources().getDisplayMetrics().density;
        float textScale = app.getResources().getConfiguration().fontScale;
        for (int id : ids) {
            Bundle options = manager.getAppWidgetOptions(id);
            List<SizeF> sizes = sizes(options);
            RemoteViews views;
            if (sizes.size() == 1) {
                views = views(app, pkg, board, sizes.get(0), density, textScale, look(prefs));
            } else {
                Map<SizeF, RemoteViews> bySize = new LinkedHashMap<>();
                for (SizeF size : sizes) bySize.put(size, views(app, pkg, board, size, density, textScale, look(prefs)));
                views = new RemoteViews(bySize);
            }
            try {
                manager.updateAppWidget(id, views);
            } catch (RuntimeException tooBig) {
                // 그림이 한도를 넘으면 크기 하나·작은 해상도로 다시.
                manager.updateAppWidget(id, views(app, pkg, board, sizes.get(0), Math.min(density, 2f), textScale, look(prefs)));
            }
        }
    }

    /** 홈 화면이 알려 준 실제 크기들(세로·가로 화면). 모르면 세로 화면 기준(가장 좁은 폭 × 가장 큰 높이). */
    static List<SizeF> sizes(Bundle options) {
        List<SizeF> out = new ArrayList<>();
        ArrayList<SizeF> given = options == null ? null : options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES);
        if (given != null) {
            for (SizeF size : given) {
                if (size != null && size.getWidth() >= 40 && size.getHeight() >= 40 && !out.contains(size)) out.add(size);
                if (out.size() >= 2) break;
            }
        }
        if (out.isEmpty()) {
            int w = options == null ? 300 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 300);
            int h = options == null ? 160 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 160);
            out.add(new SizeF(Math.max(180, w), Math.max(100, h)));
        }
        return out;
    }

    private static RemoteViews views(Context app, String pkg, BlackholeBoard.Board board, SizeF size, float density, float textScale,
                                     CalendarBoardRenderer.Look look) {
        float wDp = Math.max(110, size.getWidth());
        float hDp = Math.max(80, size.getHeight());
        float scale = Math.min(density, (float) Math.sqrt(MAX_PIXELS / (wDp * hDp)));
        int w = Math.round(wDp * scale);
        int h = Math.round(hDp * scale);
        CalendarBoardRenderer.Drawn light = CalendarBoardRenderer.widget(board, w, h, scale, look, false, textScale);
        CalendarBoardRenderer.Drawn dark = CalendarBoardRenderer.widget(board, w, h, scale, look, true, textScale);
        RemoteViews views = new RemoteViews(pkg, id(app, "layout", "blackhole_widget"));
        int boardView = id(app, "id", "widget_board");
        views.setIcon(boardView, "setImageIcon", Icon.createWithBitmap(light.bitmap), Icon.createWithBitmap(dark.bitmap));
        views.setOnClickPendingIntent(boardView, PendingIntent.getActivity(app, 0x5C01, openDay(app, ""),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        int sendView = id(app, "id", "widget_send");
        if (sendView != 0) {
            views.setOnClickPendingIntent(sendView, PendingIntent.getActivity(app, 0x5C02, new Intent(app, BlackholeSendActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            views.setColorInt(sendView, "setTextColor", Color.argb(230, 18, 20, 38), Color.WHITE);
        }
        // 줄마다 누를 자리: 그림과 같은 크기라 dp 위치가 그대로 맞는다.
        for (int i = 0; i < MAX_HITS; i++) {
            int hitView = id(app, "id", "widget_hit" + i);
            if (hitView == 0) continue;
            if (i >= light.hits.size()) {
                views.setViewVisibility(hitView, android.view.View.GONE);
                continue;
            }
            CalendarBoardRenderer.Hit hit = light.hits.get(i);
            views.setViewVisibility(hitView, android.view.View.VISIBLE);
            views.setViewLayoutMargin(hitView, RemoteViews.MARGIN_TOP, hit.top / scale, TypedValue.COMPLEX_UNIT_DIP);
            views.setViewLayoutHeight(hitView, (hit.bottom - hit.top) / scale, TypedValue.COMPLEX_UNIT_DIP);
            views.setOnClickPendingIntent(hitView, PendingIntent.getActivity(app, 0x5C10 + i, openDay(app, hit.day),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        return views;
    }

    private static int id(Context app, String type, String name) {
        return app.getResources().getIdentifier(name, type, app.getPackageName());
    }
}
