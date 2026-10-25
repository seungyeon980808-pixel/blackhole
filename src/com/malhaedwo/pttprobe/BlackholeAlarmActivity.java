package com.malhaedwo.pttprobe;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 전화처럼 뜨는 전체 화면 알람(잠금 위에서 화면을 켜고 뜬다). 소리·진동은 알림이 맡고,
 * 이 화면은 「확인 / 완료 / 10분 뒤」만 받는다. 알람 제목 말고 다른 기록은 보여 주지 않는다.
 */
public final class BlackholeAlarmActivity extends Activity {
    private static final int BG = Color.rgb(10, 12, 11);
    private static final int INK = Color.rgb(240, 243, 241);
    private static final int MUTED = Color.rgb(150, 160, 154);
    private static final int ACCENT = Color.rgb(33, 104, 73);
    private static final int DANGER = Color.rgb(155, 51, 44);

    private String alarmId;
    private boolean receiverRegistered;

    private final BroadcastReceiver closed = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String id = intent.getStringExtra(BlackholeAlarms.EXTRA_ID);
            if (id != null && id.equals(alarmId)) finish();
        }
    };

    static Intent intent(Context context, String id) {
        return new Intent(context, BlackholeAlarmActivity.class)
                .putExtra(BlackholeAlarms.EXTRA_ID, id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        bind(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    @Override protected void onStart() {
        super.onStart();
        if (!receiverRegistered) {
            registerReceiver(closed, new IntentFilter(BlackholeAlarms.ACTION_CLOSED), Context.RECEIVER_NOT_EXPORTED);
            receiverRegistered = true;
        }
        BlackholeAlarmBook.Alarm alarm = alarmId == null ? null : BlackholeAlarms.load(this).get(alarmId);
        if (alarm == null || !BlackholeAlarmBook.RINGING.equals(alarm.state)) finish();
    }

    @Override protected void onStop() {
        if (receiverRegistered) {
            unregisterReceiver(closed);
            receiverRegistered = false;
        }
        super.onStop();
    }

    @Override public void onBackPressed() {
        // 뒤로 가기로는 끄지 않는다. 세 단추 중 하나를 눌러야 소리가 멈춘다.
    }

    private void bind(Intent intent) {
        alarmId = intent == null ? null : intent.getStringExtra(BlackholeAlarms.EXTRA_ID);
        BlackholeAlarmBook.Alarm alarm = alarmId == null ? null : BlackholeAlarms.load(this).get(alarmId);
        String title = alarm == null || alarm.title.isEmpty() ? "블랙홀 알람" : alarm.title;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(BG);
        root.setPadding(dp(28), dp(96), dp(28), dp(56));
        TextView clock = text(new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date()), 64, INK);
        clock.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(clock);
        TextView titleView = text(title, 26, INK);
        titleView.setPadding(0, dp(18), 0, dp(6));
        root.addView(titleView);
        root.addView(text("블랙홀", 14, MUTED));
        LinearLayout spacer = new LinearLayout(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));
        root.addView(button("완료", ACCENT, BlackholeAlarms.ACTION_DONE));
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(button("10분 뒤", Color.rgb(48, 54, 51), BlackholeAlarms.ACTION_SNOOZE), weight());
        row.addView(button("확인", DANGER, BlackholeAlarms.ACTION_ACK), weight());
        root.addView(row);
        setContentView(root);
    }

    private Button button(String label, int color, String action) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(20);
        button.setTextColor(Color.WHITE);
        button.setMinHeight(dp(72));
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(color);
        fill.setCornerRadius(dp(36));
        button.setBackground(fill);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(dp(6), dp(8), dp(6), dp(8));
        button.setLayoutParams(params);
        button.setOnClickListener(v -> {
            if (alarmId != null) BlackholeAlarms.handle(this, alarmId, action);
            finish();
        });
        return button;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        params.setMargins(dp(6), dp(8), dp(6), dp(8));
        return params;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
