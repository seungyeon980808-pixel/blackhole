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

/** 홈 위젯·잠금화면 배경 그림(유리 테마 색). 내용은 BlackholeBoard가 정한다. */
final class CalendarBoardRenderer {
    private static final int INK = Color.argb(245, 244, 245, 251);
    private static final int INK2 = Color.argb(180, 244, 245, 251);
    private static final int INK3 = Color.argb(120, 244, 245, 251);
    private static final int HOT = Color.rgb(255, 107, 138);

    private CalendarBoardRenderer() {}

    /** 위젯: 반투명 판(홈 화면 배경이 비침) 위에 오늘 일정과 할 일. */
    static Bitmap widget(BlackholeBoard.Board board, int width, int height, float density) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint panel = new Paint(Paint.ANTI_ALIAS_FLAG);
        panel.setColor(Color.argb(150, 13, 15, 32));
        float r = 20 * density;
        canvas.drawRoundRect(new RectF(0, 0, width, height), r, r, panel);
        Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
        edge.setStyle(Paint.Style.STROKE);
        edge.setStrokeWidth(density);
        edge.setColor(Color.argb(70, 255, 255, 255));
        canvas.drawRoundRect(new RectF(density / 2, density / 2, width - density / 2, height - density / 2), r, r, edge);
        content(canvas, board, 12 * density, 10 * density, width - 24 * density, height - 30 * density, density, 1f);
        return bitmap;
    }

    /** 잠금화면 배경: 위쪽은 시계 자리로 비우고, 아래쪽 판에 오늘 일정·할 일을 크게. */
    static Bitmap lock(BlackholeBoard.Board board, int width, int height, float density) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint wall = new Paint();
        wall.setShader(new LinearGradient(0, 0, width, height, Color.rgb(26, 29, 58), Color.rgb(51, 32, 63), Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, wall);
        Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
        glow.setShader(new RadialGradient(width * 0.2f, height * 0.25f, width * 0.8f, Color.argb(110, 124, 92, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, glow);
        glow.setShader(new RadialGradient(width * 0.9f, height * 0.75f, width * 0.8f, Color.argb(100, 15, 134, 166), Color.TRANSPARENT, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, glow);
        float top = height * 0.38f;
        Paint panel = new Paint(Paint.ANTI_ALIAS_FLAG);
        panel.setColor(Color.argb(95, 10, 10, 20));
        float r = 22 * density;
        canvas.drawRoundRect(new RectF(16 * density, top, width - 16 * density, height - 120 * density), r, r, panel);
        content(canvas, board, 30 * density, top + 14 * density, width - 60 * density, height - 120 * density - top - 28 * density, density, 1.25f);
        return bitmap;
    }

    private static void content(Canvas canvas, BlackholeBoard.Board board, float x, float y, float w, float h, float density, float scale) {
        TextPaint head = text(INK, 13 * density * scale, true);
        TextPaint body = text(INK, 14 * density * scale, false);
        TextPaint dim = text(INK2, 12 * density * scale, false);
        TextPaint badge = text(INK3, 12 * density * scale, true);
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
        if (board.empty()) {
            canvas.drawText("오늘 일정과 할 일이 없습니다", x, cy + line * 0.3f, dim);
            return;
        }
        for (BlackholeBoard.Line e : board.events) {
            if (cy > bottom) return;
            TextPaint p = e.past ? text(INK3, body.getTextSize(), false) : body;
            canvas.drawText(e.time, x, cy, dim);
            float tx = x + 52 * density * scale;
            canvas.drawText(ellipsize(e.text + (e.provisional ? "  [가]" : ""), p, w - (tx - x)), tx, cy, p);
            cy += line;
        }
        if (!board.tasks.isEmpty()) cy += line * 0.2f;
        for (BlackholeBoard.Line t : board.tasks) {
            if (cy > bottom) return;
            TextPaint p = t.past ? text(INK3, body.getTextSize(), false) : body;
            float bw = t.badge.isEmpty() ? 0 : badge.measureText(t.badge) + 8 * density;
            canvas.drawText(ellipsize(t.time + " " + t.text, p, w - bw), x, cy, p);
            if (!t.badge.isEmpty()) {
                TextPaint b = t.badge.startsWith("오늘") || t.badge.endsWith("지남") ? text(HOT, badge.getTextSize(), true) : badge;
                canvas.drawText(t.badge, x + w - b.measureText(t.badge), cy, b);
            }
            cy += line;
        }
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
