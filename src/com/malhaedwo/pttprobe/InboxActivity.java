package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
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
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class InboxActivity extends Activity {
    private static final int CALENDAR_PERMISSION = 201;
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
    private static final DateTimeFormatter EDIT_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");
    private static final DateTimeFormatter DISPLAY_FORMAT = DateTimeFormatter.ofPattern("M월 d일 EEEE · a h:mm", Locale.KOREA);
    private static final DateTimeFormatter CREATED_FORMAT = DateTimeFormatter.ofPattern("M월 d일 a h:mm", Locale.KOREA);

    private LinearLayout listRoot;
    private TextView summary;
    private TextView summaryMeta;
    private MediaPlayer player;
    private boolean receiverRegistered;
    private final BroadcastReceiver syncReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { refresh(); }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        buildUi();
        TranscriptionManager.retryPending(this);
    }

    @Override protected void onResume() {
        super.onResume();
        CaptureAutomation.processAllReady(this);
        refresh();
    }

    @Override protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(SyncState.ACTION_CHANGED);
        if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(syncReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(syncReceiver, filter);
        receiverRegistered = true;
    }

    @Override protected void onStop() {
        if (receiverRegistered) {
            unregisterReceiver(syncReceiver);
            receiverRegistered = false;
        }
        super.onStop();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(SURFACE);
        scroll.addView(root);

        LinearLayout topBar = row();
        topBar.setPadding(0, 0, dp(10), 0);
        topBar.setBackground(roundRect(SURFACE, 0, INK, 1));
        Button back = actionButton("‹", false, INK);
        back.setTextSize(28);
        back.setTypeface(Typeface.DEFAULT, Typeface.NORMAL);
        back.setContentDescription("뒤로 가기");
        back.setOnClickListener(v -> finish());
        topBar.addView(back, new LinearLayout.LayoutParams(dp(52), dp(52)));
        LinearLayout titleBlock = new LinearLayout(this);
        titleBlock.setOrientation(LinearLayout.VERTICAL);
        titleBlock.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text("승인함", 19, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        titleBlock.addView(title);
        TextView subtitle = text("음성 초안을 검토하고 실제 일정으로 등록", 11, MUTED);
        titleBlock.addView(subtitle);
        topBar.addView(titleBlock, new LinearLayout.LayoutParams(0, dp(52), 1f));
        Button sync = actionButton("동기화", false, ACCENT);
        sync.setOnClickListener(v -> {
            if (!GoogleOAuth.isConnected(this)) { toast("메인 화면에서 Google 동기화를 먼저 연결해주세요"); return; }
            SyncScheduler.request(this);
            toast("Sheets와 Drive 동기화를 요청했습니다");
        });
        topBar.addView(sync, new LinearLayout.LayoutParams(dp(82), dp(52)));
        root.addView(topBar);

        LinearLayout metrics = row();
        metrics.setBackground(roundRect(SURFACE, 0, INK, 1));
        summary = text("", 22, INK);
        summary.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        summary.setPadding(dp(13), dp(9), dp(8), dp(9));
        metrics.addView(summary, new LinearLayout.LayoutParams(0, dp(62), 1f));
        summaryMeta = text("", 11, MUTED);
        summaryMeta.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        summaryMeta.setGravity(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
        summaryMeta.setPadding(dp(8), dp(8), dp(13), dp(8));
        summaryMeta.setBackground(roundRect(SURFACE, 0, LINE, 1));
        metrics.addView(summaryMeta, new LinearLayout.LayoutParams(dp(150), dp(62)));
        root.addView(metrics);

        LinearLayout tools = row();
        tools.setBackground(roundRect(SURFACE, 0, LINE, 1));
        Button retry = actionButton("중단된 인식 재개", false, INK);
        retry.setOnClickListener(v -> { TranscriptionManager.retryPending(this); toast("원본 음성 인식을 다시 시도합니다"); refresh(); });
        tools.addView(retry, weight(1f, dp(48)));
        Button calendar = actionButton("보낼 캘린더 선택", false, ACCENT);
        calendar.setOnClickListener(v -> configureCalendar());
        tools.addView(calendar, weight(1f, dp(48)));
        root.addView(tools);

        TextView listLabel = text("검토할 기록", 11, MUTED);
        listLabel.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        listLabel.setPadding(dp(13), dp(13), dp(13), dp(7));
        root.addView(listLabel);
        listRoot = new LinearLayout(this);
        listRoot.setOrientation(LinearLayout.VERTICAL);
        root.addView(listRoot);
        SystemBarInsets.setContentView(this, scroll, BG);
    }

    private void refresh() {
        if (listRoot == null) return;
        List<CaptureItem> items = CaptureDatabase.get(this).listAll(200);
        List<CaptureItem> pending = new ArrayList<>();
        List<CaptureItem> approved = new ArrayList<>();
        for (CaptureItem item : items) {
            if (item.isPendingApproval() || "PENDING".equals(item.status)) pending.add(item);
            else approved.add(item);
        }
        int pendingSync = CaptureDatabase.get(this).pendingSyncCount();
        summary.setText("확인할 항목 " + pending.size() + "개");
        summaryMeta.setText(approved.size() + "개 등록됨 · " +
                (pendingSync == 0 ? "동기화 완료" : "동기화 " + pendingSync + "개 대기"));
        listRoot.removeAllViews();

        if (pending.isEmpty()) listRoot.addView(emptyCard("검토할 음성 초안이 없습니다.", "새 음성이 들어오면 이곳에서 확인할 수 있습니다."));
        else for (CaptureItem item : pending) listRoot.addView(itemCard(item));

        if (!approved.isEmpty()) {
            listRoot.addView(sectionHeader("등록된 일정과 할 일", approved.size(), false));
            for (CaptureItem item : approved) listRoot.addView(itemCard(item));
        }
    }

    private View sectionHeader(String label, int count, boolean first) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text(label, 18, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        row.addView(title);
        TextView countView = text(String.valueOf(count), 12, first ? AMBER : ACCENT);
        countView.setGravity(Gravity.CENTER);
        countView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        countView.setBackground(roundRect(first ? AMBER_SOFT : ACCENT_SOFT, dp(14), Color.TRANSPARENT, 0));
        LinearLayout.LayoutParams countParams = new LinearLayout.LayoutParams(dp(30), dp(26));
        countParams.setMargins(dp(8), 0, 0, 0);
        row.addView(countView, countParams);
        row.setPadding(0, first ? dp(18) : dp(26), 0, dp(6));
        return row;
    }

    private View emptyCard(String titleValue, String description) {
        LinearLayout card = baseCard();
        TextView title = text(titleValue, 15, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        card.addView(title);
        TextView body = text(description, 14, MUTED);
        body.setPadding(0, dp(4), 0, 0);
        card.addView(body);
        return card;
    }

    private View itemCard(CaptureItem item) {
        LinearLayout card = baseCard();

        LinearLayout top = row();
        if (!item.isPendingApproval()) {
            TextView state = text(statusLabel(item), 12, statusColor(item));
            state.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            state.setGravity(Gravity.CENTER);
            state.setPadding(dp(9), 0, dp(9), 0);
            state.setBackground(roundRect(statusBackground(item), dp(14), Color.TRANSPARENT, 0));
            top.addView(state, new LinearLayout.LayoutParams(-2, dp(26)));
        }
        TextView source = text(sourceLabel(item) + " · " + formatCreated(item.createdAt), 12, MUTED);
        source.setGravity((item.isPendingApproval() ? Gravity.LEFT : Gravity.RIGHT) | Gravity.CENTER_VERTICAL);
        top.addView(source, new LinearLayout.LayoutParams(0, dp(26), 1f));
        card.addView(top);

        String displayTitle = item.title == null || item.title.trim().isEmpty()
                ? ("TRANSCRIBING".equals(item.status) ? "음성을 정리하고 있습니다" :
                        ("AUDIO_ONLY".equals(item.status) ? "음성을 확인해 주세요" : "제목을 확인해 주세요"))
                : item.title;
        TextView title = text(displayTitle, 18, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setMaxLines(2);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setPadding(0, dp(8), 0, dp(3));
        card.addView(title);

        String meta = areaLabel(item) + " · " + kindLabel(item);
        if (item.startAt > 0) meta += " · " + formatTime(item.startAt);
        else if (item.isSchedule()) meta += " · 날짜와 시간을 확인해주세요";
        TextView metaView = text(meta, 13, item.startAt > 0 || !item.isSchedule() ? MUTED : AMBER);
        metaView.setMaxLines(1);
        metaView.setEllipsize(TextUtils.TruncateAt.END);
        card.addView(metaView);

        if (item.transcript != null && !item.transcript.trim().isEmpty()) {
            TextView transcript = text("“" + item.transcript.trim() + "”", 13, MUTED);
            transcript.setMaxLines(2);
            transcript.setEllipsize(TextUtils.TruncateAt.END);
            transcript.setPadding(0, dp(8), 0, 0);
            card.addView(transcript);
        }
        if (item.error != null && !item.error.trim().isEmpty()) {
            TextView error = text(item.error, 13, DANGER);
            error.setPadding(0, dp(8), 0, 0);
            card.addView(error);
        }
        if (item.syncError != null && !item.syncError.trim().isEmpty()) {
            TextView syncError = text("동기화 필요: " + item.syncError, 12, DANGER);
            syncError.setPadding(0, dp(7), 0, 0);
            card.addView(syncError);
        }
        if (!item.isPendingApproval()) {
            TextView sideEffects = text(sideEffectStatus(item), 12,
                    item.hasCalendarFailure() || CalendarReliability.REMINDER_BLOCKED.equals(item.reminderState)
                            ? DANGER : MUTED);
            sideEffects.setPadding(0, dp(7), 0, 0);
            card.addView(sideEffects);
        }

        LinearLayout actions = row();
        actions.setPadding(0, dp(11), 0, 0);
        Button play = actionButton("듣기", false, INK);
        play.setOnClickListener(v -> play(item));
        actions.addView(play, weight(0.8f, dp(48)));

        if (item.isPendingApproval() && "AUDIO_ONLY".equals(item.status)) {
            Button retry = actionButton("다시 인식", false, ACCENT);
            retry.setOnClickListener(v -> {
                File wav = item.audioPath == null ? null : new File(item.audioPath);
                if (wav == null || !wav.isFile()) {
                    toast("다시 인식할 원본 음성이 없습니다");
                    return;
                }
                TranscriptionManager.retry(this, item.id, wav);
                toast("저장된 음성을 다시 인식합니다");
                refresh();
            });
            actions.addView(retry, weight(1.05f, dp(48)));
            Button enter = actionButton("내용 입력", true, ACCENT);
            enter.setOnClickListener(v -> editItem(item, false));
            actions.addView(enter, weight(1.05f, dp(48)));
        } else {
            if (!item.isDeletePending()) {
                Button edit = actionButton("수정", false, INK);
                edit.setOnClickListener(v -> editItem(item, false));
                actions.addView(edit, weight(0.8f, dp(48)));
            }
            if (item.isPendingApproval()) {
                Button approve = actionButton("승인", true, ACCENT);
                approve.setEnabled(!"TRANSCRIBING".equals(item.status));
                approve.setAlpha(approve.isEnabled() ? 1f : 0.45f);
                approve.setOnClickListener(v -> approveItem(item));
                actions.addView(approve, weight(1f, dp(48)));
            } else if (item.isDeletePending()) {
                Button retryDelete = actionButton("삭제 재시도", false, DANGER);
                retryDelete.setOnClickListener(v -> {
                    CaptureAutomation.processExplicit(this, item.id);
                    refresh();
                    toast("삭제 대기 상태를 다시 확인했습니다");
                });
                actions.addView(retryDelete, weight(1.15f, dp(48)));
            } else if (item.isSchedule() || item.calendarEventId > 0) {
                boolean webCalendarLinked = item.hasRemoteCalendarLink() && item.calendarEventId <= 0;
                String calendarLabel = calendarActionLabel(item, webCalendarLinked);
                Button calendar = actionButton(calendarLabel, false, ACCENT);
                if (webCalendarLinked) calendar.setOnClickListener(v -> toast("웹 승인함에서 Google Calendar에 연결된 일정입니다"));
                else calendar.setOnClickListener(v -> syncCalendar(item));
                actions.addView(calendar, weight(1.15f, dp(48)));
            } else {
                Button done = actionButton(item.isDone() ? "완료 취소" : "완료", false, ACCENT);
                done.setOnClickListener(v -> {
                    boolean makeDone = !item.isDone();
                    CaptureDatabase.get(this).markDone(item.id, makeDone);
                    if (makeDone) {
                        ReminderScheduler.cancel(this, item.id);
                        CaptureDatabase.get(this).clearReminder(item.id);
                    }
                    else CaptureAutomation.process(this, item.id);
                    refresh();
                });
                actions.addView(done, weight(1f, dp(48)));
            }
        }
        Button delete = actionButton("삭제", false, DANGER);
        delete.setOnClickListener(v -> confirmDelete(item));
        actions.addView(delete, weight(0.72f, dp(48)));
        card.addView(actions);
        return card;
    }

    private void approveItem(CaptureItem item) {
        CaptureItem fresh = CaptureDatabase.get(this).getItem(item.id);
        if (fresh == null) return;
        if (fresh.title == null || fresh.title.trim().isEmpty() ||
                (!fresh.isSchedule() && !fresh.isTodo()) || (fresh.isSchedule() && fresh.startAt <= 0)) {
            toast("내용을 먼저 확인해주세요");
            editItem(fresh, true);
            return;
        }
        String description = fresh.title + (fresh.startAt > 0 ? "\n" + formatTime(fresh.startAt) : "") +
                "\n\n승인 전에는 실제 일정과 알림이 만들어지지 않습니다.";
        new AlertDialog.Builder(this)
                .setTitle("이 내용으로 등록할까요?")
                .setMessage(description)
                .setNegativeButton("다시 보기", null)
                .setPositiveButton("승인하고 등록", (dialog, which) -> {
                    CaptureDatabase.get(this).approve(fresh.id);
                    CaptureAutomation.process(this, fresh.id);
                    toast("승인했습니다. 블랙홀에 등록되었습니다");
                    refresh();
                }).show();
    }

    private void editItem(CaptureItem item, boolean approveAfterSave) {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(22), dp(4), dp(22), 0);

        form.addView(fieldLabel("제목"));
        EditText title = input("일정 또는 할 일 제목");
        title.setText(item.title == null ? "" : item.title);
        form.addView(title);

        form.addView(fieldLabel("종류"));
        Spinner kind = spinner(new String[]{"일정", "할 일"});
        kind.setSelection(item.isTodo() ? 1 : 0);
        form.addView(kind);

        form.addView(fieldLabel("구분"));
        Spinner area = spinner(new String[]{"개인", "학교"});
        area.setSelection("SCHOOL".equals(item.area) ? 1 : 0);
        form.addView(area);

        form.addView(fieldLabel("날짜와 시간"));
        EditText dateTime = input("예: 2026-09-03 14:00");
        if (item.startAt > 0) dateTime.setText(formatEdit(item.startAt));
        form.addView(dateTime);

        AlertDialog editDialog = new AlertDialog.Builder(this)
                .setTitle(approveAfterSave ? "확인하고 승인" : "내용 수정")
                .setView(form)
                .setNegativeButton("취소", null)
                .setPositiveButton(approveAfterSave ? "저장 후 승인" : "저장", null)
                .create();
        editDialog.setOnShowListener(dialog -> {
            AlertDialog alert = (AlertDialog) dialog;
            alert.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(ACCENT);
            alert.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String titleValue = title.getText().toString().trim();
                if (titleValue.isEmpty()) { toast("제목을 입력해주세요"); return; }
                String kindValue = kind.getSelectedItemPosition() == 0 ? "SCHEDULE" : "TODO";
                String areaValue = area.getSelectedItemPosition() == 1 ? "SCHOOL" : "PERSONAL";
                long startAt = 0;
                String timeValue = dateTime.getText().toString().trim();
                if (!timeValue.isEmpty()) {
                    try {
                        LocalDateTime parsed = LocalDateTime.parse(timeValue, EDIT_FORMAT);
                        startAt = parsed.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
                    } catch (DateTimeParseException e) {
                        toast("날짜는 2026-09-03 14:00 형식으로 입력해주세요");
                        return;
                    }
                }
                if ("SCHEDULE".equals(kindValue) && startAt == 0) {
                    toast("일정에는 날짜와 시간이 필요합니다");
                    return;
                }
                long endAt = startAt == 0 ? 0 : startAt + 60 * 60_000L;
                long reminderAt = startAt; // Existing stored reminder choices are retained until this explicit edit.
                CaptureItem before = CaptureDatabase.get(this).getItem(item.id);
                CaptureDatabase.get(this).updateEdited(item.id, titleValue, kindValue, areaValue, startAt, endAt, reminderAt);
                CaptureItem changed = CaptureDatabase.get(this).getItem(item.id);
                CaptureAutomation.withdrawNotificationAfterEdit(this, before, changed);
                if (changed != null && changed.isApproved()) CaptureAutomation.process(this, item.id);
                alert.dismiss();
                if (approveAfterSave) approveItem(CaptureDatabase.get(this).getItem(item.id));
                else refresh();
            });
        });
        editDialog.show();
    }

    private void configureCalendar() {
        if (!CalendarSync.hasPermission(this)) {
            requestPermissions(new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR}, CALENDAR_PERMISSION);
            return;
        }
        List<CalendarSync.CalendarOption> options = CalendarSync.listWritable(this);
        String[] labels = new String[options.size() + 1];
        labels[0] = "Calendar 사용 안 함";
        int selected = 0;
        long selectedId = CalendarSync.selectedCalendarId(this);
        for (int i = 0; i < options.size(); i++) {
            labels[i + 1] = options.get(i).toString();
            if (options.get(i).id == selectedId) selected = i + 1;
        }
        final int initial = selected;
        new AlertDialog.Builder(this).setTitle("보낼 캘린더 선택 · 승인은 별도")
                .setSingleChoiceItems(labels, selected, null)
                .setNegativeButton("취소", null)
                .setPositiveButton("선택", (dialog, which) -> {
                    AlertDialog alert = (AlertDialog) dialog;
                    int checked = alert.getListView() == null ? -1
                            : alert.getListView().getCheckedItemPosition();
                    if (checked < 0) checked = initial;
                    if (checked < 0 || checked >= labels.length) {
                        toast("캘린더 선택을 확인해주세요");
                        return;
                    }
                    CalendarSync.selectCalendar(this, checked == 0 ? -1 : options.get(checked - 1).id);
                    toast(checked == 0 ? "캘린더 사용 안 함을 저장했습니다" : "선택 캘린더를 저장했습니다");
                }).show();
    }

    private void syncCalendar(CaptureItem item) {
        if (!item.isApproved()) {
            toast("먼저 내용을 승인해주세요");
            return;
        }
        if (!CalendarSync.hasPermission(this)) {
            requestPermissions(new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR}, CALENDAR_PERMISSION);
            toast("권한 허용 후 다시 ‘캘린더로 보내기’를 눌러주세요");
            return;
        }
        if (!item.isSchedule() && item.calendarEventId > 0) {
            CaptureAutomation.processExplicit(this, item.id);
            CaptureItem refreshed = CaptureDatabase.get(this).getItem(item.id);
            if (refreshed != null && refreshed.hasCalendarFailure()) {
                toast("캘린더 정리 재시도 필요: " + safeText(refreshed.calendarSyncError, refreshed.error));
            } else {
                toast("일정이 아닌 항목의 캘린더 연결을 정리했습니다");
            }
            refresh();
            return;
        }
        if (CalendarSync.selectedCalendarId(this) < 0) {
            toast("먼저 보낼 캘린더를 선택해주세요");
            configureCalendar();
            return;
        }
        CaptureDatabase.get(this).prepareCalendarUpsert(item.id,
                CalendarSync.targetCalendarId(this, item), ZoneId.systemDefault().getId(), System.currentTimeMillis());
        CaptureAutomation.processExplicit(this, item.id);
        CaptureItem refreshed = CaptureDatabase.get(this).getItem(item.id);
        if (refreshed == null) return;
        if (refreshed.hasCalendarFailure()) toast("캘린더 재시도 필요: " +
                safeText(refreshed.calendarSyncError, refreshed.error));
        else toast(refreshed.calendarEventId > 0 ? "캘린더 상태를 동기화했습니다" : "캘린더 처리 상태를 확인했습니다");
        refresh();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CALENDAR_PERMISSION && CalendarSync.hasPermission(this)) {
            configureCalendar();
            CaptureAutomation.processAllReady(this);
            refresh();
        }
    }

    private void play(CaptureItem item) {
        if (player != null) {
            player.release();
            player = null;
        }
        if (item.audioPath == null || !new File(item.audioPath).isFile()) {
            toast("원본 음성 파일이 없습니다");
            return;
        }
        try {
            player = new MediaPlayer();
            player.setDataSource(this, Uri.fromFile(new File(item.audioPath)));
            player.prepare();
            player.setOnCompletionListener(mp -> { mp.release(); player = null; });
            player.start();
            toast("원본 음성을 재생합니다");
        } catch (Throwable error) {
            toast("재생 실패: " + safe(error));
        }
    }

    private void confirmDelete(CaptureItem item) {
        String extra = item.calendarEventId > 0 ? " 연결된 기기 캘린더 삭제가 확인될 때까지 이 항목은 삭제 대기 상태로 남습니다." :
                (item.hasRemoteCalendarLink() ? " 웹에서 연결한 Google Calendar 일정은 남습니다." : "");
        new AlertDialog.Builder(this)
                .setTitle("이 항목을 삭제할까요?")
                .setMessage("삭제가 확인된 항목의 승인 정보와 원본 음성은 정리됩니다." + extra)
                .setNegativeButton("취소", null)
                .setPositiveButton("삭제", (dialog, which) -> {
                    try {
                        CaptureAutomation.requestDelete(this, item.id);
                        CaptureItem after = CaptureDatabase.get(this).getItem(item.id);
                        if (after != null && after.isDeletePending()) {
                            toast("외부 캘린더 삭제를 확인하지 못해 삭제 대기로 남겼습니다");
                        }
                        refresh();
                    } catch (Throwable error) {
                        toast("삭제 실패: " + safe(error));
                    }
                }).show();
    }

    @Override protected void onDestroy() {
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    private String statusLabel(CaptureItem item) {
        switch (item.status == null ? "" : item.status) {
            case "TRANSCRIBING": return "인식 중";
            case "AUDIO_ONLY": return "내용 입력 필요";
            case "PENDING": return "승인 대기";
            case "DELETE_PENDING": return "삭제 대기";
            case "APPROVED": return item.calendarEventId > 0 ? "등록됨 · 기기 캘린더 연결" :
                    (item.hasRemoteCalendarLink() ? "등록됨 · 웹 캘린더 연결" : "등록됨");
            case "DONE": return "완료";
            default: return item.status == null ? "상태 없음" : item.status;
        }
    }

    private int statusColor(CaptureItem item) {
        if (item.isDeletePending() || item.hasCalendarFailure()) return DANGER;
        return item.isPendingApproval() ? AMBER : ACCENT;
    }

    private int statusBackground(CaptureItem item) {
        if (item.isDeletePending() || item.hasCalendarFailure()) return DANGER_SOFT;
        return item.isPendingApproval() ? AMBER_SOFT : ACCENT_SOFT;
    }

    private String sideEffectStatus(CaptureItem item) {
        String alarm = item.isSchedule()
                ? CalendarReliability.reminderStateLabel(item.reminderState)
                : "알림: 일정 아님";
        if (CalendarReliability.hasText(item.alarmLastError)) alarm += " · " + item.alarmLastError;
        String calendar = CalendarReliability.calendarStateLabel(item.calendarSyncState,
                item.calendarEventId > 0, item.isDeletePending());
        if (CalendarReliability.hasText(item.calendarSyncError)) calendar += " · " + item.calendarSyncError;
        return alarm + "\n" + calendar;
    }

    private String calendarActionLabel(CaptureItem item, boolean webCalendarLinked) {
        if (webCalendarLinked) return "웹 캘린더";
        if (!item.isSchedule() && item.calendarEventId > 0) return "캘린더 정리";
        if (item.hasCalendarFailure()) return "캘린더 재시도";
        if (CalendarReliability.CALENDAR_PENDING.equals(item.calendarSyncState)) return "캘린더 처리";
        if (item.calendarEventId > 0) return "캘린더 수정";
        return "캘린더 보내기";
    }

    private String sourceLabel(CaptureItem item) {
        if ("IMAGE".equals(item.sourceType)) return "이미지";
        if ("PDF".equals(item.sourceType)) return "PDF";
        return "음성 " + String.format(Locale.KOREA, "%.1f초", item.durationMs / 1000.0);
    }

    private String areaLabel(CaptureItem item) {
        return "SCHOOL".equals(item.area) ? "학교" : "개인";
    }

    private String kindLabel(CaptureItem item) {
        return item.isSchedule() ? "일정" : item.isTodo() ? "할 일" : "미분류";
    }

    private String formatTime(long millis) {
        return Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).format(DISPLAY_FORMAT);
    }

    private String formatCreated(long millis) {
        if (millis <= 0) return "방금";
        return Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).format(CREATED_FORMAT);
    }

    private String formatEdit(long millis) {
        return Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDateTime().format(EDIT_FORMAT);
    }

    private LinearLayout baseCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(13), dp(10), dp(13), dp(10));
        card.setBackground(roundRect(SURFACE, 0, LINE, dp(1)));
        card.setLayoutParams(fullWidth(-2, 0, 0, 0, 0));
        return card;
    }

    private LinearLayout row() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private LinearLayout.LayoutParams weight(float value, int height) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, height, value);
        params.setMargins(0, 0, 0, 0);
        return params;
    }

    private LinearLayout.LayoutParams fullWidth(int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, height);
        params.setMargins(left, top, right, bottom);
        return params;
    }

    private Button actionButton(String label, boolean primary, int color) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(13);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setGravity(Gravity.CENTER);
        button.setTextColor(primary ? Color.WHITE : color);
        button.setPadding(dp(8), 0, dp(8), 0);
        button.setSingleLine(true);
        button.setEllipsize(TextUtils.TruncateAt.END);
        button.setStateListAnimator(null);
        button.setElevation(0);
        button.setBackground(primary
                ? roundRect(color, 0, Color.TRANSPARENT, 0)
                : roundRect(color == DANGER ? DANGER_SOFT : SURFACE, 0,
                        color == DANGER ? DANGER : LINE, dp(1)));
        return button;
    }

    private TextView fieldLabel(String value) {
        TextView label = text(value, 13, MUTED);
        label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        label.setPadding(0, dp(13), 0, dp(4));
        return label;
    }

    private EditText input(String hint) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextSize(15);
        input.setSingleLine(true);
        input.setPadding(dp(11), 0, dp(11), 0);
        input.setBackground(roundRect(SURFACE, dp(14), LINE, dp(1)));
        input.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(48)));
        return input;
    }

    private Spinner spinner(String[] values) {
        Spinner spinner = new Spinner(this);
        spinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, values));
        spinner.setBackground(roundRect(SURFACE, dp(14), LINE, dp(1)));
        spinner.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(48)));
        return spinner;
    }

    private TextView text(String value, float size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.16f);
        return view;
    }

    private GradientDrawable roundRect(int color, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(0);
        if (strokeWidth > 0) drawable.setStroke(strokeWidth, strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private static String safe(Throwable error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    private static String safeText(String first, String fallback) {
        if (first != null && !first.trim().isEmpty()) return first;
        return fallback == null || fallback.trim().isEmpty() ? "상세 오류 없음" : fallback;
    }
}
