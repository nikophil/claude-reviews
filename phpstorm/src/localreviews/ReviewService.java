package localreviews;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.EditorKind;
import com.intellij.openapi.editor.event.EditorFactoryEvent;
import com.intellij.openapi.editor.event.EditorFactoryListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * The review of the project's worktree, polled every 2 s: its session, the diff against its base, its threads in the editors of its files.
 * Its state changes on the EDT only.
 */
public final class ReviewService implements Disposable {
    private static final String THREADS_IN_EDITOR = "localreviews.threadsInEditor";
    private static final String RESOLVED_TOO = "localreviews.resolvedToo";

    /** What a poll read: no session yet (`session` null), or the session anchored on the diff it shows; `error` when the server did not answer. */
    record State(String error, String root, String ref, String base, String tree, JsonArray files, JsonObject session) {
        static final State NONE = new State(null, null, null, null, null, new JsonArray(), null);

        String id() {
            return session == null ? null : session.get("id").getAsString();
        }
    }

    private record Attached(String path, Disposable disposable, Threads threads) {}

    private static final Logger LOG = Logger.getInstance(ReviewService.class);

    private final Project project;
    private final List<Consumer<State>> listeners = new CopyOnWriteArrayList<>();
    private final Map<Editor, Attached> editors = new HashMap<>();
    private final ScheduledFuture<?> poll;
    private volatile State state = State.NONE;

    public ReviewService(Project project) {
        this.project = project;
        EditorFactory.getInstance().addEditorFactoryListener(new EditorFactoryListener() {
            @Override
            public void editorCreated(EditorFactoryEvent event) {
                attach(event.getEditor());
            }

            @Override
            public void editorReleased(EditorFactoryEvent event) {
                Attached attached = editors.remove(event.getEditor());
                if (attached != null) Disposer.dispose(attached.disposable());
            }
        }, this);
        poll = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(this::poll, 0, 2, TimeUnit.SECONDS);
        ApplicationManager.getApplication().invokeLater(() -> {
            for (Editor editor : EditorFactory.getInstance().getAllEditors()) attach(editor);
        }, project.getDisposed());
    }

    static ReviewService get(Project project) {
        return project.getService(ReviewService.class);
    }

    State state() {
        return state;
    }

    /** Calls `listener` on the EDT with the state now, then at each change, until `parent` is disposed. */
    void listen(Consumer<State> listener, Disposable parent) {
        listeners.add(listener);
        Disposer.register(parent, () -> listeners.remove(listener));
        ApplicationManager.getApplication().invokeLater(() -> listener.accept(state), project.getDisposed());
    }

    boolean threadsInEditor() {
        return PropertiesComponent.getInstance(project).getBoolean(THREADS_IN_EDITOR, true);
    }

    boolean resolvedToo() {
        return PropertiesComponent.getInstance(project).getBoolean(RESOLVED_TOO, false);
    }

    void threadsInEditor(boolean shown) {
        PropertiesComponent.getInstance(project).setValue(THREADS_IN_EDITOR, shown, true);
        showInEditors(true);
    }

    void resolvedToo(boolean shown) {
        PropertiesComponent.getInstance(project).setValue(RESOLVED_TOO, shown, false);
        showInEditors(true);
    }

    /** Polls again at once, after a write. */
    void refresh() {
        ApplicationManager.getApplication().executeOnPooledThread(this::poll);
    }

    /** Opens the session of the worktree. */
    void start() {
        ReviewDiffAction.background(project, () -> {
            JsonObject worktree = new JsonObject();
            worktree.addProperty("worktree", project.getBasePath());
            Server.post("/api/sessions", worktree);
            refresh();
        });
    }

    // Synchronized: a refresh after a write may run while the scheduled poll does.
    private synchronized void poll() {
        State read;
        try {
            read = read(state);
        } catch (IOException | RuntimeException e) {
            // The threads stay as they are, the tool window says why; an exception would also stop the scheduled poll for good.
            String error = e instanceof IOException io ? ReviewDiffAction.message(io) : "Unexpected answer of the claude-reviews server: " + e;
            read = new State(error, state.root(), state.ref(), state.base(), state.tree(), state.files(), state.session());
        }
        if (read.equals(state)) return;
        State changed = read;
        state = changed;
        if (changed.session() != null) ThreadsInDiff.SESSIONS.put(changed.id(), changed.session());
        ApplicationManager.getApplication().invokeLater(() -> {
            showInEditors(false);
            // A listener that fails leaves the others, and the editors, up to date.
            for (Consumer<State> listener : listeners) {
                try {
                    listener.accept(changed);
                } catch (RuntimeException e) {
                    LOG.error(e);
                }
            }
        }, project.getDisposed());
    }

    private State read(State last) throws IOException {
        JsonObject found;
        try {
            found = Server.get("/api/sessions?worktree=" + Server.encode(project.getBasePath()));
        } catch (Server.Failure e) {
            if (e.status == 404) return State.NONE;
            throw e;
        }
        String route = "/api/sessions/" + found.get("id").getAsString();
        JsonObject tree = Server.get(route + "/tree");
        String base = tree.get("base").getAsString();
        String shown = tree.get("tree").getAsString();
        // The server keeps the diff of a base and a tree: it only asks again when they changed.
        JsonArray files = base.equals(last.base()) && shown.equals(last.tree()) ? last.files() : Server.get(route + "/diff").getAsJsonArray("files");
        JsonObject session = Server.get(route + "?base=" + base + "&tree=" + shown);
        return new State(null, found.get("worktree").getAsString(), tree.get("ref").getAsString(), base, shown, files, session);
    }

    /** Gives an editor of a file of the worktree its threads; a diff keeps its own. */
    private void attach(Editor editor) {
        if (editor.getProject() != project || editor.getEditorKind() != EditorKind.MAIN_EDITOR || editors.containsKey(editor)) return;
        VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
        String root = project.getBasePath();
        if (file == null || root == null || !file.getPath().startsWith(root + "/")) return;
        editors.put(editor, new Attached(file.getPath().substring(root.length() + 1), Disposer.newDisposable(), null));
        show(editor, false);
    }

    private void showInEditors(boolean all) {
        for (Editor editor : List.copyOf(editors.keySet())) show(editor, all);
    }

    /** Puts the threads of the state in an editor: built again once the session or its base changed, all of them again when `all`. */
    private void show(Editor editor, boolean all) {
        Attached attached = editors.get(editor);
        State shown = state;
        if (attached == null || editor.isDisposed()) return;
        Review review = shown.session() == null ? null : new Review(shown.id(), shown.root(), shown.base(), attached.path());
        Threads threads = attached.threads();
        if (threads != null && (review == null || !review.equals(threads.review()))) {
            Disposer.dispose(attached.disposable());
            attached = new Attached(attached.path(), Disposer.newDisposable(), null);
            threads = null;
            editors.put(editor, attached);
            editor.putUserData(Threads.KEY, null);
        }
        if (review == null) return;
        if (threads == null) {
            threads = new Threads(project, editor, review, "new", editor.getDocument(), Threads.Lines.SAME, this::refresh, attached.disposable());
            attached = new Attached(attached.path(), attached.disposable(), threads);
            editors.put(editor, attached);
            editor.putUserData(Threads.KEY, List.of(threads));
            all = true;
        }
        threads.collapsed(!threadsInEditor());
        threads.show(resolvedToo() ? shown.session() : unresolved(shown.session()), all);
    }

    private static JsonObject unresolved(JsonObject session) {
        JsonObject copy = session.deepCopy();
        JsonArray open = new JsonArray();
        for (JsonElement thread : copy.getAsJsonArray("threads")) {
            if (!thread.getAsJsonObject().get("resolved").getAsBoolean()) open.add(thread);
        }
        copy.add("threads", open);
        return copy;
    }

    @Override
    public void dispose() {
        poll.cancel(false);
        for (Attached attached : editors.values()) Disposer.dispose(attached.disposable());
        editors.clear();
    }
}
