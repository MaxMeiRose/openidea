package ai.openidea.usages;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IResourceChangeEvent;
import org.eclipse.core.resources.IResourceDelta;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.core.runtime.Status;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jdt.core.ElementChangedEvent;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IJavaElementDelta;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.managers.ProjectsManager;
import org.eclipse.lsp4j.Location;
import org.eclipse.lsp4j.Position;
import org.eclipse.lsp4j.Range;

/**
 * Answers of `openidea.java.usages` by search targets, kept until the sources they cover change.
 *
 * A Java element change does not discard the answers: the last one is returned at once marked
 * {@code stale}, and the request that follows it searches again, so a click never waits for a
 * search whose answer the client has already shown. Answers are also kept on disk, so a click
 * after a language-server restart shows them the same way while they are searched again.
 */
final class UsageCache {
    private static final int MAX_ENTRIES = 96, MAX_ROWS = 200_000;
    /** Persisted answers: a working session, bounded so the file stays small. */
    private static final int MAX_STORED_ANSWERS = 24, MAX_STORED_ROWS = 20_000, MAX_STORED_BYTES = 8 << 20;
    private static final int FORMAT = 1;
    /** Opening or closing an editor's working copy and AST-only reconciles change no usage. */
    private static final int IGNORED_FLAGS = IJavaElementDelta.F_CHILDREN | IJavaElementDelta.F_PRIMARY_WORKING_COPY
            | IJavaElementDelta.F_AST_AFFECTED | IJavaElementDelta.F_FINE_GRAINED;
    private static final AtomicLong REVISION = new AtomicLong();
    /** Rows of a search, by the revision of the Java model they were searched in. */
    private record Entry(long revision, List<Map<String, Object>> rows) {}
    private static final Map<String, Entry> DONE = new LinkedHashMap<>(16, 0.75f, true);
    private static final Map<String, CompletableFuture<Entry>> RUNNING = new HashMap<>();
    /** The revision whose stale answer a key has already shown: the next request searches. */
    private static final Map<String, Long> SERVED_STALE = new HashMap<>();

    static {
        JavaCore.addElementChangedListener(event -> {
            if (affects(event.getDelta())) REVISION.incrementAndGet();
        }, ElementChangedEvent.POST_CHANGE | ElementChangedEvent.POST_RECONCILE);
        // Saved whitespace can move usages without a semantic Java-element delta.
        ResourcesPlugin.getWorkspace().addResourceChangeListener(event -> {
            if (sourceChanged(event.getDelta())) REVISION.incrementAndGet();
        }, IResourceChangeEvent.POST_CHANGE);
    }

    private UsageCache() {}

    interface Search {
        List<Map<String, Object>> run() throws Exception;
    }

    /** Rows of a search, and whether a changed Java model can have made them outdated. */
    record Answer(List<Map<String, Object>> rows, boolean stale) {}

    private static boolean sourceChanged(IResourceDelta delta) {
        if (delta == null) return false;
        if (delta.getResource() instanceof IFile file && ("java".equals(file.getFileExtension()) || "kt".equals(file.getFileExtension()))) {
            if (ProjectsManager.getDefaultProject().equals(file.getProject())) return false;
            if (delta.getKind() != IResourceDelta.CHANGED || (delta.getFlags() & (IResourceDelta.CONTENT | IResourceDelta.REPLACED)) != 0)
                return true;
        }
        for (IResourceDelta child : delta.getAffectedChildren()) if (sourceChanged(child)) return true;
        return false;
    }

    static boolean affects(IJavaElementDelta delta) {
        // Decompiled library classes open as private working copies; searches never see them.
        if (delta.getElement() instanceof ICompilationUnit unit && unit.getOwner() != null) return false;
        // Files outside the source folders (opened to widen a search) join the default project
        // while open: they are part of the key instead (`openContents`).
        IJavaProject project = delta.getElement().getJavaProject();
        if (project != null && standalone(project)) return false;
        int flags = delta.getFlags() & ~IGNORED_FLAGS;
        if (delta.getElement().getElementType() < IJavaElement.COMPILATION_UNIT) flags &= ~IJavaElementDelta.F_CONTENT;
        if (delta.getKind() != IJavaElementDelta.CHANGED || flags != 0) return true;
        for (IJavaElementDelta child : delta.getAffectedChildren()) if (affects(child)) return true;
        return false;
    }

    static Answer get(String targets, IProgressMonitor monitor, Search search) throws Exception {
        load();
        // Searches read unsaved editor contents, which change before the reconcile that reports them.
        while (true) {
            if (monitor.isCanceled()) throw new OperationCanceledException();
            String key = targets + '|' + openContents(monitor);
            long revision = REVISION.get();
            CompletableFuture<Entry> running;
            boolean owner = false;
            synchronized (UsageCache.class) {
                Entry done = DONE.get(key);
                if (done != null && done.revision == revision) return new Answer(done.rows, false);
                running = RUNNING.get(key);
                if (running == null && done != null && !Long.valueOf(revision).equals(SERVED_STALE.get(key))) {
                    // Shown at once; the request that follows this answer searches the change.
                    if (SERVED_STALE.size() > MAX_ENTRIES * 4) SERVED_STALE.clear();
                    SERVED_STALE.put(key, revision);
                    return new Answer(done.rows, true);
                }
                if (running == null) {
                    running = new CompletableFuture<>();
                    RUNNING.put(key, running);
                    owner = true;
                }
            }
            if (owner) {
                Entry answer = search(targets, key, revision, running, search, monitor);
                return new Answer(answer.rows, answer.revision != REVISION.get());
            }
            // The same targets are searched for another request: its answer, or a new search
            // when that one was cancelled, failed or saw a change.
            while (true) {
                if (monitor.isCanceled()) throw new OperationCanceledException();
                try {
                    Entry answer = running.get(50, TimeUnit.MILLISECONDS);
                    if (answer.revision == REVISION.get() && key.equals(targets + '|' + openContents(monitor)))
                        return new Answer(answer.rows, false);
                    break;
                } catch (TimeoutException e) {
                    continue;
                } catch (ExecutionException e) {
                    break;
                }
            }
        }
    }

    private static boolean standalone(IJavaProject project) {
        return ProjectsManager.getDefaultProject().equals(project.getProject());
    }

    /** A digest of the editors' unsaved contents and of the open files outside the source
     * folders: merely opening or closing a file of the sources keeps it. */
    private static String openContents(IProgressMonitor monitor) throws Exception {
        Map<String, ICompilationUnit> copies = new TreeMap<>();
        for (ICompilationUnit copy : JavaCore.getWorkingCopies(null)) copies.put(copy.getPrimary().getHandleIdentifier(), copy);
        for (ICompilationUnit copy : JavaCore.getWorkingCopies(JavaLanguageServerPlugin.getInstance().getWorkingCopyOwner()))
            copies.put(copy.getPrimary().getHandleIdentifier(), copy);
        var digest = MessageDigest.getInstance("SHA-256");
        for (var entry : copies.entrySet()) {
            if (monitor.isCanceled()) throw new OperationCanceledException();
            ICompilationUnit copy = entry.getValue();
            if (!copy.hasUnsavedChanges() && !standalone(copy.getJavaProject())) continue;
            digest.update(entry.getKey().getBytes(StandardCharsets.UTF_8));
            String source = entry.getValue().getSource();
            if (source != null) digest.update(source.getBytes(StandardCharsets.UTF_8));
        }
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private static Entry search(String targets, String key, long revision,
            CompletableFuture<Entry> running, Search search, IProgressMonitor monitor) throws Exception {
        List<Map<String, Object>> rows;
        boolean current;
        try {
            rows = List.copyOf(search.run());
            if (monitor.isCanceled()) throw new OperationCanceledException();
            current = REVISION.get() == revision && key.equals(targets + '|' + openContents(monitor));
        } catch (Throwable e) {
            synchronized (UsageCache.class) { RUNNING.remove(key); }
            running.completeExceptionally(e);
            throw e;
        }
        Entry answer = new Entry(current ? revision : -1, rows);
        synchronized (UsageCache.class) {
            RUNNING.remove(key);
            if (current && REVISION.get() == revision && rows.size() <= MAX_ROWS) remember(key, answer);
        }
        running.complete(answer);
        return answer;
    }

    private static void remember(String key, Entry entry) {
        DONE.put(key, entry);
        SERVED_STALE.remove(key);
        int rows = DONE.values().stream().mapToInt(e -> e.rows.size()).sum();
        // Least recently used first; `get` on this access-ordered map would reorder it.
        var oldest = DONE.entrySet().iterator();
        while ((DONE.size() > MAX_ENTRIES || rows > MAX_ROWS) && oldest.hasNext()) {
            var evicted = oldest.next();
            if (evicted.getKey().equals(key)) continue;
            rows -= evicted.getValue().rows.size();
            oldest.remove();
        }
        saveLater();
    }

    // ---- answers kept across language-server restarts ----

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final AtomicBoolean DIRTY = new AtomicBoolean();
    private static boolean loaded;
    private static final Job SAVER = new Job("Saving Java usages answers") {
        @Override
        protected IStatus run(IProgressMonitor monitor) {
            if (DIRTY.getAndSet(false)) write();
            return Status.OK_STATUS;
        }
    };
    static {
        SAVER.setSystem(true);
        SAVER.setPriority(Job.DECORATE);
    }

    /** Answers stored by an earlier language-server run; each is shown as stale once, then searched. */
    private static synchronized void load() {
        if (loaded) return;
        loaded = true;
        Path path = storePath();
        if (path == null || !Files.isRegularFile(path)) return;
        try {
            if (Files.size(path) > MAX_STORED_BYTES) return;
            Stored stored = GSON.fromJson(Files.readString(path, StandardCharsets.UTF_8), Stored.class);
            if (stored == null || stored.format != FORMAT || stored.answers == null) return;
            synchronized (UsageCache.class) {
                // The file is newest first; restore the map's oldest-first access order.
                for (int i = stored.answers.size() - 1; i >= 0; i--) {
                    StoredAnswer answer = stored.answers.get(i);
                    if (answer == null || answer.key == null || answer.rows == null || answer.rows.isEmpty()) continue;
                    List<Map<String, Object>> rows = new ArrayList<>();
                    for (StoredRow row : answer.rows) {
                        Map<String, Object> built = row == null ? null : row.toRow();
                        if (built != null) rows.add(built);
                    }
                    if (rows.isEmpty() || rows.size() > MAX_ROWS) continue;
                    // A revision no model has: the first request for it shows the rows and searches.
                    DONE.put(answer.key, new Entry(-1, List.copyOf(rows)));
                }
            }
        } catch (Exception e) {
            JavaLanguageServerPlugin.logInfo("Java usages answers not restored: " + e);
        }
    }

    private static void saveLater() {
        if (!loaded) return;
        DIRTY.set(true);
        SAVER.schedule(1500);
    }

    /** Rewrites the file with the most recently used answers, newest first; bounded in size. */
    private static void write() {
        Path path = storePath();
        if (path == null) return;
        Stored stored = new Stored();
        stored.format = FORMAT;
        stored.answers = new ArrayList<>();
        int rows = 0;
        List<Map.Entry<String, Entry>> answers;
        synchronized (UsageCache.class) {
            answers = DONE.entrySet().stream().map(e -> Map.entry(e.getKey(), e.getValue())).toList();
        }
        for (int i = answers.size() - 1; i >= 0; i--) {
            if (stored.answers.size() >= MAX_STORED_ANSWERS || rows >= MAX_STORED_ROWS) break;
            String key = answers.get(i).getKey();
            Entry entry = answers.get(i).getValue();
            if (entry == null || entry.rows.isEmpty() || entry.rows.size() > MAX_STORED_ROWS - rows) continue;
            StoredAnswer answer = new StoredAnswer();
            answer.key = key;
            answer.rows = new ArrayList<>();
            for (Map<String, Object> row : entry.rows) {
                StoredRow item = StoredRow.of(row);
                if (item != null) answer.rows.add(item);
            }
            if (answer.rows.isEmpty()) continue;
            rows += answer.rows.size();
            stored.answers.add(answer);
        }
        if (stored.answers.isEmpty()) return;
        try {
            String json = GSON.toJson(stored);
            if (json.getBytes(StandardCharsets.UTF_8).length > MAX_STORED_BYTES) return;
            Files.createDirectories(path.getParent());
            Path temporary = path.resolveSibling(path.getFileName() + ".tmp");
            Files.writeString(temporary, json, StandardCharsets.UTF_8);
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            JavaLanguageServerPlugin.logInfo("Java usages answers not saved: " + e);
        }
    }

    /** The language server's workspace metadata directory; null before the workspace exists. */
    private static Path storePath() {
        try {
            var location = ResourcesPlugin.getWorkspace().getRoot().getLocation();
            if (location == null) return null;
            return location.toFile().toPath().resolve(".metadata").resolve("openidea-usages-answers.json");
        } catch (Exception e) {
            return null;
        }
    }

    /** The stored shape is explicit, so a reloaded answer keeps the protocol's types. */
    private static final class Stored {
        int format;
        List<StoredAnswer> answers;
    }

    private static final class StoredAnswer {
        String key;
        List<StoredRow> rows;
    }

    private static final class StoredRow {
        String uri;
        int startLine, startCharacter, endLine, endCharacter;
        String kind, access, text;

        static StoredRow of(Map<String, Object> row) {
            if (!(row.get("location") instanceof Location location) || location.getRange() == null) return null;
            StoredRow stored = new StoredRow();
            stored.uri = location.getUri();
            stored.startLine = location.getRange().getStart().getLine();
            stored.startCharacter = location.getRange().getStart().getCharacter();
            stored.endLine = location.getRange().getEnd().getLine();
            stored.endCharacter = location.getRange().getEnd().getCharacter();
            stored.kind = row.get("kind") instanceof String kind ? kind : "unknown";
            stored.access = row.get("access") instanceof String access ? access : null;
            stored.text = row.get("text") instanceof String text ? text : null;
            return stored;
        }

        Map<String, Object> toRow() {
            if (uri == null) return null;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("location", new Location(uri,
                    new Range(new Position(startLine, startCharacter), new Position(endLine, endCharacter))));
            row.put("kind", kind == null ? "unknown" : kind);
            if (access != null) row.put("access", access);
            if (text != null) row.put("text", text);
            return row;
        }
    }
}
