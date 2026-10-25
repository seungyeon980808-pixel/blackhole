package android.content;
import android.database.Cursor; import android.net.Uri; import android.os.ParcelFileDescriptor;
public abstract class ContentProvider { public final Context getContext() { throw new RuntimeException("stub"); } public abstract boolean onCreate();
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException { throw new RuntimeException("stub"); }
  public abstract String getType(Uri uri); public abstract Cursor query(Uri uri, String[] p, String s, String[] a, String o);
  public abstract Uri insert(Uri uri, ContentValues v); public abstract int delete(Uri uri, String s, String[] a);
  public abstract int update(Uri uri, ContentValues v, String s, String[] a); }
