package android.content;
import android.database.Cursor; import android.net.Uri; import java.io.InputStream;
public abstract class ContentResolver { public static final String SCHEME_CONTENT="content";
  public final String getType(Uri uri) { throw new RuntimeException("stub"); } public final InputStream openInputStream(Uri uri) throws java.io.FileNotFoundException { throw new RuntimeException("stub"); }
  public final Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) { throw new RuntimeException("stub"); } }
