package android.net;
public abstract class Uri implements android.os.Parcelable { public static Uri parse(String s) { throw new RuntimeException("stub"); } public static String encode(String s) { throw new RuntimeException("stub"); }
  public abstract String getLastPathSegment(); public abstract String getScheme(); public abstract String getAuthority(); }
