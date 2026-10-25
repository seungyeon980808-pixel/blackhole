package android.media;
public class AudioRecord { public static final int STATE_INITIALIZED=1, RECORDSTATE_RECORDING=3;
  public AudioRecord(int source, int rate, int channel, int encoding, int size) {} public static int getMinBufferSize(int r, int c, int e) { throw new RuntimeException("stub"); }
  public int getState() { throw new RuntimeException("stub"); } public void startRecording() { throw new RuntimeException("stub"); } public int getRecordingState() { throw new RuntimeException("stub"); } public int read(short[] b, int o, int n) { throw new RuntimeException("stub"); }
  public int read(byte[] b, int o, int n) { throw new RuntimeException("stub"); } public void stop() { throw new RuntimeException("stub"); } public void release() { throw new RuntimeException("stub"); } }
