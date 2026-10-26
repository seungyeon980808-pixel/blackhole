package org.json;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** 호스트 시험용 최소 org.json. 파싱·직렬화는 Json 클래스가 맡는다. */
public class JSONObject {
    public static final Object NULL = new Object() { @Override public String toString() { return "null"; } };
    final Map<String,Object> map = new LinkedHashMap<>();

    public JSONObject() {}
    public JSONObject(String source) throws JSONException {
        Object value = new Json(source).value();
        if (!(value instanceof JSONObject)) throw new JSONException("not an object");
        map.putAll(((JSONObject) value).map);
    }
    public JSONObject put(String key, Object value) throws JSONException { map.put(key, value == null ? NULL : value); return this; }
    public JSONObject put(String key, long value) throws JSONException { map.put(key, value); return this; }
    public JSONObject put(String key, int value) throws JSONException { map.put(key, value); return this; }
    public JSONObject put(String key, boolean value) throws JSONException { map.put(key, value); return this; }
    public Object opt(String key) { return map.get(key); }
    public Object remove(String key) { return map.remove(key); }
    public boolean has(String key) { return map.containsKey(key); }
    public String optString(String key, String fallback) {
        Object value = map.get(key);
        return value == null || value == NULL ? fallback : String.valueOf(value);
    }
    public String optString(String key) { return optString(key, ""); }
    public boolean optBoolean(String key, boolean fallback) {
        Object value = map.get(key);
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof String) return "true".equalsIgnoreCase((String) value);
        return fallback;
    }
    public JSONArray optJSONArray(String key) { Object v = map.get(key); return v instanceof JSONArray ? (JSONArray) v : null; }
    public JSONObject optJSONObject(String key) { Object v = map.get(key); return v instanceof JSONObject ? (JSONObject) v : null; }
    public Iterator<String> keys() { return map.keySet().iterator(); }
    public int length() { return map.size(); }
    @Override public String toString() { return Json.write(this); }
}
