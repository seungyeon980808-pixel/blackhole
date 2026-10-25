package com.malhaedwo.pttprobe;

import android.Manifest;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.accessibility.AccessibilityManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(216, 221, 218);
    private static final int SURFACE = Color.rgb(244, 246, 243);
    private static final int INK = Color.rgb(20, 32, 25);
    private static final int MUTED = Color.rgb(104, 115, 108);
    private static final int LINE = Color.rgb(170, 178, 173);
    private static final int ACCENT = Color.rgb(33, 104, 73);
    private static final int ACCENT_SOFT = Color.rgb(217, 232, 223);
    private static final int AMBER = Color.rgb(146, 96, 25);
    private static final int AMBER_SOFT = Color.rgb(244, 235, 215);
    private static final int DANGER = Color.rgb(155, 51, 44);
    private static final int DANGER_SOFT = Color.rgb(246, 229, 226);
    private static final int RADIUS_DP = 0;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService syncBootstrapExecutor = Executors.newSingleThreadExecutor();
    private TextView readinessView;
    private TextView liveView;
    private TextView resultView;
    private TextView syncView;
    private TextView inboxCountView;
    private TextView readinessDiagnosticsView;
    private TextView settingsToggle;
    private LinearLayout settingsBody;
    private Button permissionButton;
    private Button armButton;
    private Button disarmButton;
    private Button holdButton;
    private MediaPlayer player;
    private boolean receiverRegistered;

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String message = intent.getStringExtra("message");
            if (message != null && liveView != null) liveView.setText("최근 상태  " + message);
            refresh();
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("말해둬");
        buildUi();
        requestNeededPermissions();
        TranscriptionManager.retryPending(this);
        runLocalReconciliation();
        SyncScheduler.ensurePeriodic(this);
        SyncScheduler.request(this);
        BlackholeQuickNotification.refresh(this);
        handleOAuthIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOAuthIntent(intent);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        refresh();
        runLocalReconciliation();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(SURFACE);
        scroll.addView(root);

        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(14), dp(12), dp(14), dp(10));
        head.setBackground(roundRect(SURFACE, 0, LINE, 1));
        TextView title = text("말해둬", 22, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        head.addView(title, weight());
        liveView = text("PTT CHECK", 11, ACCENT);
        liveView.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        liveView.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        head.addView(liveView, new LinearLayout.LayoutParams(dp(125), dp(36)));
        root.addView(head);

        LinearLayout summary = new LinearLayout(this);
        summary.setGravity(Gravity.CENTER_VERTICAL);
        summary.setMinimumHeight(dp(108));
        summary.setBackground(roundRect(SURFACE, 0, INK, 1));
        inboxCountView = text("0", 58, INK);
        inboxCountView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        inboxCountView.setGravity(Gravity.CENTER);
        inboxCountView.setPadding(dp(12), 0, dp(8), 0);
        summary.addView(inboxCountView, new LinearLayout.LayoutParams(dp(100), dp(104)));
        TextView summaryCopy = text("승인 대기\n말한 내용을 확인한 뒤 일정과 할 일로 등록합니다.", 14, INK);
        summaryCopy.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        summaryCopy.setPadding(dp(13), 0, dp(10), 0);
        summaryCopy.setBackground(roundRect(SURFACE, 0, LINE, 1));
        summary.addView(summaryCopy, weight());
        root.addView(summary);

        LinearLayout status = new LinearLayout(this);
        status.setGravity(Gravity.CENTER_VERTICAL);
        status.setBackground(roundRect(SURFACE, 0, INK, 1));
        readinessView = text("상태 확인 중", 11, INK);
        readinessView.setPadding(dp(13), dp(10), dp(10), dp(10));
        readinessView.setGravity(Gravity.CENTER_VERTICAL);
        status.addView(readinessView, weight());
        syncView = text("동기화 확인 중", 11, MUTED);
        syncView.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        syncView.setPadding(dp(10), dp(10), dp(13), dp(10));
        syncView.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        syncView.setBackground(roundRect(SURFACE, 0, LINE, 1));
        status.addView(syncView, new LinearLayout.LayoutParams(dp(126), dp(48)));
        root.addView(status);

        permissionButton = outlinedButton("마이크·알림 권한 허용", ACCENT, SURFACE);
        permissionButton.setOnClickListener(v -> requestNeededPermissions());
        root.addView(permissionButton);
        armButton = filledButton("PTT 켜기", ACCENT);
        armButton.setOnClickListener(v -> toggleArmState());
        root.addView(armButton);

        TextView pttLabel = text("VOICE CAPTURE / HOLD TO TALK", 11, MUTED);
        pttLabel.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        pttLabel.setPadding(dp(13), dp(13), dp(13), dp(5));
        root.addView(pttLabel);
        holdButton = filledButton("누르고 말하기\n놓으면 저장하고 인식합니다", ACCENT);
        holdButton.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL);
        holdButton.setMinHeight(dp(86));
        holdButton.setTextSize(18);
        holdButton.setOnTouchListener((v, event) -> handleHoldTouch(event));
        root.addView(holdButton);
        disarmButton = outlinedButton("PTT 끄기", DANGER, SURFACE);
        disarmButton.setTextSize(13);
        disarmButton.setVisibility(View.GONE);
        disarmButton.setOnClickListener(v -> { PttService.disarm(this); refresh(); });
        root.addView(disarmButton);

        LinearLayout inboxRow = rowCard();
        inboxRow.setOnClickListener(v -> startActivity(new Intent(this, InboxActivity.class)));
        TextView inboxCopy = text("승인함 열기", 15, INK);
        inboxCopy.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        inboxRow.addView(inboxCopy, weight());
        TextView inboxArrow = text("›", 26, MUTED);
        inboxArrow.setGravity(Gravity.CENTER);
        inboxRow.addView(inboxArrow, new LinearLayout.LayoutParams(dp(42), dp(48)));
        root.addView(inboxRow);

        LinearLayout blackholeRow = rowCard();
        blackholeRow.setOnClickListener(v -> startActivity(new Intent(this, BlackholeSendActivity.class)));
        TextView blackholeCopy = text("블랙홀로 보내기  ·  문장·사진·음성", 15, INK);
        blackholeCopy.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        blackholeRow.addView(blackholeCopy, weight());
        TextView blackholeArrow = text("›", 26, MUTED);
        blackholeArrow.setGravity(Gravity.CENTER);
        blackholeRow.addView(blackholeArrow, new LinearLayout.LayoutParams(dp(42), dp(48)));
        root.addView(blackholeRow);

        settingsToggle = text("설정 · 진단  /  펼치기", 14, INK);
        settingsToggle.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        settingsToggle.setGravity(Gravity.CENTER_VERTICAL);
        settingsToggle.setPadding(dp(13), 0, dp(13), 0);
        settingsToggle.setMinHeight(dp(52));
        settingsToggle.setBackground(roundRect(SURFACE, 0, LINE, 1));
        settingsToggle.setOnClickListener(v -> toggleSettings());
        root.addView(settingsToggle);

        settingsBody = new LinearLayout(this);
        settingsBody.setOrientation(LinearLayout.VERTICAL);
        settingsBody.setVisibility(View.GONE);
        root.addView(settingsBody);
        addSettingsActions();
        readinessDiagnosticsView = cardText();
        readinessDiagnosticsView.setTextSize(11);
        readinessDiagnosticsView.setTypeface(Typeface.MONOSPACE);
        settingsBody.addView(readinessDiagnosticsView);
        resultView = cardText();
        resultView.setTextSize(12);
        settingsBody.addView(resultView);
        TextView note = text("원본 녹음과 정리 결과는 앱 내부에 보존됩니다. Google 연결을 선택하면 본인 소유의 비공개 Sheet와 Drive에만 동기화합니다.", 11, MUTED);
        note.setPadding(dp(13), dp(12), dp(13), dp(18));
        settingsBody.addView(note);
        SystemBarInsets.setContentView(this, scroll, BG);
    }

    private void addSettingsActions() {
        Button accessibility = outlinedButton("물리 버튼 접근성 설정", INK, SURFACE);
        accessibility.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        settingsBody.addView(accessibility);

        Button hapticTest = outlinedButton("진동 시험", INK, SURFACE);
        hapticTest.setOnClickListener(v -> {
            Haptics.runTest(this);
            toast(Haptics.diagnostic(this));
        });
        settingsBody.addView(hapticTest);

        Button googleConnect = outlinedButton("Google 동기화 연결·재연결", ACCENT, ACCENT_SOFT);
        googleConnect.setOnClickListener(v -> GoogleOAuth.begin(this, (success, message) -> {
            toast(message);
            refresh();
        }));
        settingsBody.addView(googleConnect);

        Button syncNow = outlinedButton("지금 동기화", ACCENT, ACCENT_SOFT);
        syncNow.setOnClickListener(v -> {
            if (!GoogleOAuth.isConnected(this)) {
                toast("먼저 Google 동기화를 연결해주세요");
                return;
            }
            SyncScheduler.request(this);
            toast("Sheets와 Drive 동기화를 요청했습니다");
            handler.postDelayed(this::refresh, 500);
        });
        settingsBody.addView(syncNow);

        Button googleDisconnect = outlinedButton("Google 동기화 연결 해제", DANGER, DANGER_SOFT);
        googleDisconnect.setOnClickListener(v -> new android.app.AlertDialog.Builder(this)
                .setTitle("Google 동기화를 해제할까요?")
                .setMessage("휴대전화 안의 녹음과 승인 항목은 그대로 남습니다. 저장된 OAuth 토큰은 Keystore 암호화 저장소에서 삭제됩니다.")
                .setNegativeButton("취소", null)
                .setPositiveButton("연결 해제", (dialog, which) -> {
                    toast("Google 권한 해제를 요청했습니다");
                    GoogleOAuth.disconnect(this, (success, message) -> {
                        if (success) SyncScheduler.cancel(this);
                        toast(message);
                        refresh();
                    });
                }).show());
        settingsBody.addView(googleDisconnect);

        Button speechModel = outlinedButton("한국어 음성 모델 준비", INK, SURFACE);
        speechModel.setOnClickListener(v -> SpeechModelManager.requestKorean(this, this::toast));
        settingsBody.addView(speechModel);

        Button exactAlarm = outlinedButton("정확한 알림 권한 설정", INK, SURFACE);
        exactAlarm.setOnClickListener(v -> openExactAlarmSettings());
        settingsBody.addView(exactAlarm);

        Button play = outlinedButton("최근 녹음 재생·정지", INK, SURFACE);
        play.setOnClickListener(v -> togglePlayback());
        settingsBody.addView(play);

        Button copy = outlinedButton("진단 요약 복사", INK, SURFACE);
        copy.setOnClickListener(v -> {
            String diagnostic = readinessText() + "\n" + PttStore.summary(this);
            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
            clipboard.setPrimaryClip(ClipData.newPlainText("PTT 진단", diagnostic));
            toast("진단 요약을 복사했습니다");
        });
        settingsBody.addView(copy);

        Button clear = outlinedButton("시험 횟수 초기화", DANGER, DANGER_SOFT);
        clear.setOnClickListener(v -> {
            PttStore.clear(this);
            refresh();
        });
        settingsBody.addView(clear);

        Button privacy = outlinedButton("개인정보처리방침", INK, SURFACE);
        privacy.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW,
                Uri.parse("https://example.invalid/blackhole/privacy"))));
        settingsBody.addView(privacy);
    }

    private void toggleArmState() {
        if (!PttReadiness.isEnabled(this) || !PttService.isArmed()) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestNeededPermissions();
                toast("먼저 마이크 권한을 허용해주세요");
                return;
            }
            PttService.arm(this);
            toast("PTT 서비스를 준비합니다");
            handler.postDelayed(this::refresh, 500);
        } else {
            PttService.disarm(this);
            refresh();
        }
    }

    private boolean handleHoldTouch(MotionEvent event) {
        if (!PttService.isArmed()) {
            if (event.getAction() == MotionEvent.ACTION_DOWN) toast("먼저 PTT 켜기를 눌러주세요");
            return true;
        }
        if (event.getAction() == MotionEvent.ACTION_DOWN) {
            holdButton.setText("녹음 중 · 놓으면 저장");
            holdButton.setBackground(roundRect(DANGER, dp(RADIUS_DP), Color.TRANSPARENT, 0));
            PttService.press(SystemClock.uptimeMillis(), "screen");
            return true;
        }
        if (event.getAction() == MotionEvent.ACTION_UP || event.getAction() == MotionEvent.ACTION_CANCEL) {
            holdButton.setText("누르고 말하기");
            holdButton.setBackground(roundRect(ACCENT, dp(RADIUS_DP), Color.TRANSPARENT, 0));
            PttService.release("screen");
            return true;
        }
        return true;
    }

    @Override protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(PttService.BROADCAST_STATUS);
        filter.addAction(SyncState.ACTION_CHANGED);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(statusReceiver, filter);
        }
        receiverRegistered = true;
        refresh();
    }

    @Override protected void onResume() {
        super.onResume();
        PttService.restoreIfEnabled(this);
        refresh();
        runLocalReconciliation();
    }

    @Override protected void onStop() {
        if (receiverRegistered) {
            unregisterReceiver(statusReceiver);
            receiverRegistered = false;
        }
        super.onStop();
    }

    @Override protected void onDestroy() {
        syncBootstrapExecutor.shutdownNow();
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    private void runLocalReconciliation() {
        syncBootstrapExecutor.execute(() -> {
            try {
                CaptureAutomation.processAllReady(getApplicationContext());
                runOnUiThread(this::refresh);
            } catch (Throwable error) {
                runOnUiThread(() -> toast("로컬 알림·캘린더 상태 확인 실패: " +
                        (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage())));
            }
        });
    }

    private void requestNeededPermissions() {
        String[] candidates = android.os.Build.VERSION.SDK_INT >= 33
                ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                : new String[]{Manifest.permission.RECORD_AUDIO};
        int missingCount = 0;
        for (String permission : candidates) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missingCount++;
        }
        if (missingCount == 0) {
            refresh();
            return;
        }
        String[] missingPermissions = new String[missingCount];
        int index = 0;
        for (String permission : candidates) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                missingPermissions[index++] = permission;
            }
        }
        requestPermissions(missingPermissions, 100);
    }

    private void refresh() {
        if (readinessView == null) return;
        boolean allPermissionsGranted = hasAllRequiredPermissions();
        boolean accessibilityReady = isAccessibilityEnabled();
        boolean armed = PttService.isArmed();
        boolean recording = PttService.isRecording();
        readinessView.setText(readinessHeadline());
        int readinessColor = recording ? DANGER :
                (hasMicrophonePermission() && accessibilityReady && armed ? ACCENT : AMBER);
        int readinessFill = recording ? DANGER_SOFT :
                (hasMicrophonePermission() && accessibilityReady && armed ? ACCENT_SOFT : AMBER_SOFT);
        readinessView.setTextColor(readinessColor);
        readinessView.setBackground(roundRect(readinessFill, dp(RADIUS_DP), Color.TRANSPARENT, 0));
        permissionButton.setVisibility(allPermissionsGranted ? View.GONE : View.VISIBLE);
        // Alarm readiness is intentionally separate from PTT readiness; settings may be changed outside the app.
        armButton.setVisibility(armed ? View.GONE : View.VISIBLE);
        armButton.setText(PttReadiness.isEnabled(this) ? "PTT 복구" : "PTT 켜기");
        disarmButton.setVisibility(PttReadiness.isEnabled(this) ? View.VISIBLE : View.GONE);
        disarmButton.setEnabled(!recording);
        disarmButton.setAlpha(recording ? 0.45f : 1f);
        holdButton.setEnabled(armed);
        holdButton.setAlpha(armed ? 1f : 0.45f);
        if (recording) {
            holdButton.setText("녹음 중 · 놓으면 저장");
            holdButton.setBackground(roundRect(DANGER, dp(RADIUS_DP), Color.TRANSPARENT, 0));
        } else {
            holdButton.setText("누르고 말하기");
            holdButton.setBackground(roundRect(ACCENT, dp(RADIUS_DP), Color.TRANSPARENT, 0));
        }
        int pending = pendingReviewCount();
        inboxCountView.setText(String.valueOf(pending));
        inboxCountView.setTextColor(INK);
        inboxCountView.setBackgroundColor(Color.TRANSPARENT);
        syncView.setText(compactSyncText());
        if (readinessDiagnosticsView != null) {
            readinessDiagnosticsView.setText(readinessText() + "\n" + SyncState.summary(this));
        }
        if (resultView != null) resultView.setText(PttStore.summary(this));
    }

    private int pendingReviewCount() {
        int count = 0;
        for (CaptureItem item : CaptureDatabase.get(this).listAll(200)) {
            if (item.isPendingApproval() || "PENDING".equals(item.status)) count++;
        }
        return count;
    }

    private boolean hasMicrophonePermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAllRequiredPermissions() {
        return hasMicrophonePermission() && (android.os.Build.VERSION.SDK_INT < 33 ||
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
    }

    private String readinessHeadline() {
        if (!hasMicrophonePermission()) return PttReadiness.isEnabled(this)
                ? "대기 복구 필요 · 설정은 유지돼요. 먼저 마이크 권한을 허용해주세요."
                : "기록을 시작하기 전에 마이크 권한을 확인해주세요.";
        if (PttService.isRecording()) return "기록하고 있어요. 말을 마치면 화면에서 손을 떼세요.";
        if (PttService.isArmed()) return isAccessibilityEnabled()
                ? "PTT 대기 유지 중 · 상시 알림 표시 · 화면 꺼짐 물리 버튼은 접근성과 시스템 상태에 의존해요."
                : "화면 PTT 대기 중 · 물리 버튼은 접근성을 켜야 해요. 상시 알림이 유지됩니다.";
        if (PttReadiness.isEnabled(this)) return "대기 복구 필요 · 설정은 유지돼요. 마이크 권한 확인 후 PTT 복구를 눌러주세요. 시스템 제한으로 중단될 수 있어요.";
        return "한 번 PTT 켜기를 누르면 대기 설정을 기억해요. 상시 알림이 유지되며, 종료하면 자동 복구도 꺼져요.";
    }

    private String compactSyncText() {
        if (!GoogleOAuth.isConnected(this)) return "연결 안 됨";
        int pending = CaptureDatabase.get(this).pendingSyncCount();
        return pending > 0 ? "대기 " + pending + "개" : "연결됨";
    }

    private void toggleSettings() {
        boolean show = settingsBody.getVisibility() != View.VISIBLE;
        settingsBody.setVisibility(show ? View.VISIBLE : View.GONE);
        settingsToggle.setText(show ? "설정 및 문제 해결  ·  접기"
                : "설정 및 문제 해결  ·  펼치기");
    }

    private void handleOAuthIntent(Intent intent) {
        boolean consumed = GoogleOAuth.consumeCallback(this, intent, (success, message) -> {
            toast(message);
            if (success) {
                SyncScheduler.ensurePeriodic(this);
                syncBootstrapExecutor.execute(() -> {
                    try {
                        CaptureDatabase.get(getApplicationContext()).queueAllForSync();
                        runOnUiThread(this::refresh);
                    } catch (Throwable error) {
                        runOnUiThread(() -> toast("Google 연결은 완료됐지만 첫 동기화 준비에 실패했습니다: " +
                                (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage())));
                    }
                });
            }
            refresh();
        });
        if (consumed) setIntent(new Intent(this, MainActivity.class));
    }

    private String readinessText() {
        boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        ReminderScheduler.Readiness reminder = ReminderScheduler.notificationReadiness(this, false);
        boolean exactAlarm = canScheduleExactAlarms();
        boolean accessibility = isAccessibilityEnabled();
        return "마이크 권한: " + yesNo(mic) +
                "\n일정 알림 전달: " + yesNo(reminder.deliveryReady) +
                "\n일정 알림 진동: " + yesNo(reminder.vibrationReady) +
                (reminder.message.isEmpty() ? "" : " (" + reminder.message + ")") +
                "\n정확한 알람 특별 접근: " + (exactAlarm ? "허용" : "정시 알림 불가") +
                "\n물리 버튼 접근성: " + yesNo(accessibility) +
                "\nPTT 서비스: " + (PttService.isArmed() ? "대기 유지 중" : PttReadiness.isEnabled(this) ? "복구 필요 (설정 유지)" : "꺼짐") +
                "\n현재 녹음: " + (PttService.isRecording() ? "진행 중" : "아님") +
                "\n음성 정리: " + (TranscriptionManager.isBusy() ? "처리 중" : "대기");
    }

    private boolean isAccessibilityEnabled() {
        ComponentName expectedComponent = new ComponentName(this, VolumeKeyService.class);
        AccessibilityManager manager = getSystemService(AccessibilityManager.class);
        if (manager != null) {
            List<AccessibilityServiceInfo> services = manager.getEnabledAccessibilityServiceList(
                    AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            for (AccessibilityServiceInfo info : services) {
                String id = info.getId();
                if (id == null) continue;
                ComponentName enabledComponent = ComponentName.unflattenFromString(id);
                if (expectedComponent.equals(enabledComponent)) return true;
            }
        }
        return isAccessibilityEnabledInSecureSettings(expectedComponent);
    }

    private boolean isAccessibilityEnabledInSecureSettings(ComponentName expectedComponent) {
        String enabledServices = Settings.Secure.getString(
                getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabledServices == null || enabledServices.isEmpty()) return false;
        int start = 0;
        while (start <= enabledServices.length()) {
            int separator = enabledServices.indexOf(':', start);
            String entry = separator >= 0
                    ? enabledServices.substring(start, separator)
                    : enabledServices.substring(start);
            ComponentName enabledComponent = ComponentName.unflattenFromString(entry.trim());
            if (expectedComponent.equals(enabledComponent)) return true;
            if (separator < 0) break;
            start = separator + 1;
        }
        return false;
    }

    private void openExactAlarmSettings() {
        android.app.AlarmManager manager = getSystemService(android.app.AlarmManager.class);
        if (manager != null && manager.canScheduleExactAlarms()) {
            toast("정확한 알림이 이미 허용되어 있습니다");
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                    Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Throwable error) {
            toast("설정 > 애플리케이션 > 특별한 접근 > 알람 및 리마인더에서 허용해주세요");
        }
    }

    private boolean canScheduleExactAlarms() {
        android.app.AlarmManager manager = getSystemService(android.app.AlarmManager.class);
        return manager != null && manager.canScheduleExactAlarms();
    }

    private void togglePlayback() {
        if (player != null && player.isPlaying()) {
            player.stop();
            player.release();
            player = null;
            toast("재생을 정지했습니다");
            return;
        }
        File file = PttStore.getLastFile(this);
        if (file == null) {
            toast("저장된 녹음이 없습니다");
            return;
        }
        try {
            player = new MediaPlayer();
            player.setDataSource(this, Uri.fromFile(file));
            player.prepare();
            player.setOnCompletionListener(mp -> {
                mp.release();
                player = null;
            });
            player.start();
            toast("최근 녹음을 재생합니다");
        } catch (Exception error) {
            toast("재생 실패: " + error.getMessage());
        }
    }

    private LinearLayout rowCard() {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(13), 0, dp(6), 0);
        row.setMinimumHeight(dp(52));
        row.setBackground(roundRect(SURFACE, 0, LINE, 1));
        return row;
    }

    private TextView cardText() {
        TextView view = text("", 13, INK);
        view.setPadding(dp(13), dp(11), dp(13), dp(11));
        view.setBackground(roundRect(SURFACE, 0, LINE, 1));
        return view;
    }

    private Button filledButton(String label, int color) {
        return button(label, color, Color.TRANSPARENT, 0, Color.WHITE);
    }

    private Button outlinedButton(String label, int textColor, int fillColor) {
        return button(label, fillColor, textColor, 1, textColor);
    }

    private Button button(String label, int fillColor, int strokeColor, int strokeWidth, int textColor) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(textColor);
        button.setTextSize(15);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER_VERTICAL);
        button.setMinHeight(dp(52));
        button.setMinimumHeight(dp(52));
        button.setPadding(dp(13), 0, dp(13), 0);
        button.setStateListAnimator(null);
        button.setElevation(0);
        button.setBackground(roundRect(fillColor, dp(RADIUS_DP), strokeColor, strokeWidth));
        button.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)));
        return button;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.15f);
        return view;
    }

    private LinearLayout.LayoutParams spaced() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    }

    private GradientDrawable roundRect(int color, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        if (strokeWidth > 0) drawable.setStroke(dp(strokeWidth), strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String yesNo(boolean value) { return value ? "허용됨" : "필요"; }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_SHORT).show(); }
}
