package android.view;
public abstract class ViewGroup extends View implements ViewParent { public ViewGroup(android.content.Context c) { super(c); }
  public void addView(View v) { throw new RuntimeException("stub"); } public void addView(View v, LayoutParams p) { throw new RuntimeException("stub"); } public void removeAllViews() { throw new RuntimeException("stub"); }
  public void setClipChildren(boolean b) { throw new RuntimeException("stub"); } public void setClipToPadding(boolean b) { throw new RuntimeException("stub"); }
  public static class LayoutParams { public static final int MATCH_PARENT=-1, WRAP_CONTENT=-2; public LayoutParams(int w, int h) {} }
  public static class MarginLayoutParams extends LayoutParams { public MarginLayoutParams(int w, int h) { super(w, h); } public void setMargins(int l, int t, int r, int b) { throw new RuntimeException("stub"); } } }
