package ai.openidea.usages;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.lsp4j.Location;
import org.eclipse.lsp4j.Position;
import org.eclipse.lsp4j.Range;

/** Added to a temporary test bundle only; exercises the actual cache in a running JDT LS. */
public final class CacheProbe implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        String test = (String) arguments.get(0);
        Map<?, ?> done = (Map<?, ?>) field("DONE").get(null);
        synchronized (UsageCache.class) {
            done.clear();
            ((Map<?, ?>) field("SERVED_STALE").get(null)).clear();
        }
        if (test.equals("lru")) {
            for (String key : List.of("probe-A", "probe-B", "probe-C"))
                UsageCache.get(key, monitor, () -> rows(key));
            Job saver = (Job) field("SAVER").get(null);
            saver.cancel();
            saver.join();
            List<?> before;
            synchronized (UsageCache.class) { before = new ArrayList<>(done.keySet()); }
            Method write = UsageCache.class.getDeclaredMethod("write");
            write.setAccessible(true);
            write.invoke(null);
            List<?> after;
            synchronized (UsageCache.class) { after = new ArrayList<>(done.keySet()); }
            if (!before.equals(after)) throw new AssertionError("Persistence reordered LRU: " + before + " -> " + after);
            return Map.of("test", test, "entries", before.size(), "orderPreserved", true);
        }
        AtomicLong revision = (AtomicLong) field("REVISION").get(null);
        if (test.equals("owner")) {
            var answer = UsageCache.get("probe-owner", monitor, () -> {
                revision.incrementAndGet();
                return rows("outdated");
            });
            if (!answer.stale()) throw new AssertionError("A changed model's owner answer was marked fresh");
            return Map.of("test", test, "stale", true);
        }
        if (test.equals("shared")) {
            CountDownLatch started = new CountDownLatch(1), finish = new CountDownLatch(1);
            var owner = new FutureTask<>(() -> UsageCache.get("probe-shared", monitor, () -> {
                started.countDown();
                if (!finish.await(5, TimeUnit.SECONDS)) throw new AssertionError("Owner not released");
                return rows("outdated");
            }));
            new Thread(owner, "usages-cache-owner-test").start();
            if (!started.await(5, TimeUnit.SECONDS)) throw new AssertionError("Owner not started");
            revision.incrementAndGet();
            var waiter = new FutureTask<>(() -> UsageCache.get("probe-shared", monitor, () -> rows("current")));
            Thread thread = new Thread(waiter, "usages-cache-waiter-test");
            thread.start();
            try {
                long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                while (thread.getState() != Thread.State.TIMED_WAITING && !waiter.isDone() && System.nanoTime() < end)
                    Thread.sleep(1);
                finish.countDown();
                owner.get(5, TimeUnit.SECONDS);
                var answer = waiter.get(5, TimeUnit.SECONDS);
                if (answer.stale() || !answer.rows().get(0).get("text").equals("current"))
                    throw new AssertionError("Waiter reused an older model's in-flight answer");
                return Map.of("test", test, "freshSharedAnswer", true);
            } finally {
                finish.countDown();
            }
        }
        throw new IllegalArgumentException(test);
    }

    private static Field field(String name) throws Exception {
        Field field = UsageCache.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static List<Map<String, Object>> rows(String text) {
        return List.of(Map.of("location", new Location("file:///cache-probe/Source.java",
                new Range(new Position(0, 0), new Position(0, 1))), "kind", "unknown", "text", text));
    }
}
