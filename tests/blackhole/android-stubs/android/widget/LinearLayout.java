package android.widget;
public class LinearLayout extends android.view.ViewGroup { public static final int HORIZONTAL=0, VERTICAL=1;
  public LinearLayout(android.content.Context c) { super(c); } public void setOrientation(int o) { throw new RuntimeException("stub"); } public void setGravity(int g) { throw new RuntimeException("stub"); }
  public static class LayoutParams extends android.view.ViewGroup.MarginLayoutParams { public LayoutParams(int w, int h) { super(w, h); } public LayoutParams(int w, int h, float weight) { super(w, h); } } }
