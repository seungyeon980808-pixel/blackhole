package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 알람 권한 안내: 알림 / 알람 및 리마인더(정확한 알람) / 전체 화면 알림(안드로이드 14부터 따로 허용).
 * 각 줄에 지금 상태와 설정을 여는 단추, 맨 아래 「1분 뒤 시험 알람」.
 */
public final class BlackholeAlarmSetupActivity extends Activity {
    private static final int BG = Color.rgb(216, 221, 218);
    private static final int SURFACE = Color.rgb(244, 246, 243);
    private static final int INK = Color.rgb(20, 32, 25);
    private static final int MUTED = Color.rgb(104, 115, 108);
    private static final int LINE = Color.rgb(170, 178, 173);
    private static final int ACCENT = Color.rgb(33, 104, 73);
    private static final int DANGER = Color.rgb(155, 51, 44);
    private static final int REQUEST_NOTIFY = 51;
    static final String ACTION_MANAGE_FULL_SCREEN = "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT";

    private LinearLayout body;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("블랙홀 알람 설정");
    }

    @Override protected void onResume() {
        super.onResume();
        build();
    }

    private void build() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);
        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setBackgroundColor(SURFACE);
        body.setPadding(dp(16), dp(16), dp(16), dp(24));
        scroll.addView(body);

        TextView title = text("전화처럼 울리는 알람", 22, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        body.addView(title);
        body.addView(text("정해 둔 시각에 잠금화면 위로 화면을 켜고 뜨며, 「확인 / 완료 / 10분 뒤」를 누를 때까지 알람 소리와 진동이 반복됩니다. "
                + "아래 세 가지가 모두 「허용됨」이어야 잠금 상태에서도 제대로 뜹니다.", 14, MUTED));

        boolean notify = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        row("1. 알림", notify, "알림이 꺼져 있으면 소리도 화면도 나오지 않습니다.", "알림 허용", v -> {
            if (!notify) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFY);
            else open(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        });
        boolean exact = BlackholeAlarms.canExact(this);
        row("2. 알람 및 리마인더", exact, "정확한 시각에 깨우는 권한입니다. 꺼져 있으면 알람을 걸 수 없습니다.", "설정 열기",
                v -> open(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName()))));
        boolean fullScreen = BlackholeAlarms.canFullScreen(this);
        String fullHelp = Build.VERSION.SDK_INT >= 34
                ? "안드로이드 14부터는 전화·알람 앱이 아니면 직접 켜야 합니다. 꺼져 있으면 잠금화면 위로 뜨지 않고 위쪽 알림으로만 울립니다."
                : "이 휴대폰(안드로이드 13 이하)에서는 따로 켤 필요가 없습니다.";
        row("3. 전체 화면 알림", fullScreen, fullHelp, "설정 열기", v -> {
            if (Build.VERSION.SDK_INT >= 34) open(new Intent(ACTION_MANAGE_FULL_SCREEN, Uri.parse("package:" + getPackageName())));
            else toast("이 휴대폰에서는 따로 켤 필요가 없습니다");
        });

        Button test = button("1분 뒤 시험 알람 걸기", Color.WHITE, ACCENT);
        test.setOnClickListener(v -> {
            String id = "test-" + System.currentTimeMillis();
            BlackholeAlarms.Result result = BlackholeAlarms.schedule(this, id, "블랙홀 시험 알람", System.currentTimeMillis() + 60_000L);
            toast(result.ok ? "시험 알람: " + result.message + " — 화면을 끄고 기다려 보세요" : result.message);
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(20), 0, 0);
        body.addView(test, params);
        body.addView(text("소리 크기는 휴대폰의 「알람」 음량을 따릅니다. 방해 금지 모드에서 알람이 허용되어 있어야 울립니다.", 12, MUTED));
        SystemBarInsets.setContentView(this, scroll, BG);
    }

    private void row(String label, boolean ok, String help, String action, android.view.View.OnClickListener click) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable box = new GradientDrawable();
        box.setColor(SURFACE);
        box.setStroke(dp(1), LINE);
        card.setBackground(box);
        TextView head = text(label + "  ·  " + (ok ? "허용됨" : "꺼짐"), 16, ok ? ACCENT : DANGER);
        head.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        card.addView(head);
        card.addView(text(help, 13, MUTED));
        if (!ok || label.startsWith("1")) {
            Button button = button(action, INK, SURFACE);
            button.setOnClickListener(click);
            card.addView(button);
        }
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(12), 0, 0);
        body.addView(card, params);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        build();
    }

    private void open(Intent intent) {
        try { startActivity(intent); }
        catch (Exception error) { toast("설정 화면을 열 수 없습니다. 휴대폰 설정 › 앱 › 말해둬에서 직접 바꿔 주세요."); }
    }

    private Button button(String label, int textColor, int fill) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextColor(textColor);
        button.setMinHeight(dp(48));
        GradientDrawable box = new GradientDrawable();
        box.setColor(fill);
        box.setStroke(dp(1), LINE);
        button.setBackground(box);
        return button;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setPadding(0, dp(4), 0, dp(4));
        return view;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
