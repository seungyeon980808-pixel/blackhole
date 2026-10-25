package org.json;

import java.util.ArrayList;
import java.util.List;

public class JSONArray {
    final List<Object> list = new ArrayList<>();

    public JSONArray() {}
    public JSONArray(String source) throws JSONException {
        Object value = new Json(source).value();
        if (!(value instanceof JSONArray)) throw new JSONException("not an array");
        list.addAll(((JSONArray) value).list);
    }
    public JSONArray put(Object value) { list.add(value == null ? JSONObject.NULL : value); return this; }
    public JSONArray put(int index, Object value) throws JSONException {
        while (list.size() <= index) list.add(JSONObject.NULL);
        list.set(index, value == null ? JSONObject.NULL : value);
        return this;
    }
    public int length() { return list.size(); }
    public Object opt(int index) { return index >= 0 && index < list.size() ? list.get(index) : null; }
    public JSONObject optJSONObject(int index) { Object v = opt(index); return v instanceof JSONObject ? (JSONObject) v : null; }
    public JSONArray optJSONArray(int index) { Object v = opt(index); return v instanceof JSONArray ? (JSONArray) v : null; }
    public String optString(int index, String fallback) { Object v = opt(index); return v == null || v == JSONObject.NULL ? fallback : String.valueOf(v); }
    @Override public String toString() { return Json.write(this); }
}
