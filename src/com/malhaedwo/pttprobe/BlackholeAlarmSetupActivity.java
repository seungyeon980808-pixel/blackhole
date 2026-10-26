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
 * 「블랙홀 시작하기」: 설치 직후 한 번 자동으로 뜨는 안내(이후 보내기 화면·주 화면에서 다시 열 수 있음).
 * 필요한 권한을 한 화면에서 순서대로 — 마이크, 알림, 전체 화면 알림, 정확한 알람, 배터리 최적화 제외 —
 * 각 줄에 지금 상태와 허용·설정 바로가기. 그 아래 잠금화면 입력 알림, 홈 화면 위젯 추가, 1분 뒤 시험 알람.
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
    private static final int REQUEST_MIC = 52;
    /** 첫 실행 안내를 본 적이 있음(다시 자동으로 띄우지 않음). */
    static final String PREF_WELCOME_SEEN = "welcome_seen_v1";

    /** 주 화면이 처음 열릴 때 한 번만. */
    static boolean shouldWelcome(android.content.Context context) {
        return !Blackhole.prefs(context).getBoolean(PREF_WELCOME_SEEN, false);
    }
    static final String ACTION_MANAGE_FULL_SCREEN = "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT";

    private LinearLayout body;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("블랙홀 시작하기");
        Blackhole.prefs(this).edit().putBoolean(PREF_WELCOME_SEEN, true).apply();
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

        TextView title = text("블랙홀 시작하기", 22, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        body.addView(title);
        body.addView(text("아래가 모두 「허용됨」이면 바로 쓸 수 있습니다. 말하거나 적은 것은 바로 달력에 초안으로 들어가고, Mac이 정리해 다듬습니다.", 14, MUTED));

        boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        row("1. 마이크", mic, "「말하기」와 음량 버튼 녹음에 씁니다.", mic ? "" : "허용", v -> {
            if (shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) || !mic) requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
        });
        boolean notify = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        row("2. 알림", notify, "알람·잠금화면 할 일·보내기 상태를 알림으로 보입니다.", notify ? "알림 설정" : "허용", v -> {
            if (!notify) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFY);
            else open(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        });
        boolean fullScreen = BlackholeAlarms.canFullScreen(this);
        String fullHelp = Build.VERSION.SDK_INT >= 34
                ? "알람이 잠금화면 위로 전화처럼 뜹니다. 꺼져 있으면 위쪽 알림으로만 울립니다."
                : "이 휴대폰에서는 따로 켤 필요가 없습니다.";
        row("3. 전체 화면 알림", fullScreen, fullHelp, "설정 열기", v -> {
            if (Build.VERSION.SDK_INT >= 34) open(new Intent(ACTION_MANAGE_FULL_SCREEN, Uri.parse("package:" + getPackageName())));
            else toast("이 휴대폰에서는 따로 켤 필요가 없습니다");
        });
        boolean exact = BlackholeAlarms.canExact(this);
        row("4. 알람 및 리마인더", exact, "정해 둔 시각에 정확히 울리게 합니다. 꺼져 있으면 알람을 걸 수 없습니다.", "설정 열기",
                v -> open(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName()))));
        android.os.PowerManager power = getSystemService(android.os.PowerManager.class);
        boolean battery = power != null && power.isIgnoringBatteryOptimizations(getPackageName());
        row("5. 배터리 최적화 제외", battery, "녹음 대기와 Mac 달력 받기가 잠자는 동안 멈추지 않게 합니다. 목록에서 블랙홀을 「제한 없음」으로 바꿔 주세요.", "설정 열기",
                v -> open(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)));

        TextView extra = text("고르면 더 편한 것", 16, INK);
        extra.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        extra.setPadding(0, dp(18), 0, dp(2));
        body.addView(extra);
        boolean quick = BlackholeQuickNotification.isEnabled(this);
        Button quickButton = button(quick ? "잠금화면 입력 알림 켜짐 · 끄기" : "잠금화면 입력 알림 켜기 (말하기·적기·사진)", INK, SURFACE);
        quickButton.setOnClickListener(v -> {
            String why = BlackholeQuickNotification.setEnabled(this, !BlackholeQuickNotification.isEnabled(this));
            if (why != null) toast(why);
            build();
        });
        body.addView(quickButton);
        body.addView(text("잠금을 풀지 않고 말하거나 적어 보낼 수 있습니다. 오늘 할 일의 「완료」는 이 설정과 상관없이 알림에 나옵니다.", 12, MUTED));
        Button widget = button("홈 화면에 블랙홀 위젯 추가", INK, SURFACE);
        widget.setOnClickListener(v -> {
            android.appwidget.AppWidgetManager manager = android.appwidget.AppWidgetManager.getInstance(this);
            boolean asked = manager != null && manager.isRequestPinAppWidgetSupported()
                    && manager.requestPinAppWidget(new android.content.ComponentName(this, CalendarWidgetProvider.class), null, null);
            if (!asked) toast("홈 화면을 길게 누르고 위젯 › 블랙홀을 골라 주세요");
        });
        body.addView(widget);

        Button test = button("1분 뒤 시험 알람 걸기", Color.WHITE, ACCENT);
        test.setOnClickListener(v -> {
            String id = "test-" + System.currentTimeMillis();
            BlackholeAlarms.Result result = BlackholeAlarms.schedule(this, id, "블랙홀 시험 알람", System.currentTimeMillis() + 60_000L);
            toast(result.ok ? "시험 알람: " + result.message + " — 화면을 끄고 기다려 보세요" : result.message);
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(20), 0, 0);
        body.addView(test, params);
        String sound = BlackholeAlarms.soundProblem(this);
        body.addView(text(sound == null
                ? "알람 소리 · 괜찮음 — 소리 크기는 휴대폰의 「알람」 음량을 따르고, 무음·진동 모드에서도 울립니다. 방해 금지 모드에서는 「알람 허용」(기본 켜짐)일 때 울립니다."
                : "알람 소리 · 확인 필요 — " + sound, 12, sound == null ? MUTED : DANGER));
        body.addView(text("아무도 누르지 않으면 5분 뒤 그치고 「놓친 알람」 알림으로 남습니다. 휴대폰이 꺼져 있던 동안 지난 알람도 켜면 「놓친 알람」으로 보입니다.", 12, MUTED));
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
        if (!action.isEmpty() && (!ok || label.startsWith("2"))) {
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
        // 거부했고 다시 묻지 않음으로 막혔으면 앱 설정으로 보낸다.
        for (int i = 0; i < permissions.length && i < results.length; i++) {
            if (results[i] != PackageManager.PERMISSION_GRANTED && !shouldShowRequestPermissionRationale(permissions[i])) {
                toast("휴대폰 설정에서 허용해 주세요 — 블랙홀 › 권한");
                open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                break;
            }
        }
        build();
    }

    private void open(Intent intent) {
        try { startActivity(intent); }
        catch (Exception error) { toast("설정 화면을 열 수 없습니다. 휴대폰 설정 › 앱 › 블랙홀에서 직접 바꿔 주세요."); }
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
