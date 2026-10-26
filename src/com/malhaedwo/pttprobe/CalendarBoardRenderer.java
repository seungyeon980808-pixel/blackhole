package com.malhaedwo.pttprobe;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.text.TextPaint;
import android.text.TextUtils;

import java.util.ArrayList;
import java.util.List;

/**
 * 홈 위젯·잠금화면 배경 그림(유리 테마 색). 내용은 BlackholeBoard가 정한다.
 * 위젯은 어두운 판(다크 모드)과 밝은 판(라이트 모드) 두 가지로 그리고, 줄마다 누를 자리(날짜)를 함께 돌려준다.
 */
final class CalendarBoardRenderer {
    /** 글자 색 묶음: 어두운 판 위 밝은 글자 / 밝은 판 위 어두운 글자. */
    static final class Palette {
        final int ink, ink2, ink3, hot, panel, edge;
        Palette(int ink, int ink2, int ink3, int hot, int panel, int edge) {
            this.ink = ink; this.ink2 = ink2; this.ink3 = ink3; this.hot = hot; this.panel = panel; this.edge = edge;
        }
        static final Palette DARK = new Palette(Color.argb(245, 244, 245, 251), Color.argb(180, 244, 245, 251),
                Color.argb(120, 244, 245, 251), Color.rgb(255, 107, 138), Color.rgb(13, 15, 32), Color.argb(70, 255, 255, 255));
        static final Palette LIGHT = new Palette(Color.argb(240, 18, 20, 38), Color.argb(175, 18, 20, 38),
                Color.argb(115, 18, 20, 38), Color.rgb(200, 30, 72), Color.rgb(246, 246, 251), Color.argb(40, 0, 0, 0));
    }

    /** 위젯에서 누를 자리 하나: 그림 안의 위·아래(픽셀)와 열 날짜. */
    static final class Hit {
        final float top, bottom;
        final String day;
        Hit(float top, float bottom, String day) { this.top = top; this.bottom = bottom; this.day = day; }
    }

    static final class Drawn {
        final Bitmap bitmap;
        final List<Hit> hits;
        Drawn(Bitmap bitmap, List<Hit> hits) { this.bitmap = bitmap; this.hits = hits; }
    }

    private static Palette pal = Palette.DARK;

    private CalendarBoardRenderer() {}

    /** 설정의 밝기(-50~50)·불투명도(0~150%). 기본 0·100이면 지금 모습 그대로. */
    static final class Look {
        final int bright;
        final int opacity;
        Look(int bright, int opacity) {
            this.bright = Math.max(-50, Math.min(50, bright));
            this.opacity = Math.max(0, Math.min(150, opacity));
        }
        static final Look DEFAULT = new Look(0, 100);
        int alpha(int base) { return Math.max(0, Math.min(255, Math.round(base * opacity / 100f))); }
        /** 밝게: 흰색 쪽으로, 어둡게: 검은색 쪽으로(최대 35%). */
        int tone(int rgb) {
            float k = Math.abs(bright) / 50f * 0.35f;
            int to = bright >= 0 ? 255 : 0;
            int r = Math.round(Color.red(rgb) + (to - Color.red(rgb)) * k);
            int g = Math.round(Color.green(rgb) + (to - Color.green(rgb)) * k);
            int b = Math.round(Color.blue(rgb) + (to - Color.blue(rgb)) * k);
            return Color.rgb(r, g, b);
        }
    }

    static Bitmap widget(BlackholeBoard.Board board, int width, int height, float density) {
        return widget(board, width, height, density, Look.DEFAULT);
    }

    static Bitmap widget(BlackholeBoard.Board board, int width, int height, float density, Look look) {
        return widget(board, width, height, density, look, true, 1f).bitmap;
    }

    /**
     * 위젯: 반투명 판(홈 화면 배경이 비침) 위에 오늘 일정, 이번 주, 마감 순 할 일.
     * dark = 다크 모드용(어두운 판), textScale = 휴대폰 글꼴 크기 설정(위젯 글자도 따라 커짐).
     */
    static synchronized Drawn widget(BlackholeBoard.Board board, int width, int height, float density, Look look, boolean dark, float textScale) {
        Palette p = dark ? Palette.DARK : Palette.LIGHT;
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint panel = new Paint(Paint.ANTI_ALIAS_FLAG);
        int base = look.tone(p.panel);
        panel.setColor(Color.argb(look.alpha(dark ? 150 : 175), Color.red(base), Color.green(base), Color.blue(base)));
        float r = 20 * density;
        canvas.drawRoundRect(new RectF(0, 0, width, height), r, r, panel);
        Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
        edge.setStyle(Paint.Style.STROKE);
        edge.setStrokeWidth(density);
        edge.setColor(p.edge);
        canvas.drawRoundRect(new RectF(density / 2, density / 2, width - density / 2, height - density / 2), r, r, edge);
        List<Hit> hits = new ArrayList<>();
        pal = p;
        try {
            content(canvas, board, 12 * density, 10 * density, width - 24 * density, height - 30 * density, density, Math.max(1f, Math.min(1.3f, textScale)), hits);
        } finally {
            pal = Palette.DARK;
        }
        return new Drawn(bitmap, hits);
    }

    /** 잠금화면 배경: 위쪽은 시계 자리로 비우고, 아래쪽 판에 오늘 일정·할 일을 크게. */
    static Bitmap lock(BlackholeBoard.Board board, int width, int height, float density) {
        return lock(board, width, height, density, Look.DEFAULT);
    }

    static synchronized Bitmap lock(BlackholeBoard.Board board, int width, int height, float density, Look look) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint wall = new Paint();
        wall.setShader(new LinearGradient(0, 0, width, height, look.tone(Color.rgb(26, 29, 58)), look.tone(Color.rgb(51, 32, 63)), Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, wall);
        Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
        glow.setShader(new RadialGradient(width * 0.2f, height * 0.25f, width * 0.8f, Color.argb(110, 124, 92, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, glow);
        glow.setShader(new RadialGradient(width * 0.9f, height * 0.75f, width * 0.8f, Color.argb(100, 15, 134, 166), Color.TRANSPARENT, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, glow);
        float top = height * 0.38f;
        Paint panel = new Paint(Paint.ANTI_ALIAS_FLAG);
        panel.setColor(Color.argb(look.alpha(95), 10, 10, 20));
        float r = 22 * density;
        canvas.drawRoundRect(new RectF(16 * density, top, width - 16 * density, height - 120 * density), r, r, panel);
        content(canvas, board, 30 * density, top + 14 * density, width - 60 * density, height - 120 * density - top - 28 * density, density, 1.25f, null);
        return bitmap;
    }

    private static void content(Canvas canvas, BlackholeBoard.Board board, float x, float y, float w, float h, float density, float scale,
                                List<Hit> hits) {
        TextPaint head = text(pal.ink, 13 * density * scale, true);
        TextPaint body = text(pal.ink, 14 * density * scale, false);
        TextPaint dim = text(pal.ink2, 12 * density * scale, false);
        TextPaint badge = text(pal.ink3, 12 * density * scale, true);
        float line = 21 * density * scale;
        float bottom = y + h;
        float cy = y + head.getTextSize();
        canvas.drawText(board.date + "  ·  블랙홀", x, cy, head);
        cy += line * 0.9f;
        for (String period : board.periods) {
            if (cy > bottom) return;
            canvas.drawText(ellipsize(period, dim, w), x, cy, dim);
            cy += line * 0.85f;
        }
        if (board.noCopy && board.empty()) {
            canvas.drawText(ellipsize("Mac 달력을 아직 받지 못했습니다", dim, w), x, cy + line * 0.3f, dim);
            return;
        }
        if (board.empty()) {
            canvas.drawText(ellipsize("오늘 일정과 할 일이 없습니다", dim, w), x, cy + line * 0.3f, dim);
            return;
        }
        for (BlackholeBoard.Line e : board.events) {
            if (cy > bottom) return;
            TextPaint p = e.past ? text(pal.ink3, body.getTextSize(), false) : body;
            canvas.drawText(e.time, x, cy, dim);
            float tx = x + 52 * density * scale;
            canvas.drawText(ellipsize(e.text + (e.provisional ? "  [가]" : ""), p, w - (tx - x)), tx, cy, p);
            hit(hits, cy, line, e.day);
            cy += line;
        }
        if (!board.tasks.isEmpty()) cy += line * 0.2f;
        int tasksDrawn = 0;
        for (BlackholeBoard.Line t : board.tasks) {
            // 이번 주 일정 자리도 남긴다(할 일이 많아도 두 줄은 이번 주).
            if (!board.week.isEmpty() && tasksDrawn >= 3 && cy + line * 2.6f > bottom) break;
            tasksDrawn++;
            if (cy > bottom) return;
            TextPaint p = t.past ? text(pal.ink3, body.getTextSize(), false) : body;
            float bw = t.badge.isEmpty() ? 0 : badge.measureText(t.badge) + 8 * density;
            canvas.drawText(ellipsize(t.time + " " + t.text, p, w - bw), x, cy, p);
            if (!t.badge.isEmpty()) {
                TextPaint b = t.badge.startsWith("오늘") || t.badge.endsWith("지남") ? text(pal.hot, badge.getTextSize(), true) : badge;
                canvas.drawText(t.badge, x + w - b.measureText(t.badge), cy, b);
            }
            hit(hits, cy, line, t.day);
            cy += line;
        }
        if (board.week.isEmpty()) return;
        cy += line * 0.2f;
        for (BlackholeBoard.Line e : board.week) {
            if (cy > bottom) return;
            canvas.drawText(e.time, x, cy, dim);
            float tx = x + 76 * density * scale;
            canvas.drawText(ellipsize(e.text + (e.provisional ? "  [가]" : ""), dim, w - (tx - x)), tx, cy, dim);
            hit(hits, cy, line * 0.9f, e.day);
            cy += line * 0.9f;
        }
    }

    /** 글자 기준선 cy의 한 줄(줄 간격 step)을 누를 자리로. */
    private static void hit(List<Hit> hits, float cy, float step, String day) {
        if (hits == null || day == null || day.isEmpty()) return;
        hits.add(new Hit(cy - step * 0.75f, cy + step * 0.25f, day));
    }

    private static TextPaint text(int color, float size, boolean bold) {
        TextPaint p = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(color);
        p.setTextSize(size);
        p.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        return p;
    }

    private static String ellipsize(String text, TextPaint paint, float width) {
        return TextUtils.ellipsize(text, paint, Math.max(10, width), TextUtils.TruncateAt.END).toString();
    }
}
