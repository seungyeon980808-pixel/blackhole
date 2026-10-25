package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class PttService extends Service {
    public static final String ACTION_ARM = "com.malhaedwo.pttprobe.ARM";
    public static final String ACTION_DISARM = "com.malhaedwo.pttprobe.DISARM";
    public static final String BROADCAST_STATUS = "com.malhaedwo.pttprobe.STATUS";
    private static final String CHANNEL_ID = "ptt_ready";
    private static final int NOTIFICATION_ID = 2501;
    private static final long WARNING_MS = 50_000L;
    private static final long MAX_MS = 60_000L;
    private static volatile PttService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean armed;
    private volatile boolean recording;
    private WavRecorder recorder;
    private String recordingSource = "unknown";
    private PowerManager.WakeLock wakeLock;
    private ScreenOffVolumeBridge screenOffBridge;
    private boolean screenReceiverRegistered;

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String action = intent == null ? null : intent.getAction();
            if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                if (armed && screenOffBridge != null) screenOffBridge.setEnabled(true);
            } else if (Intent.ACTION_SCREEN_ON.equals(action)) {
                if (screenOffBridge != null) screenOffBridge.setEnabled(false);
            }
        }
    };

    private final Runnable warningRunnable = () -> {
        if (recording) {
            Haptics.warning(this);
            publish("50초 경과, 10초 뒤 자동 종료");
        }
    };
    private final Runnable timeoutRunnable = () -> {
        if (recording) stopRecording(true, "60초 자동 종료");
    };

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        screenOffBridge = new ScreenOffVolumeBridge(this);
        IntentFilter screenFilter = new IntentFilter();
        screenFilter.addAction(Intent.ACTION_SCREEN_OFF);
        screenFilter.addAction(Intent.ACTION_SCREEN_ON);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            registerReceiver(screenReceiver, screenFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(screenReceiver, screenFilter);
        }
        screenReceiverRegistered = true;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_DISARM.equals(action)) {
            disarmInternal();
            return START_NOT_STICKY;
        }
        // Starts never opt in. Even a previously queued ARM must obey a later stop.
        if ((intent != null && !ACTION_ARM.equals(action)) || !PttReadiness.isEnabled(this)) {
            stopReadiness();
            return START_NOT_STICKY;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            restoreFailed("마이크 권한 필요 · 앱에서 복구해주세요");
            return START_NOT_STICKY;
        }
        try {
            startForegroundCompat(buildNotification("PTT 대기 유지 · 녹음은 버튼을 누를 때만 시작", false));
            armed = true; // Never report ready before Android accepts foreground promotion.
            PowerManager powerManager = getSystemService(PowerManager.class);
            if (screenOffBridge != null) screenOffBridge.setEnabled(!powerManager.isInteractive());
            PttStore.append(this, "PTT_ARMED", "service", "foreground_service_started");
            publish("PTT 대기 유지 중");
            return START_STICKY;
        } catch (RuntimeException error) {
            restoreFailed("대기 복구 필요 · 앱을 열어주세요: " + safeMessage(error));
            return START_NOT_STICKY;
        }
    }

    public static void arm(Context context) {
        if (!PttReadiness.setEnabled(context, true)) {
            PttStore.markError(context, "service", "PTT 대기 설정 저장 실패");
            return;
        }
        restoreIfEnabled(context);
    }

    /** Called only at eligible lifecycle opportunities, never by boot/polling. */
    public static void restoreIfEnabled(Context context) {
        if (!PttReadiness.isEnabled(context) || isArmed()) return;
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            PttStore.markError(context, "service", "대기 복구 필요 · 마이크 권한 없음");
            return;
        }
        try {
            context.startForegroundService(new Intent(context, PttService.class).setAction(ACTION_ARM));
        } catch (RuntimeException error) {
            PttStore.markError(context, "service", "대기 복구 필요 · 앱을 열어주세요: " + safeMessage(error));
        }
    }

    public static void disarm(Context context) {
        if (!PttReadiness.setEnabled(context, false)) {
            PttStore.markError(context, "service", "PTT 종료 설정 저장 실패 · 다시 종료해주세요");
        }
        PttService service = instance;
        if (service != null) {
            // Close the press gate immediately, before queued input/restore callbacks.
            service.armed = false;
            service.main.post(service::stopReadiness);
        } else {
            context.stopService(new Intent(context, PttService.class));
        }
    }

    public static boolean isArmed() {
        PttService service = instance;
        return service != null && service.armed;
    }

    public static boolean isRecording() {
        PttService service = instance;
        return service != null && service.recording;
    }

    public static boolean press(long keyEventElapsed, String source) {
        PttService service = instance;
        if (service == null || !service.armed) return false;
        service.main.post(() -> service.startRecording(keyEventElapsed, source));
        return true;
    }

    public static boolean release(String source) {
        PttService service = instance;
        if (service == null || !service.armed) return false;
        service.main.post(() -> service.stopRecording(false, "버튼 해제"));
        return true;
    }

    private void startRecording(long keyEventElapsed, String source) {
        if (!armed || !PttReadiness.isEnabled(this) || recording) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail(source, "마이크 권한이 없습니다");
            return;
        }
        File dir = PttStore.recordingsDirectory(this);
        String name = "PTT-" + new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.KOREA).format(new Date()) +
                "-" + Long.toUnsignedString(System.nanoTime(), 36) + ".wav";
        File file = new File(dir, name);
        WavRecorder next = new WavRecorder(file);
        try {
            acquireWakeLock();
            long audioStarted = next.start();
            recorder = next;
            recording = true;
            recordingSource = source;
            long latency = Math.max(0, audioStarted - keyEventElapsed);
            PttStore.markStarted(this, latency, source);
            Haptics.start(this);
            startForegroundCompat(buildNotification("녹음 중, 버튼을 놓으면 저장됩니다", true));
            main.postDelayed(warningRunnable, WARNING_MS);
            main.postDelayed(timeoutRunnable, MAX_MS);
            publish("녹음 시작, 지연 " + latency + "ms");
        } catch (Throwable error) {
            next.abort();
            releaseWakeLock();
            fail(source, "녹음 시작 실패: " + safeMessage(error));
        }
    }

    private void stopRecording(boolean autoStop, String reason) {
        if (!recording) return;
        recording = false;
        main.removeCallbacks(warningRunnable);
        main.removeCallbacks(timeoutRunnable);
        WavRecorder current = recorder;
        recorder = null;
        String source = recordingSource;
        try {
            WavRecorder.Result result = current.stop();
            PttStore.markSaved(this, result.file, result.durationMs, result.peakAmplitude, source, autoStop);
            Haptics.stop(this);
            String signal = result.peakAmplitude < 300 ? ", 음성 신호 매우 약함" : ", 음성 신호 감지됨";
            publish(reason + ", 저장 완료" + signal + ": " + result.file.getName());
            try {
                long captureId = CaptureDatabase.get(this).insertAudio(
                        result.file, source, result.durationMs, result.peakAmplitude);
                TranscriptionManager.enqueue(this, captureId, result.file);
            } catch (Throwable databaseError) {
                PttStore.markError(this, "database", "음성 원본 목록 저장 실패: " + safeMessage(databaseError));
            }
            BlackholePttHandoff.send(this, result.file);
        } catch (Throwable error) {
            fail(source, "녹음 저장 실패: " + safeMessage(error));
        } finally {
            releaseWakeLock();
            if (armed) startForegroundCompat(buildNotification("PTT 준비됨, 최근 녹음 저장 완료", false));
        }
    }

    private void disarmInternal() {
        if (!PttReadiness.setEnabled(this, false)) {
            PttStore.markError(this, "service", "PTT 종료 설정 저장 실패 · 다시 종료해주세요");
        }
        stopReadiness();
    }

    private void restoreFailed(String message) {
        PttStore.markError(this, "service", message);
        stopReadiness();
        publish(message);
    }

    private void stopReadiness() {
        armed = false;
        if (recording) stopRecording(false, "PTT 종료");
        if (screenOffBridge != null) screenOffBridge.setEnabled(false);
        PttStore.append(this, "PTT_NOT_READY", "service", "readiness_stopped");
        publish("PTT 대기 종료");
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void fail(String source, String message) {
        PttStore.markError(this, source, message);
        Haptics.error(this);
        publish(message);
        if (armed) startForegroundCompat(buildNotification("오류: " + message, false));
    }

    private void publish(String message) {
        Intent intent = new Intent(BROADCAST_STATUS).setPackage(getPackageName());
        intent.putExtra("message", message);
        sendBroadcast(intent);
    }

    private Notification buildNotification(String text, boolean activeRecording) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 10, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, PttService.class).setAction(ACTION_DISARM);
        PendingIntent stopIntent = PendingIntent.getService(this, 11, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle(activeRecording ? "말해둬 PTT 녹음 중" : "말해둬 PTT 준비됨")
                .setContentText(text)
                .setContentIntent(content)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(
                        android.graphics.drawable.Icon.createWithResource(this, android.R.drawable.ic_media_pause),
                        "PTT 종료", stopIntent).build());
        if (activeRecording) builder.setUsesChronometer(true).setWhen(System.currentTimeMillis());
        return builder.build();
    }

    private void startForegroundCompat(Notification notification) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
    }

    private void createChannel() {
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "PTT 준비 상태",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("물리 버튼 녹음 준비 및 진행 상태");
        channel.setSound(null, null);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        releaseWakeLock();
        PowerManager manager = getSystemService(PowerManager.class);
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Malhaedwo:PttRecording");
        wakeLock.acquire(65_000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null ? error.getClass().getSimpleName() : message;
    }

    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (recording && recorder != null) {
            PttStore.markError(this, recordingSource, "서비스가 종료되어 진행 중 녹음을 취소했습니다");
            recorder.abort();
        }
        recorder = null;
        recording = false;
        armed = false;
        releaseWakeLock();
        if (screenReceiverRegistered) {
            try { unregisterReceiver(screenReceiver); } catch (Throwable ignored) {}
            screenReceiverRegistered = false;
        }
        if (screenOffBridge != null) {
            screenOffBridge.release();
            screenOffBridge = null;
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
