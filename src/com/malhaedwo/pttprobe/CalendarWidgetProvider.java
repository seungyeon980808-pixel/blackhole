package com.malhaedwo.pttprobe;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.widget.RemoteViews;

import java.time.LocalDate;
import java.time.LocalTime;

/** 홈 위젯 「블랙홀」: 오늘 일정·할 일(Mac 사본). 누르면 블랙홀 달력, 「＋ 보내기」는 보내기 대화. */
public final class CalendarWidgetProvider extends AppWidgetProvider {
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

    static void update(Context context, AppWidgetManager manager, int[] ids) {
        if (ids == null || ids.length == 0) return;
        Context app = context.getApplicationContext();
        SharedPreferences prefs = Blackhole.prefs(app);
        BlackholeBoard.Board board = BlackholeBoard.build(prefs.getString(BlackholeCalendarStore.PREF_SHARED, ""),
                LocalDate.now(), LocalTime.now(), prefs.getBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, false));
        String pkg = app.getPackageName();
        int layout = app.getResources().getIdentifier("blackhole_widget", "layout", pkg);
        int boardView = app.getResources().getIdentifier("widget_board", "id", pkg);
        int sendView = app.getResources().getIdentifier("widget_send", "id", pkg);
        if (layout == 0 || boardView == 0) return;
        float density = app.getResources().getDisplayMetrics().density;
        PendingIntent open = PendingIntent.getActivity(app, 0x5C01, new Intent(app, CalendarWebActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent send = PendingIntent.getActivity(app, 0x5C02, new Intent(app, BlackholeSendActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        for (int id : ids) {
            Bundle options = manager.getAppWidgetOptions(id);
            int wDp = Math.max(180, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 300));
            int hDp = Math.max(100, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 160));
            // RemoteViews로 넘기는 그림 크기 제한(약 2MB) 안에서.
            float scale = Math.min(density, (float) Math.sqrt(500_000.0 / (wDp * hDp)));
            Bitmap bitmap = CalendarBoardRenderer.widget(board, Math.round(wDp * scale), Math.round(hDp * scale), scale);
            RemoteViews views = new RemoteViews(pkg, layout);
            views.setImageViewBitmap(boardView, bitmap);
            views.setOnClickPendingIntent(boardView, open);
            if (sendView != 0) views.setOnClickPendingIntent(sendView, send);
            manager.updateAppWidget(id, views);
        }
    }
}
