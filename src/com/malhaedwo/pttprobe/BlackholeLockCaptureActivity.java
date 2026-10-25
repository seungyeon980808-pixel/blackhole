package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 잠금화면 위에서 뜨는 보내기 전용 화면(말하기·사진). 지난 대화·대기열·다른 화면으로 가는 길이 없다.
 * 끝나면 바로 닫히고 잠금은 그대로다.
 */
public final class BlackholeLockCaptureActivity extends Activity {
    static final String EXTRA_MODE = "mode";
    static final String MODE_VOICE = "voice";
    static final String MODE_PHOTO = "photo";
    private static final int REQUEST_CAMERA = 41;
    private static final int BG = Color.rgb(14, 18, 16);
    private static final int INK = Color.rgb(236, 240, 237);
    private static final int MUTED = Color.rgb(150, 160, 154);
    private static final int ACCENT = Color.rgb(33, 104, 73);

    private BlackholeCapture.Voice voice;
    private BlackholeCapture.PhotoTarget photoTarget;
    private TextView status;
    private Button main;

    static Intent intent(Context context, String mode) {
        return new Intent(context, BlackholeLockCaptureActivity.class)
                .putExtra(EXTRA_MODE, mode)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true);
        setTurnScreenOn(false);
        voice = new BlackholeCapture.Voice(this);
        buildUi();
        String mode = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_MODE);
        if (state != null && state.getString("photo") != null) {
            String name = state.getString("photo");
            photoTarget = new BlackholeCapture.PhotoTarget(new java.io.File(Blackhole.captureDir(this), name),
                    BlackholeCaptureProvider.uriFor(name));
        } else if (MODE_PHOTO.equals(mode)) {
            openCamera();
        } else {
            startVoice();
        }
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (photoTarget != null) out.putString("photo", photoTarget.file.getName());
    }

    @Override protected void onDestroy() {
        if (voice != null && voice.recording()) voice.cancel();
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(BG);
        root.setPadding(dp(24), dp(48), dp(24), dp(48));
        TextView title = new TextView(this);
        title.setText("블랙홀");
        title.setTextColor(INK);
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        root.addView(title);
        status = new TextView(this);
        status.setTextColor(MUTED);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(16), 0, dp(28));
        root.addView(status);
        main = new Button(this);
        main.setAllCaps(false);
        main.setTextSize(20);
        main.setTextColor(Color.WHITE);
        main.setMinHeight(dp(84));
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(ACCENT);
        fill.setCornerRadius(dp(42));
        main.setBackground(fill);
        main.setOnClickListener(v -> onMain());
        root.addView(main, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        Button cancel = new Button(this);
        cancel.setAllCaps(false);
        cancel.setText("취소");
        cancel.setTextColor(MUTED);
        cancel.setBackgroundColor(Color.TRANSPARENT);
        cancel.setOnClickListener(v -> { if (voice.recording()) voice.cancel(); finish(); });
        root.addView(cancel);
        TextView note = new TextView(this);
        note.setText("잠금 중에는 보내기만 됩니다. 지난 내용은 잠금을 푼 뒤 앱에서 볼 수 있습니다.");
        note.setTextColor(MUTED);
        note.setTextSize(12);
        note.setGravity(Gravity.CENTER);
        note.setPadding(0, dp(24), 0, 0);
        root.addView(note);
        setContentView(root);
    }

    private void startVoice() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            // 잠금화면 위에서는 권한 창을 띄우지 않는다. 잠금을 푼 뒤 앱에서 허용해야 한다.
            status.setText("마이크 권한이 없습니다. 잠금을 풀고 앱에서 허용해 주세요.");
            main.setText("닫기");
            return;
        }
        status.setText("준비 중…");
        main.setText("멈추고 보내기");
        main.setEnabled(false);
        voice.start((ok, message) -> {
            main.setEnabled(true);
            status.setText(ok ? "듣고 있습니다. 다 말했으면 누르세요." : message);
            if (!ok) main.setText("닫기");
        });
    }

    private void onMain() {
        if (voice.recording()) {
            main.setEnabled(false);
            status.setText("보내는 중…");
            voice.stopAndSend(BlackholeOutbox.SOURCE_LOCK, (ok, message) -> {
                Toast.makeText(getApplicationContext(), message, Toast.LENGTH_SHORT).show();
                BlackholeQuickNotification.refresh(this);
                finish();
            });
        } else {
            finish();
        }
    }

    private void openCamera() {
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        photoTarget = BlackholeCapture.newPhotoTarget(this);
        status.setText("카메라를 여는 중…");
        main.setText("닫기");
        try {
            startActivityForResult(BlackholeCapture.photoIntent(photoTarget, locked), REQUEST_CAMERA);
        } catch (Exception secureMissing) {
            try { startActivityForResult(BlackholeCapture.photoIntent(photoTarget, false), REQUEST_CAMERA); }
            catch (Exception error) {
                photoTarget = null;
                status.setText("카메라 앱을 열 수 없습니다");
            }
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_CAMERA) return;
        BlackholeCapture.PhotoTarget target = photoTarget;
        photoTarget = null;
        if (resultCode == RESULT_OK) {
            String error = BlackholeCapture.keepPhoto(this, target, BlackholeOutbox.SOURCE_LOCK);
            Toast.makeText(getApplicationContext(), error == null ? "사진을 보냈습니다" : error, Toast.LENGTH_SHORT).show();
        } else if (target != null) {
            //noinspection ResultOfMethodCallIgnored
            target.file.delete();
        }
        finish();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
