package com.malhaedwo.pttprobe;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 카메라 앱이 찍은 사진을 앱 안 임시 칸(blackhole-capture/)에 바로 쓰게 하는 최소 제공자.
 * 내보내지 않고(exported=false) 카메라를 부를 때 그 한 장의 쓰기 권한만 잠깐 준다.
 */
public final class BlackholeCaptureProvider extends ContentProvider {
    static final String AUTHORITY = "com.malhaedwo.pttprobe.blackhole.capture";

    static Uri uriFor(String fileName) {
        return Uri.parse("content://" + AUTHORITY + "/" + Uri.encode(fileName));
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri == null ? null : uri.getLastPathSegment();
        if (name == null || !name.matches("[A-Za-z0-9_-]+\\.jpg")) throw new FileNotFoundException("허용되지 않은 경로");
        File file = new File(Blackhole.captureDir(getContext()), name);
        int flags = mode != null && mode.contains("w")
                ? ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE
                : ParcelFileDescriptor.MODE_READ_ONLY;
        return ParcelFileDescriptor.open(file, flags);
    }

    @Override public String getType(Uri uri) { return "image/jpeg"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
