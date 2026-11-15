package localreviews;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.diff.DiffContext;
import com.intellij.diff.DiffExtension;
import com.intellij.diff.FrameDiffTool;
import com.intellij.diff.contents.DocumentContent;
import com.intellij.diff.requests.ContentDiffRequest;
import com.intellij.diff.requests.DiffRequest;
import com.intellij.diff.tools.fragmented.UnifiedDiffViewer;
import com.intellij.diff.tools.util.base.DiffViewerListener;
import com.intellij.diff.tools.util.side.OnesideTextDiffViewer;
import com.intellij.diff.tools.util.side.TwosideTextDiffViewer;
import com.intellij.diff.util.Side;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangeListManager;
import com.intellij.openapi.vcs.changes.ContentRevision;
import com.intellij.openapi.vcs.changes.CurrentContentRevision;
import com.intellij.openapi.vcs.changes.actions.diff.ChangeDiffRequestProducer;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Shows the threads of the review in the side-by-side diff, the unified diff, and the diff of an added or deleted file, polled every 2 s:
 * in the diff of the review, and in that of a local change of the worktree, as the Commit view opens it.
 */
public final class ThreadsInDiff extends DiffExtension {
    @Override
    public void onViewerCreated(FrameDiffTool.DiffViewer viewer, DiffContext context, DiffRequest request) {
        Project project = context.getProject();
        if (project == null) return;
        Review review = request.getUserData(Review.KEY);
        if (review == null) review = local(project, request);
        if (review == null) return;
        Poll poll = new Poll(project, review, ModalityState.stateForComponent(viewer.getComponent()));
        Runnable refresh = () -> ApplicationManager.getApplication().executeOnPooledThread(poll);
        if (viewer instanceof TwosideTextDiffViewer twoside) {
            Editor left = twoside.getEditor(Side.LEFT);
            Editor right = twoside.getEditor(Side.RIGHT);
            poll.threads = List.of(
                new Threads(project, right, review, "new", right.getDocument(), Threads.Lines.SAME, refresh, viewer),
                new Threads(project, left, review, "old", left.getDocument(), Threads.Lines.SAME, refresh, viewer));
            poll.editors = List.of(left, right);
            right.putUserData(Threads.KEY, List.of(poll.threads.get(0)));
            left.putUserData(Threads.KEY, List.of(poll.threads.get(1)));
        } else if (viewer instanceof UnifiedDiffViewer unified) {
            Editor editor = unified.getEditor();
            poll.threads = List.of(
                new Threads(project, editor, review, "new", document(request, Side.RIGHT), lines(unified, Side.RIGHT), refresh, viewer),
                new Threads(project, editor, review, "old", document(request, Side.LEFT), lines(unified, Side.LEFT), refresh, viewer));
            poll.editors = List.of(editor);
            editor.putUserData(Threads.KEY, poll.threads);
            // The unified diff builds a new document at each rediff: the threads go back on it.
            unified.addListener(new DiffViewerListener() {
                @Override
                protected void onAfterRediff() {
                    poll.reshow();
                }
            });
        } else if (viewer instanceof OnesideTextDiffViewer oneside) {
            // An added or a deleted file shows one side only.
            Editor editor = oneside.getEditor();
            String side = oneside.getSide() == Side.RIGHT ? "new" : "old";
            poll.threads = List.of(new Threads(project, editor, review, side, editor.getDocument(), Threads.Lines.SAME, refresh, viewer));
            poll.editors = List.of(editor);
            editor.putUserData(Threads.KEY, poll.threads);
        } else {
            return;
        }
        ScheduledFuture<?> future = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(poll, 0, 2, TimeUnit.SECONDS);
        Disposer.register(viewer, () -> future.cancel(false));
    }

    // ponytail: never emptied, one session per diff of the review opened since the IDE started.
    /** The last session each poll read, by id: Send reads from it whether there is anything to send. */
    static final Map<String, JsonObject> SESSIONS = new ConcurrentHashMap<>();

    /** Whether a message the next Send would publish is Pending: one of a Resolved thread waits for its Unresolve. */
    static boolean pending(JsonObject session) {
        for (JsonElement thread : session.getAsJsonArray("threads")) {
            if (thread.getAsJsonObject().get("resolved").getAsBoolean()) continue;
            for (JsonElement message : thread.getAsJsonObject().getAsJsonArray("messages")) {
                JsonElement date = message.getAsJsonObject().get("date");
                if (date == null || date.isJsonNull()) return true;
            }
        }
        return false;
    }

    private static int waiting(JsonObject session) {
        int waiting = 0;
        for (JsonElement thread : session.getAsJsonArray("threads")) {
            JsonElement status = thread.getAsJsonObject().get("status");
            if (status != null && !status.isJsonNull() && status.getAsString().equals("waiting-for-claude")) waiting++;
        }
        return waiting;
    }

    private static final Pattern ID = Pattern.compile("[0-9a-f]{40}([0-9a-f]{24})?");

    /**
     * The review of a diff of a local change, as the Commit view shows it: the file of the worktree of the open session against HEAD;
     * null for another diff, such as a change of a commit of the log.
     */
    private static Review local(Project project, DiffRequest request) {
        Change change = request.getUserData(ChangeDiffRequestProducer.CHANGE_KEY);
        ReviewService.State state = ReviewService.get(project).state();
        if (change == null || state.session() == null) return null;
        ContentRevision before = change.getBeforeRevision();
        ContentRevision after = change.getAfterRevision();
        boolean local = after != null ? after instanceof CurrentContentRevision : ChangeListManager.getInstance(project).getChange(before.getFile()) != null;
        String path = (after != null ? after : before).getFile().getPath();
        if (!local || !path.startsWith(state.root() + "/")) return null;
        // An added file has no revision on the left: the base of the session places its threads, all on the new side.
        String base = before != null ? before.getRevisionNumber().asString() : state.base();
        if (!ID.matcher(base).matches()) return null;
        return new Review(state.id(), state.root(), base, path.substring(state.root().length() + 1));
    }

    /** The document of a side of the diff, which the unified diff shows through a document of its own. */
    private static Document document(DiffRequest request, Side side) {
        return ((DocumentContent) side.select(((ContentDiffRequest) request).getContents())).getDocument();
    }

    /** A side of the unified diff: its lines in the unified document, from 1, 0 when it does not show them. */
    private static Threads.Lines lines(UnifiedDiffViewer unified, Side side) {
        return new Threads.Lines() {
            @Override
            public int toEditor(int line) {
                return unified.transferLineToOnesideStrict(side, line - 1) + 1;
            }

            @Override
            public int fromEditor(int line) {
                return unified.transferLineFromOnesideStrict(side, line - 1) + 1;
            }
        };
    }

    /** Reads the session anchored on the base on the left and the working tree on the right, and shows it when it changed. */
    private static final class Poll implements Runnable {
        private final Project project;
        private final Review review;
        private final ModalityState modality;
        List<Threads> threads;
        List<Editor> editors;
        private volatile JsonObject last;

        Poll(Project project, Review review, ModalityState modality) {
            this.project = project;
            this.review = review;
            this.modality = modality;
        }

        /** Puts back all the threads of the last session read, on the EDT. */
        void reshow() {
            JsonObject session = last;
            if (session != null) show(session, true);
        }

        private void show(JsonObject session, boolean all) {
            for (Editor editor : editors) {
                if (editor.isDisposed()) return;
            }
            for (Threads side : threads) side.show(session, all);
        }

        // Synchronized: a refresh after a write may run while the scheduled poll does.
        @Override
        public synchronized void run() {
            JsonObject session;
            try {
                String route = "/api/sessions/" + review.session();
                String tree = Server.get(route + "/tree").get("tree").getAsString();
                session = Server.get(route + "?base=" + review.base() + "&tree=" + tree);
            } catch (IOException | RuntimeException e) {
                return; // A failed poll leaves the threads as they are; an exception would stop the scheduled poll for good.
            }
            SESSIONS.put(review.session(), session);
            if (session.equals(last)) return;
            // ponytail: only once no thread waits any more; the end of a turn that leaves threads waiting is told by the desktop notification of the mod.
            if (last != null && waiting(last) > 0 && waiting(session) == 0) ReviewDiffAction.notify(project, "Claude replied in every thread", ThreadView.Avatars.CLAUDE_SMALL);
            last = session;
            ApplicationManager.getApplication().invokeLater(() -> show(session, false), modality);
        }
    }
}
