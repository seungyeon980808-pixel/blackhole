package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 「보내기」 대화 화면. 문장·사진·음성을 보내면 보내기 대기열에 원본을 두고 드라이브 「블랙홀/인박스/」로 올린다.
 * 승인 DB·시트 동기화와는 별개다. 지난 대화가 보이므로 잠금화면 위에는 뜨지 않는다(잠금 입력은 BlackholeLockCaptureActivity).
 */
public final class BlackholeSendActivity extends Activity {
    private static final int BG = Color.rgb(216, 221, 218);
    private static final int SURFACE = Color.rgb(244, 246, 243);
    private static final int INK = Color.rgb(20, 32, 25);
    private static final int MUTED = Color.rgb(104, 115, 108);
    private static final int LINE = Color.rgb(170, 178, 173);
    private static final int ACCENT = Color.rgb(33, 104, 73);
    private static final int ACCENT_SOFT = Color.rgb(217, 232, 223);
    private static final int DANGER = Color.rgb(155, 51, 44);
    private static final int REQUEST_PICK = 31;
    private static final int REQUEST_CAMERA = 32;
    private static final int REQUEST_MIC = 33;

    private LinearLayout messages;
    private ScrollView messageScroll;
    private TextView statusView;
    private EditText input;
    private Button voiceButton;
    private Button quickToggle;
    private BlackholeCapture.Voice voice;
    private BlackholeCapture.PhotoTarget photoTarget;
    private boolean receiverRegistered;

    private final BroadcastReceiver changed = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { refresh(); }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("블랙홀");
        voice = new BlackholeCapture.Voice(this);
        if (state != null && state.getString("photo") != null) {
            String name = state.getString("photo");
            photoTarget = new BlackholeCapture.PhotoTarget(new java.io.File(Blackhole.captureDir(this), name),
                    BlackholeCaptureProvider.uriFor(name));
        }
        buildUi();
        Blackhole.requestUpload(this);
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (photoTarget != null) out.putString("photo", photoTarget.file.getName());
    }

    @Override protected void onStart() {
        super.onStart();
        CalendarRefreshJob.refreshAsync(this);
        if (!receiverRegistered) {
            registerReceiver(changed, new IntentFilter(BlackholeUploadJob.ACTION_CHANGED), Context.RECEIVER_NOT_EXPORTED);
            receiverRegistered = true;
        }
        refresh();
    }

    @Override protected void onStop() {
        if (receiverRegistered) {
            unregisterReceiver(changed);
            receiverRegistered = false;
        }
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (voice != null && voice.recording()) voice.cancel();
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(SURFACE);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.VERTICAL);
        head.setPadding(dp(16), dp(12), dp(16), dp(10));
        head.setBackground(box(SURFACE, LINE));
        TextView title = text("블랙홀로 보내기", 22, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        head.addView(title);
        statusView = text("", 13, MUTED);
        head.addView(statusView);
        LinearLayout tools = new LinearLayout(this);
        tools.setOrientation(LinearLayout.HORIZONTAL);
        tools.setPadding(0, dp(8), 0, 0);
        quickToggle = smallButton("", INK);
        quickToggle.setOnClickListener(v -> toggleQuick());
        tools.addView(quickToggle, weight());
        Button alarm = smallButton("권한·알람·위젯", INK);
        alarm.setOnClickListener(v -> startActivity(new Intent(this, BlackholeAlarmSetupActivity.class)));
        tools.addView(alarm, weight());
        head.addView(tools);
        root.addView(head);

        messageScroll = new ScrollView(this);
        messageScroll.setFillViewport(true);
        messageScroll.setBackgroundColor(BG);
        messages = new LinearLayout(this);
        messages.setOrientation(LinearLayout.VERTICAL);
        messages.setPadding(dp(12), dp(12), dp(12), dp(12));
        messageScroll.addView(messages);
        root.addView(messageScroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setPadding(dp(10), dp(8), dp(10), dp(10));
        bar.setBackground(box(SURFACE, LINE));
        input = new EditText(this);
        input.setHint("적어서 던지기 — 일정·할 일·기억 무엇이든");
        input.setTextSize(16);
        input.setTextColor(INK);
        input.setMinHeight(dp(48));
        input.setMaxLines(5);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        bar.addView(input);
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        Button photo = smallButton("사진", INK);
        photo.setOnClickListener(v -> choosePhoto());
        actions.addView(photo, weight());
        voiceButton = smallButton("말하기", INK);
        voiceButton.setOnClickListener(v -> toggleVoice());
        actions.addView(voiceButton, weight());
        Button send = smallButton("보내기", Color.WHITE);
        send.setBackground(box(ACCENT, ACCENT));
        send.setOnClickListener(v -> sendText());
        actions.addView(send, weight());
        bar.addView(actions);
        root.addView(bar);

        // 시스템 바는 SystemBarInsets가 맡고, 키보드(IME)만 여기서 입력칸 아래로 비켜 준다.
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
            View parent = (View) view.getParent();
            int already = parent == null ? 0 : parent.getPaddingBottom();
            view.setPadding(0, 0, 0, Math.max(0, ime - already));
            return insets;
        });
        SystemBarInsets.setContentView(this, root, BG);
    }

    private void refresh() {
        if (messages == null) return;
        BlackholeOutbox outbox = Blackhole.outbox(this);
        List<BlackholeOutbox.Entry> recent = outbox.recent(60);
        messages.removeAllViews();
        if (recent.isEmpty()) {
            TextView empty = text("아직 보낸 것이 없습니다.\n문장·사진·음성을 던져 두면 Mac이 일정·할 일·기억으로 정리합니다.", 14, MUTED);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(12), dp(40), dp(12), dp(40));
            messages.addView(empty);
        }
        SimpleDateFormat time = new SimpleDateFormat("M/d HH:mm", Locale.KOREA);
        for (BlackholeOutbox.Entry entry : recent) if (!BlackholeVoiceText.hidden(entry)) messages.addView(bubble(outbox, entry, time));
        int waiting = 0;
        for (BlackholeOutbox.Entry entry : recent) if (!entry.uploaded()) waiting++;
        String connection = !Blackhole.online(this) ? "오프라인 · 연결되면 자동으로 보냄 · "
                : GoogleOAuth.isConnected(this) ? "" : "Google 연결 필요(첫 화면 「Google 연결」) · ";
        String last = Blackhole.prefs(this).getString(Blackhole.PREF_LAST_UPLOAD, "");
        statusView.setText(connection + (waiting == 0 ? "모두 보냄" : "올릴 것 " + waiting + "개")
                + (last == null || last.isEmpty() ? "" : " · 최근: " + last));
        quickToggle.setText(BlackholeQuickNotification.isEnabled(this) ? "잠금화면 입력 끄기" : "잠금화면 입력 켜기");
        messageScroll.post(() -> messageScroll.fullScroll(View.FOCUS_DOWN));
    }

    private View bubble(BlackholeOutbox outbox, BlackholeOutbox.Entry entry, SimpleDateFormat time) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setGravity(Gravity.END);
        row.setPadding(dp(40), dp(4), 0, dp(4));
        TextView body = text(describe(outbox, entry), 15, INK);
        body.setPadding(dp(12), dp(9), dp(12), dp(9));
        body.setBackground(box(entry.uploaded() ? ACCENT_SOFT : SURFACE, LINE));
        row.addView(body, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        String state;
        int color = MUTED;
        if (entry.uploaded()) state = "인박스에 올림";
        else if (BlackholeOutbox.STATE_FAILED.equals(entry.state)) {
            state = entry.lastError.contains("자동으로") ? entry.lastError : "다시 시도 예정 · " + entry.lastError;
            color = DANGER;
        } else state = "올릴 차례";
        TextView meta = text(time.format(new Date(entry.createdAt)) + " · " + sourceLabel(entry.source) + " · " + state, 11, color);
        meta.setGravity(Gravity.END);
        row.addView(meta);
        return row;
    }

    private static String describe(BlackholeOutbox outbox, BlackholeOutbox.Entry entry) {
        switch (entry.kind) {
            case BlackholeOutbox.KIND_TEXT: return outbox.readText(entry, 400);
            case BlackholeOutbox.KIND_PHOTO: return "사진 " + size(entry.bytes);
            case BlackholeOutbox.KIND_VOICE: return "음성 " + size(entry.bytes);
            default: return "파일 " + (entry.displayName.isEmpty() ? entry.ext : entry.displayName) + " " + size(entry.bytes);
        }
    }

    private static String sourceLabel(String source) {
        if (BlackholeOutbox.SOURCE_LOCK.equals(source)) return "잠금화면";
        if (BlackholeOutbox.SOURCE_SHARE.equals(source)) return "공유";
        if (BlackholeOutbox.SOURCE_PTT.equals(source)) return "녹음 버튼";
        return "대화";
    }

    private static String size(long bytes) {
        if (bytes >= 1024 * 1024) return String.format(Locale.ROOT, "(%.1fMB)", bytes / 1048576.0);
        return "(" + Math.max(1, bytes / 1024) + "KB)";
    }

    private void sendText() {
        String text = input.getText().toString();
        if (text.trim().isEmpty()) return;
        try {
            Blackhole.sendText(this, text, BlackholeOutbox.SOURCE_CHAT);
            input.setText("");
        } catch (Exception error) {
            toast("보내지 못했습니다 — " + Blackhole.localError(error));
        }
        refresh();
    }

    private void choosePhoto() {
        new AlertDialog.Builder(this)
                .setTitle("사진 보내기")
                .setItems(new String[]{"카메라로 찍기", "앨범·파일에서 고르기"}, (dialog, which) -> {
                    if (which == 0) openCamera();
                    else openPicker();
                })
                .show();
    }

    private void openCamera() {
        photoTarget = BlackholeCapture.newPhotoTarget(this);
        try { startActivityForResult(BlackholeCapture.photoIntent(photoTarget, false), REQUEST_CAMERA); }
        catch (Exception error) { photoTarget = null; toast("카메라 앱을 열 수 없습니다"); }
    }

    private void openPicker() {
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.setType("*/*");
        pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "application/pdf", "text/plain", "audio/*", "application/*"});
        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        try { startActivityForResult(pick, REQUEST_PICK); }
        catch (Exception error) { toast("파일 고르기 화면을 열 수 없습니다"); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_CAMERA) {
            BlackholeCapture.PhotoTarget target = photoTarget;
            photoTarget = null;
            if (resultCode != RESULT_OK) {
                if (target != null) {
                    //noinspection ResultOfMethodCallIgnored
                    target.file.delete();
                }
                return;
            }
            String error = BlackholeCapture.keepPhoto(this, target, BlackholeOutbox.SOURCE_CHAT);
            if (error != null) toast(error);
            refresh();
        } else if (requestCode == REQUEST_PICK && resultCode == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri uri = clip.getItemAt(i).getUri();
                    if (uri != null) uris.add(uri);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            BlackholeShareActivity.importAsync(this, uris, null, BlackholeOutbox.SOURCE_CHAT, message -> {
                toast(message);
                refresh();
            });
        }
    }

    private void toggleVoice() {
        if (voice.recording()) {
            voiceButton.setText("보내는 중…");
            voice.stopAndSend(BlackholeOutbox.SOURCE_CHAT, (ok, message) -> {
                voiceButton.setText("말하기");
                toast(message);
                refresh();
            });
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
            return;
        }
        voiceButton.setText("준비 중…");
        voice.start((ok, message) -> {
            voiceButton.setText(ok ? "멈추고 보내기" : "말하기");
            if (!ok) toast(message);
        });
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQUEST_MIC && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) toggleVoice();
        else if (requestCode == REQUEST_MIC) toast("마이크 권한이 있어야 말하기를 보낼 수 있습니다");
    }

    private void toggleQuick() {
        boolean enable = !BlackholeQuickNotification.isEnabled(this);
        String result = BlackholeQuickNotification.setEnabled(this, enable);
        if (result != null) toast(result);
        refresh();
    }

    private Button smallButton(String label, int color) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(14);
        button.setTextColor(color);
        button.setMinHeight(dp(46));
        button.setBackground(box(SURFACE, LINE));
        return button;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setLineSpacing(dp(2), 1f);
        return view;
    }

    private GradientDrawable box(int fill, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        params.setMargins(dp(3), dp(3), dp(3), dp(3));
        return params;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_SHORT).show(); }
}
