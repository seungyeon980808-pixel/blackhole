package com.malhaedwo.pttprobe;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;

import java.io.File;
import java.util.UUID;

/** 대화 화면과 잠금화면 입력이 같이 쓰는 사진 찍기·말하기. 결과는 보내기 대기열로만 간다. */
final class BlackholeCapture {
    private BlackholeCapture() {}

    interface Done { void done(boolean ok, String message); }

    // ---- 사진 ----

    static final class PhotoTarget {
        final File file;
        final Uri uri;
        PhotoTarget(File file, Uri uri) { this.file = file; this.uri = uri; }
    }

    static PhotoTarget newPhotoTarget(Context context) {
        String name = "photo-" + UUID.randomUUID().toString().replace("-", "") + ".jpg";
        return new PhotoTarget(new File(Blackhole.captureDir(context), name), BlackholeCaptureProvider.uriFor(name));
    }

    /** 잠금 상태에서는 잠금 위에서 뜨는 카메라(…_SECURE)를 부른다. 찍은 사진만 받고 앨범은 열지 않는다. */
    static Intent photoIntent(PhotoTarget target, boolean locked) {
        Intent intent = new Intent(locked ? MediaStore.ACTION_IMAGE_CAPTURE_SECURE : MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, target.uri);
        intent.setClipData(ClipData.newRawUri("", target.uri));
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    static String keepPhoto(Context context, PhotoTarget target, String source) {
        try {
            if (target == null || !target.file.isFile() || target.file.length() == 0) return "사진이 저장되지 않았습니다";
            Blackhole.outbox(context).addFile(target.file, BlackholeOutbox.KIND_PHOTO, source, "", "image/jpeg",
                    System.currentTimeMillis());
            Blackhole.requestUpload(context);
            return null;
        } catch (Exception error) {
            return "사진을 보내지 못했습니다: " + error.getMessage();
        }
    }

    // ---- 말하기 ----

    /** 한 번에 하나만 녹음한다. start()·stop()은 화면 스레드에서 부르고, 실제 일은 뒤에서 한다. */
    static final class Voice {
        private final Context app;
        private final Handler main = new Handler(Looper.getMainLooper());
        private WavRecorder recorder;
        private File file;
        private boolean busy;

        Voice(Context context) { this.app = context.getApplicationContext(); }

        boolean recording() { return recorder != null; }

        void start(Done done) {
            if (busy || recorder != null) return;
            busy = true;
            File target = new File(Blackhole.captureDir(app), "voice-" + UUID.randomUUID().toString().replace("-", "") + ".wav");
            WavRecorder next = new WavRecorder(target);
            new Thread(() -> {
                String error = null;
                try { next.start(); }
                catch (Throwable failure) {
                    next.abort();
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                    error = "녹음을 시작하지 못했습니다: " + failure.getMessage();
                }
                String message = error;
                main.post(() -> {
                    busy = false;
                    if (message == null) { recorder = next; file = target; }
                    done.done(message == null, message == null ? "듣는 중" : message);
                });
            }, "BlackholeVoiceStart").start();
        }

        void stopAndSend(String source, Done done) {
            WavRecorder current = recorder;
            File target = file;
            if (current == null || busy) return;
            busy = true;
            recorder = null;
            file = null;
            new Thread(() -> {
                String message;
                boolean ok = false;
                try {
                    WavRecorder.Result result = current.stop();
                    if (result.durationMs < 400 || result.pcmBytes == 0) {
                        //noinspection ResultOfMethodCallIgnored
                        target.delete();
                        message = "너무 짧아서 보내지 않았습니다";
                    } else {
                        Blackhole.outbox(app).addFile(target, BlackholeOutbox.KIND_VOICE, source, "", "audio/wav",
                                System.currentTimeMillis());
                        Blackhole.requestUpload(app);
                        ok = true;
                        message = "음성을 보냈습니다";
                    }
                } catch (Throwable failure) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                    message = "음성을 보내지 못했습니다: " + failure.getMessage();
                }
                boolean sent = ok;
                String text = message;
                main.post(() -> { busy = false; done.done(sent, text); });
            }, "BlackholeVoiceStop").start();
        }

        void cancel() {
            WavRecorder current = recorder;
            File target = file;
            recorder = null;
            file = null;
            if (current != null) current.abort();
            if (target != null) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
        }
    }
}
