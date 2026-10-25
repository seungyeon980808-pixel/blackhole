package org.json;

import java.util.Map;

/** 아주 작은 JSON 읽기·쓰기(시험 전용). */
final class Json {
    private final String s;
    private int i;

    Json(String source) { this.s = source == null ? "" : source; }

    Object value() {
        skip();
        if (i >= s.length()) throw new JSONException("empty");
        char c = s.charAt(i);
        if (c == '{') return object();
        if (c == '[') return array();
        if (c == '"') return string();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return JSONObject.NULL; }
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        String number = s.substring(start, i);
        if (number.isEmpty()) throw new JSONException("unexpected " + c);
        if (number.contains(".") || number.contains("e") || number.contains("E")) return Double.parseDouble(number);
        return Long.parseLong(number);
    }

    private JSONObject object() {
        JSONObject out = new JSONObject();
        i++;
        skip();
        if (s.charAt(i) == '}') { i++; return out; }
        while (true) {
            skip();
            String key = string();
            skip();
            expect(':');
            out.map.put(key, value());
            skip();
            if (s.charAt(i) == ',') { i++; continue; }
            expect('}');
            return out;
        }
    }

    private JSONArray array() {
        JSONArray out = new JSONArray();
        i++;
        skip();
        if (s.charAt(i) == ']') { i++; return out; }
        while (true) {
            out.list.add(value());
            skip();
            if (s.charAt(i) == ',') { i++; continue; }
            expect(']');
            return out;
        }
    }

    private String string() {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (true) {
            char c = s.charAt(i++);
            if (c == '"') return out.toString();
            if (c == '\\') {
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': out.append('\n'); break;
                    case 't': out.append('\t'); break;
                    case 'r': out.append('\r'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'u': out.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: out.append(e);
                }
            } else out.append(c);
        }
    }

    private void expect(char c) {
        if (i >= s.length() || s.charAt(i) != c) throw new JSONException("expected " + c + " at " + i);
        i++;
    }

    private void skip() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

    static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value) {
        if (value == null || value == JSONObject.NULL) out.append("null");
        else if (value instanceof JSONObject) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<String,Object> e : ((JSONObject) value).map.entrySet()) {
                if (!first) out.append(',');
                first = false;
                quote(out, e.getKey());
                out.append(':');
                write(out, e.getValue());
            }
            out.append('}');
        } else if (value instanceof JSONArray) {
            out.append('[');
            JSONArray array = (JSONArray) value;
            for (int k = 0; k < array.list.size(); k++) {
                if (k > 0) out.append(',');
                write(out, array.list.get(k));
            }
            out.append(']');
        } else if (value instanceof Number || value instanceof Boolean) out.append(value);
        else quote(out, String.valueOf(value));
    }

    private static void quote(StringBuilder out, String text) {
        out.append('"');
        for (int k = 0; k < text.length(); k++) {
            char c = text.charAt(k);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c == '\n') out.append("\\n");
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        out.append('"');
    }
}
