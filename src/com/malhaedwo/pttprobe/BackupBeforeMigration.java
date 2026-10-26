package com.malhaedwo.pttprobe;

import android.content.Context;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;

/** Creates and verifies immutable DB-only snapshots before the first database open. */
final class BackupBeforeMigration {
    static final String BACKUP_ROOT = "migration-backup";
    static final String SNAPSHOT_NAME = "before-v5";
    static final String RELEASE_SNAPSHOT_NAME = "before-app-0.11.10";
    static final String MANIFEST_NAME = "manifest.properties";

    private static final String DB_NAME = "malhaedwo.db";
    private static final String STATE_SNAPSHOT = "SNAPSHOT";
    private static final String STATE_NO_DATABASE = "NO_DATABASE";
    private static final String[] SUFFIXES = {"", "-wal", "-shm", "-journal"};
    private static final int BUFFER_SIZE = 64 * 1024;

    private BackupBeforeMigration() {}

    static void ensure(Context context) {
        ensureSnapshot(context, SNAPSHOT_NAME);
    }

    /** A separate immutable snapshot of the DB present when this release first opens it. */
    static void ensureCurrentRelease(Context context) {
        ensureSnapshot(context, RELEASE_SNAPSHOT_NAME);
    }

    private static void ensureSnapshot(Context context, String snapshotName) {
        try {
            ensureChecked(context, snapshotName);
        } catch (Exception e) {
            if (e instanceof BackupException) throw (BackupException) e;
            throw new BackupException("Database migration backup failed; database was not opened", e);
        }
    }

    private static void ensureChecked(Context context, String snapshotName) throws IOException {
        if (context == null) throw new BackupException("Database migration backup failed: Context is null");
        File filesDir = requireDirectory(context.getFilesDir(), "private files directory");
        File privateParent = child(filesDir, BACKUP_ROOT);
        File privateFinal = child(privateParent, snapshotName);

        Snapshot privateSnapshot;
        if (privateFinal.exists()) {
            privateSnapshot = verifySnapshot(privateFinal);
        } else {
            File database = context.getDatabasePath(DB_NAME);
            if (database == null) throw new BackupException("Database migration backup failed: database path is unavailable");
            List<File> sources = sourceFiles(database);
            if (sources.isEmpty()) {
                publishNoDatabaseMarker(privateParent, privateFinal);
                return;
            }
            privateSnapshot = publishSnapshot(sources, privateParent, privateFinal);
        }

        if (STATE_NO_DATABASE.equals(privateSnapshot.state)) return;

        File externalFiles = context.getExternalFilesDir(null);
        if (externalFiles == null) {
            throw new BackupException("Database migration backup failed: app-specific external files directory is unavailable");
        }
        externalFiles = requireDirectory(externalFiles, "app-specific external files directory");
        File externalParent = child(externalFiles, BACKUP_ROOT);
        File externalFinal = child(externalParent, snapshotName);
        if (externalFinal.exists()) {
            Snapshot externalSnapshot = verifySnapshot(externalFinal);
            requireMatchingManifests(privateSnapshot, externalSnapshot);
        } else {
            Snapshot externalSnapshot = publishSnapshotFromPrivate(privateSnapshot, externalParent, externalFinal);
            requireMatchingManifests(privateSnapshot, externalSnapshot);
        }
    }

    private static List<File> sourceFiles(File database) throws IOException {
        List<File> sources = new ArrayList<>();
        boolean mainExists = database.exists();
        for (String suffix : SUFFIXES) {
            File candidate = suffix.isEmpty() ? database : new File(database.getPath() + suffix);
            if (!candidate.exists()) continue;
            if (!candidate.isFile() || Files.isSymbolicLink(candidate.toPath())) {
                throw new BackupException("Database migration backup failed: source is not a regular file: " + candidate.getName());
            }
            if (!mainExists) {
                throw new BackupException("Database migration backup failed: SQLite sidecar exists without main database: " + candidate.getName());
            }
            sources.add(candidate);
        }
        return sources;
    }

    private static Snapshot publishSnapshot(List<File> sources, File parent, File destination) throws IOException {
        File temp = prepareTemp(parent, destination);
        List<Entry> entries = new ArrayList<>();
        for (File source : sources) {
            File target = child(temp, source.getName());
            Entry copied = copyAndVerify(source, target);
            String sourceHashAfterCopy = sha256(source);
            if (source.length() != copied.size || !sourceHashAfterCopy.equals(copied.sha256)) {
                throw new BackupException("Database migration backup failed: source changed while copying: " + source.getName());
            }
            entries.add(copied);
        }
        List<File> after = sourceFiles(sources.get(0));
        if (!sameNames(sources, after)) {
            throw new BackupException("Database migration backup failed: SQLite sidecar set changed while copying");
        }
        byte[] manifest = manifestBytes(STATE_SNAPSHOT, entries);
        writeAndSync(child(temp, MANIFEST_NAME), manifest);
        Snapshot staged = verifySnapshot(temp);
        publishAtomically(temp, destination);
        Snapshot completed = verifySnapshot(destination);
        requireMatchingManifests(staged, completed);
        return completed;
    }

    private static Snapshot publishSnapshotFromPrivate(Snapshot source, File parent, File destination) throws IOException {
        File temp = prepareTemp(parent, destination);
        for (Entry entry : source.entries) {
            Entry copied = copyAndVerify(child(source.directory, entry.name), child(temp, entry.name));
            if (copied.size != entry.size || !copied.sha256.equals(entry.sha256)) {
                throw new BackupException("Database migration backup failed: external copy mismatch: " + entry.name);
            }
        }
        writeAndSync(child(temp, MANIFEST_NAME), source.manifestBytes);
        Snapshot staged = verifySnapshot(temp);
        requireMatchingManifests(source, staged);
        publishAtomically(temp, destination);
        Snapshot completed = verifySnapshot(destination);
        requireMatchingManifests(source, completed);
        return completed;
    }

    private static void publishNoDatabaseMarker(File parent, File destination) throws IOException {
        File temp = prepareTemp(parent, destination);
        writeAndSync(child(temp, MANIFEST_NAME), manifestBytes(STATE_NO_DATABASE, new ArrayList<>()));
        Snapshot staged = verifySnapshot(temp);
        publishAtomically(temp, destination);
        Snapshot completed = verifySnapshot(destination);
        requireMatchingManifests(staged, completed);
    }

    private static File prepareTemp(File parent, File destination) throws IOException {
        requireDirectory(parent, "backup parent directory");
        if (destination.exists()) {
            throw new BackupException("Database migration backup failed: completed snapshot appeared concurrently");
        }
        File temp = child(parent, "." + destination.getName() + ".tmp");
        if (temp.exists()) deleteTemporaryTree(temp);
        if (!temp.mkdir()) throw new BackupException("Database migration backup failed: cannot create temporary snapshot directory");
        return temp;
    }

    private static Entry copyAndVerify(File source, File target) throws IOException {
        MessageDigest digest = newDigest();
        long count = 0;
        byte[] buffer = new byte[BUFFER_SIZE];
        try (InputStream in = new BufferedInputStream(new FileInputStream(source));
             FileOutputStream rawOut = new FileOutputStream(target);
             BufferedOutputStream out = new BufferedOutputStream(rawOut)) {
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                digest.update(buffer, 0, read);
                count += read;
            }
            out.flush();
            rawOut.getFD().sync();
        }
        String copiedHash = hex(digest.digest());
        if (target.length() != count || !copiedHash.equals(sha256(target))) {
            throw new BackupException("Database migration backup failed: copied file verification mismatch: " + source.getName());
        }
        return new Entry(source.getName(), count, copiedHash);
    }

    private static Snapshot verifySnapshot(File directory) throws IOException {
        if (!directory.isDirectory() || Files.isSymbolicLink(directory.toPath())) {
            throw new BackupException("Database migration backup failed: snapshot is not a regular directory: " + directory.getPath());
        }
        File manifestFile = child(directory, MANIFEST_NAME);
        if (!manifestFile.isFile() || Files.isSymbolicLink(manifestFile.toPath())) {
            throw new BackupException("Database migration backup failed: snapshot manifest is missing");
        }
        byte[] manifestBytes = Files.readAllBytes(manifestFile.toPath());
        Properties properties = new Properties();
        try (InputStream input = new FileInputStream(manifestFile)) {
            properties.load(input);
        }
        if (!"1".equals(properties.getProperty("format"))) {
            throw new BackupException("Database migration backup failed: unsupported snapshot manifest format");
        }
        String state = properties.getProperty("state");
        int count = parseCount(properties.getProperty("fileCount"));
        if (STATE_NO_DATABASE.equals(state)) {
            if (count != 0) throw new BackupException("Database migration backup failed: invalid no-database marker");
            return new Snapshot(directory, state, new ArrayList<>(), manifestBytes);
        }
        if (!STATE_SNAPSHOT.equals(state) || count < 1 || count > SUFFIXES.length) {
            throw new BackupException("Database migration backup failed: invalid snapshot manifest state");
        }
        List<Entry> entries = new ArrayList<>();
        Set<String> names = new HashSet<>();
        for (int i = 0; i < count; i++) {
            String prefix = "file." + i + ".";
            String name = properties.getProperty(prefix + "name");
            if (!allowedName(name) || !names.add(name)) {
                throw new BackupException("Database migration backup failed: invalid snapshot file name");
            }
            long size = parseSize(properties.getProperty(prefix + "size"));
            String expectedHash = properties.getProperty(prefix + "sha256");
            if (expectedHash == null || !expectedHash.matches("[0-9a-f]{64}")) {
                throw new BackupException("Database migration backup failed: invalid snapshot hash for " + name);
            }
            File stored = child(directory, name);
            if (!stored.isFile() || Files.isSymbolicLink(stored.toPath()) || stored.length() != size || !expectedHash.equals(sha256(stored))) {
                throw new BackupException("Database migration backup failed: stored snapshot verification mismatch: " + name);
            }
            entries.add(new Entry(name, size, expectedHash));
        }
        if (!DB_NAME.equals(entries.get(0).name)) {
            throw new BackupException("Database migration backup failed: main database is not first in snapshot manifest");
        }
        return new Snapshot(directory, state, entries, manifestBytes);
    }

    private static byte[] manifestBytes(String state, List<Entry> entries) {
        StringBuilder value = new StringBuilder();
        value.append("format=1\n");
        value.append("state=").append(state).append('\n');
        value.append("fileCount=").append(entries.size()).append('\n');
        for (int i = 0; i < entries.size(); i++) {
            Entry entry = entries.get(i);
            value.append("file.").append(i).append(".name=").append(entry.name).append('\n');
            value.append("file.").append(i).append(".size=").append(entry.size).append('\n');
            value.append("file.").append(i).append(".sha256=").append(entry.sha256).append('\n');
        }
        return value.toString().getBytes(StandardCharsets.US_ASCII);
    }

    private static void writeAndSync(File file, byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
            output.flush();
            output.getFD().sync();
        }
    }

    private static void publishAtomically(File temp, File destination) throws IOException {
        try {
            Files.move(temp.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            throw new BackupException("Database migration backup failed: filesystem does not support atomic snapshot completion", e);
        }
    }

    private static void requireMatchingManifests(Snapshot expected, Snapshot actual) {
        if (!Arrays.equals(expected.manifestBytes, actual.manifestBytes)) {
            throw new BackupException("Database migration backup failed: private and app-specific external manifests differ");
        }
    }

    private static File requireDirectory(File directory, String label) {
        if (directory == null) throw new BackupException("Database migration backup failed: " + label + " is unavailable");
        if (directory.exists()) {
            if (!directory.isDirectory() || Files.isSymbolicLink(directory.toPath())) {
                throw new BackupException("Database migration backup failed: " + label + " is not a regular directory");
            }
        } else if (!directory.mkdirs()) {
            throw new BackupException("Database migration backup failed: cannot create " + label);
        }
        if (!directory.canRead() || !directory.canWrite()) {
            throw new BackupException("Database migration backup failed: cannot access " + label);
        }
        return directory;
    }

    private static File child(File parent, String name) throws IOException {
        File child = new File(parent, name);
        String parentPath = parent.getCanonicalPath();
        String childPath = child.getCanonicalPath();
        if (!childPath.startsWith(parentPath + File.separator)) {
            throw new BackupException("Database migration backup failed: unsafe snapshot path");
        }
        return child;
    }

    private static void deleteTemporaryTree(File file) throws IOException {
        if (Files.isSymbolicLink(file.toPath())) {
            if (!file.delete()) throw new BackupException("Database migration backup failed: cannot remove stale temporary link");
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new BackupException("Database migration backup failed: cannot inspect stale temporary snapshot");
            for (File child : children) deleteTemporaryTree(child);
        }
        if (!file.delete()) throw new BackupException("Database migration backup failed: cannot remove stale temporary snapshot");
    }

    private static boolean sameNames(List<File> before, List<File> after) {
        if (before.size() != after.size()) return false;
        for (int i = 0; i < before.size(); i++) {
            if (!before.get(i).getName().equals(after.get(i).getName())) return false;
        }
        return true;
    }

    private static boolean allowedName(String name) {
        if (name == null) return false;
        for (String suffix : SUFFIXES) if ((DB_NAME + suffix).equals(name)) return true;
        return false;
    }

    private static int parseCount(String value) {
        try {
            return Integer.parseInt(value);
        } catch (Exception e) {
            throw new BackupException("Database migration backup failed: invalid snapshot file count", e);
        }
    }

    private static long parseSize(String value) {
        try {
            long size = Long.parseLong(value);
            if (size < 0) throw new NumberFormatException("negative");
            return size;
        } catch (Exception e) {
            throw new BackupException("Database migration backup failed: invalid snapshot file size", e);
        }
    }

    private static String sha256(File file) throws IOException {
        MessageDigest digest = newDigest();
        byte[] buffer = new byte[BUFFER_SIZE];
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return hex(digest.digest());
    }

    private static MessageDigest newDigest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new AssertionError(e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) value.append(String.format(Locale.US, "%02x", b & 0xff));
        return value.toString();
    }

    static final class BackupException extends IllegalStateException {
        BackupException(String message) { super(message); }
        BackupException(String message, Throwable cause) { super(message, cause); }
    }

    private static final class Entry {
        final String name;
        final long size;
        final String sha256;

        Entry(String name, long size, String sha256) {
            this.name = name;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    private static final class Snapshot {
        final File directory;
        final String state;
        final List<Entry> entries;
        final byte[] manifestBytes;

        Snapshot(File directory, String state, List<Entry> entries, byte[] manifestBytes) {
            this.directory = directory;
            this.state = state;
            this.entries = entries;
            this.manifestBytes = manifestBytes;
        }
    }
}
