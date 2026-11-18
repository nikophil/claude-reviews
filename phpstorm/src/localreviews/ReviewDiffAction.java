package localreviews;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.icons.AllIcons;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.editor.ChainDiffVirtualFile;
import com.intellij.diff.editor.DiffEditorTabFilesManager;
import com.intellij.diff.editor.DiffEditorViewerFileEditor;
import com.intellij.diff.impl.CacheDiffRequestChainProcessor;
import com.intellij.diff.tools.fragmented.UnifiedDiffViewer;
import com.intellij.diff.tools.util.side.OnesideTextDiffViewer;
import com.intellij.diff.tools.util.side.TwosideTextDiffViewer;
import com.intellij.openapi.fileEditor.FileEditor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.util.Key;
import com.intellij.diff.chains.DiffRequestProducer;
import com.intellij.diff.chains.DiffRequestProducerException;
import com.intellij.diff.chains.SimpleDiffRequestChain;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.requests.DiffRequest;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.diff.tools.util.DiffDataKeys;
import com.intellij.diff.impl.DiffSettingsHolder;
import com.intellij.diff.tools.util.base.TextDiffSettingsHolder;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.diff.util.DiffUserDataKeys;
import com.intellij.diff.util.Side;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.Presentation;
import com.intellij.openapi.actionSystem.Separator;
import com.intellij.openapi.actionSystem.ex.CheckboxAction;
import com.intellij.openapi.actionSystem.ex.CustomComponentAction;
import com.intellij.ide.ui.laf.darcula.ui.DarculaButtonUI;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.application.WriteIntentReadAction;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.util.Pair;
import com.intellij.openapi.util.UserDataHolder;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.AnimatedIcon;
import com.intellij.ui.ClientProperty;
import com.intellij.ui.components.JBCheckBox;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.ui.components.JBTextArea;
import com.intellij.util.ui.JBUI;

import javax.swing.Icon;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JPanel;
import javax.swing.SwingConstants;
import java.awt.BorderLayout;
import java.awt.Cursor;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Opens the diff of the project's session in the diff viewer of the IDE: the base on the left, the files of the worktree on the right. */
public final class ReviewDiffAction extends DumbAwareAction {
    private static final String TITLE = "Review Changes";

    public ReviewDiffAction() {
        super(TITLE, "Review the changes of the worktree with Claude", AllIcons.Actions.Diff);
    }

    @Override
    public ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(AnActionEvent event) {
        event.getPresentation().setEnabled(event.getProject() != null);
    }

    @Override
    public void actionPerformed(AnActionEvent event) {
        Project project = event.getProject();
        if (project != null) open(project, null);
    }

    /** The diff of the review opened last: its tab is reused while it is open and shows the same files of the same session against the same base. */
    private record Opened(ChainDiffVirtualFile file, String session, String base, List<String> paths, List<Target> targets) {}

    private static final Key<Opened> OPENED = Key.create("localreviews.Opened");

    /** Where a file of the diff scrolls when it shows, a side and a line from 0, null for its top; and the request it made last. */
    private static final class Target {
        volatile Pair<Side, Integer> line;
        volatile DiffRequest made;
    }

    /** Opens the diff of the session, at the file `path` when it is one of the diff, else the file in the editor, focused. */
    static void open(Project project, String path) {
        open(project, path, Side.RIGHT, -1, true);
    }

    /**
     * Opens the diff of the session at the file `path`, scrolled to `line`, from 1, of its side `side` when above 0, focused when `focus`.
     * The tab of the review opened last shows the file instead, if it is still open: a click on each file of the tool window does not open a tab each.
     * A file out of the diff, unchanged, binary, or that only threads name, opens in the editor at `line`, as in the Editor view.
     */
    static void open(Project project, String path, Side side, int line, boolean focus) {
        background(project, () -> {
            JsonObject worktree = new JsonObject();
            worktree.addProperty("worktree", project.getBasePath());
            JsonObject session = Server.post("/api/sessions", worktree);
            String id = session.get("id").getAsString();
            JsonObject diff = Server.get("/api/sessions/" + id + "/diff");
            String root = session.get("worktree").getAsString();
            String base = diff.get("base").getAsString();
            List<DiffRequestProducer> files = new ArrayList<>();
            List<String> paths = new ArrayList<>();
            List<Target> targets = new ArrayList<>();
            int at = path == null ? 0 : -1;
            for (JsonElement file : diff.getAsJsonArray("files")) {
                // The diff viewer shows no text of a binary file.
                if (file.getAsJsonObject().get("binary").getAsBoolean()) continue;
                if (path(file).equals(path)) at = files.size();
                Target target = new Target();
                paths.add(path(file));
                targets.add(target);
                files.add(producer(project, new Review(id, root, base, path(file)), status(file), target));
            }
            int index = at;
            Pair<Side, Integer> scroll = line > 0 ? Pair.create(side, line - 1) : null;
            ApplicationManager.getApplication().invokeLater(() -> {
                if (index < 0) {
                    VirtualFile local = LocalFileSystem.getInstance().refreshAndFindFileByPath(root + "/" + path);
                    if (local != null) new OpenFileDescriptor(project, local, Math.max(line, 1) - 1, 0).navigate(focus);
                    else Messages.showInfoMessage(project, path + " is not in the diff against " + diff.get("ref").getAsString() + ".", TITLE);
                    return;
                }
                if (files.isEmpty()) {
                    Messages.showInfoMessage(project, "No changes against " + diff.get("ref").getAsString() + ".", TITLE);
                    return;
                }
                Opened last = project.getUserData(OPENED);
                if (last != null && last.session().equals(id) && last.base().equals(base) && last.paths().equals(paths) && reuse(project, last, index, scroll, focus)) return;
                targets.get(index).line = scroll;
                SimpleDiffRequestChain chain = SimpleDiffRequestChain.fromProducers(files, index);
                foldUnchanged();
                chain.putUserData(DiffUserDataKeys.PLACE, PLACE);
                ActionManager actions = ActionManager.getInstance();
                chain.putUserData(DiffUserDataKeys.CONTEXT_ACTIONS, List.of(
                    actions.getAction("localreviews.PreviousThread"), actions.getAction("localreviews.NextThread"), Separator.getInstance(),
                    viewed(project, id), new Blocked(id), send(project, id), approve(project, id)));
                ChainDiffVirtualFile file = new ChainDiffVirtualFile(chain, TITLE);
                project.putUserData(OPENED, new Opened(file, id, base, paths, targets));
                DiffEditorTabFilesManager.getInstance(project).showDiffFile(file, focus);
            }, project.getDisposed());
        });
    }

    /** The place of the diff of the review: the IDE keeps its settings apart from those of its other diffs. */
    private static final String PLACE = "localreviews.Review";

    /**
     * Folds the unchanged code of the diff of the review, as the Commit view does, once only:
     * « Collapse Unchanged Fragments » in the settings of the diff then keeps my choice.
     * The other settings of the place start from those of the default place, which the diff of the review had until then.
     */
    private static void foldUnchanged() {
        PropertiesComponent properties = PropertiesComponent.getInstance();
        if (properties.isTrueValue(PLACE + ".folded")) return;
        TextDiffSettingsHolder.TextDiffSettings from = TextDiffSettingsHolder.TextDiffSettings.getSettings(null);
        TextDiffSettingsHolder.TextDiffSettings to = TextDiffSettingsHolder.TextDiffSettings.getSettings(PLACE);
        to.setHighlightPolicy(from.getHighlightPolicy());
        to.setIgnorePolicy(from.getIgnorePolicy());
        to.setShowWhitespaces(from.isShowWhitespaces());
        to.setShowLineNumbers(from.isShowLineNumbers());
        to.setShowIndentLines(from.isShowIndentLines());
        to.setUseSoftWraps(from.isUseSoftWraps());
        to.setHighlightingLevel(from.getHighlightingLevel());
        to.setReadOnlyLock(from.isReadOnlyLock());
        to.setBreadcrumbsPlacement(from.getBreadcrumbsPlacement());
        to.setContextRange(from.getContextRange());
        to.setExpandByDefault(false);
        DiffSettingsHolder.DiffSettings.getSettings(PLACE).setDiffToolsOrder(DiffSettingsHolder.DiffSettings.getSettings(null).getDiffToolsOrder());
        properties.setValue(PLACE + ".folded", true);
    }

    /** Shows the file `index` in the open tab of `opened`, scrolled to `scroll`; false when the tab is closed. */
    private static boolean reuse(Project project, Opened opened, int index, Pair<Side, Integer> scroll, boolean focus) {
        for (FileEditor editor : FileEditorManager.getInstance(project).getEditors(opened.file())) {
            if (!(editor instanceof DiffEditorViewerFileEditor shown) || !(shown.getEditorViewer() instanceof CacheDiffRequestChainProcessor processor)) continue;
            Target target = opened.targets().get(index);
            DiffRequest active = processor.getActiveRequest();
            if (active != null && active == target.made) {
                // Already shown: its viewer scrolls; a viewer made for a file reads SCROLL_TO_LINE once only.
                // ponytail: the viewers of text only; another stays where it is.
                if (scroll != null && processor.getActiveViewer() instanceof TwosideTextDiffViewer twoside) twoside.scrollToLine(scroll.first, scroll.second);
                if (scroll != null && processor.getActiveViewer() instanceof UnifiedDiffViewer unified) unified.scrollToLine(scroll.first, scroll.second);
                // An added or a deleted file shows its one side alone.
                if (scroll != null && processor.getActiveViewer() instanceof OnesideTextDiffViewer oneside && oneside.getSide() == scroll.first) oneside.scrollToLine(scroll.second);
            } else {
                target.line = scroll;
                if (target.made != null) target.made.putUserData(DiffUserDataKeys.SCROLL_TO_LINE, scroll);
                processor.setCurrentRequest(index);
            }
            DiffEditorTabFilesManager.getInstance(project).showDiffFile(opened.file(), focus);
            return true;
        }
        return false;
    }

    /** Loads one file only when the diff shows it, scrolled to the line of its `target`. */
    private static DiffRequestProducer producer(Project project, Review review, String status, Target target) {
        FileType type = FileTypeManager.getInstance().getFileTypeByFileName(review.path());
        return new DiffRequestProducer() {
            @Override
            public String getName() {
                return review.path();
            }

            @Override
            public FileType getContentType() {
                return type;
            }

            @Override
            public DiffRequest process(UserDataHolder context, ProgressIndicator indicator) throws DiffRequestProducerException {
                DiffContentFactory contents = DiffContentFactory.getInstance();
                DiffContent left = contents.createEmpty();
                if (!status.equals("added")) {
                    try {
                        String text = Server.get("/api/sessions/" + review.session() + "/file?object=" + review.base() + "&path=" + Server.encode(review.path())).get("text").getAsString();
                        left = contents.create(project, text, type);
                    } catch (IOException e) {
                        throw new DiffRequestProducerException(message(e), e);
                    }
                }
                VirtualFile file = status.equals("deleted") ? null : LocalFileSystem.getInstance().refreshAndFindFileByPath(review.root() + "/" + review.path());
                // A file Claude just rewrote: its document would show its old text, a diff without change, until the IDE notices.
                if (file != null) VfsUtil.markDirtyAndRefresh(false, false, false, file);
                DiffContent right = file == null ? contents.createEmpty() : ReadAction.computeBlocking(() -> contents.create(project, file));
                SimpleDiffRequest request = new SimpleDiffRequest(review.path(), left, right, review.base().substring(0, 7), "Working tree");
                // The base is read only, the working tree is the file itself.
                request.putUserData(DiffUserDataKeys.FORCE_READ_ONLY_CONTENTS, new boolean[] {true, false});
                request.putUserData(Review.KEY, review);
                request.putUserData(DiffUserDataKeys.SCROLL_TO_LINE, target.line);
                target.made = request;
                return request;
            }
        };
    }

    /** « Viewed », as in the review of the GitHub plugin: the file the diff shows, marked on the working tree. */
    private static AnAction viewed(Project project, String id) {
        return new CheckboxAction("Viewed", "Mark the file as viewed, until it changes", null) {
            @Override
            public ActionUpdateThread getActionUpdateThread() {
                return ActionUpdateThread.BGT;
            }

            @Override
            public void update(AnActionEvent event) {
                super.update(event);
                event.getPresentation().setEnabled(review(event) != null);
            }

            @Override
            public boolean isSelected(AnActionEvent event) {
                Review review = review(event);
                return review != null && ReviewService.viewed(ReviewService.get(project).state().session(), review.path());
            }

            @Override
            public void setSelected(AnActionEvent event, boolean viewed) {
                Review review = review(event);
                if (review == null) return;
                markViewed(project, id, review.path(), viewed, ReviewService.get(project)::refresh);
                if (viewed) ReviewToolWindow.viewedNext(project, review.path());
            }
        };
    }

    private static Review review(AnActionEvent event) {
        DiffRequest request = event.getData(DiffDataKeys.DIFF_REQUEST);
        return request == null ? null : request.getUserData(Review.KEY);
    }

    /**
     * Marks `path` Viewed, or no longer, on the tree of the working tree, once its documents are saved, then runs `done` off the EDT:
     * what I viewed is the file as it is now. Needs the write-intent lock.
     */
    static void markViewed(Project project, String id, String path, boolean viewed, Runnable done) {
        FileDocumentManager.getInstance().saveAllDocuments();
        background(project, () -> {
            JsonObject body = new JsonObject();
            body.addProperty("path", path);
            body.add("tree", Server.get("/api/sessions/" + id + "/tree").get("tree"));
            body.addProperty("viewed", viewed);
            Server.post("/api/sessions/" + id + "/viewed", body);
            done.run();
        });
    }

    /** Send: the tree the diff shows is the working tree, once its documents are saved. */
    private static AnAction send(Project project, String id) {
        // Greyed, with why, as the last poll of the diff read the session; until the first poll, Send stays enabled.
        Supplier<String> refusal = () -> ThreadsInDiff.SESSIONS.get(id) instanceof JsonObject session ? Placement.sendRefusal(session) : null;
        return new ToolbarButton("Send", AllIcons.Actions.Upload, true, refusal, () -> ReviewService.get(project).spinning(ReviewService.SENT_FROM_DIFF, null),
            done -> send(project, id, null, ReviewService.SENT_FROM_DIFF, done));
    }

    /**
     * Send of the whole session, or of the thread `thread` only when not null, from the button `from`, then `done` on the EDT, sent or not:
     * the documents saved, the tree of the working tree is the one the diff and the editors show. Needs the write-intent lock.
     */
    static void send(Project project, String id, Integer thread, String from, Runnable done) {
        JsonObject body = new JsonObject();
        // The Send of the whole session carries a review message and its readonly, as a review on GitHub its body; cancelled, nothing is sent.
        if (thread == null && !review(project, body)) {
            done.run();
            return;
        }
        ReviewService.get(project).sentFrom(thread != null ? "thread:" + thread : from);
        FileDocumentManager.getInstance().saveAllDocuments();
        background(project, () -> {
            try {
                body.add("tree", Server.get("/api/sessions/" + id + "/tree").get("tree"));
                if (thread != null) {
                    JsonArray threads = new JsonArray();
                    threads.add(thread);
                    body.add("threads", threads);
                }
                JsonObject session = Server.post("/api/sessions/" + id + "/send", body);
                ThreadsInDiff.SESSIONS.put(id, session);
                int count = sent(session);
                notify(project, count + (count == 1 ? " message sent to Claude" : " messages sent to Claude"), ThreadView.Avatars.CLAUDE_SMALL);
            } finally {
                ApplicationManager.getApplication().invokeLater(done);
            }
        });
    }

    /** Asks the review message and « Answer without changing code » of a Send into `body`; false once cancelled. */
    private static boolean review(Project project, JsonObject body) {
        JBTextArea message = new JBTextArea(5, 50);
        message.setLineWrap(true);
        message.setWrapStyleWord(true);
        JBCheckBox readonly = new JBCheckBox("Answer without changing code");
        readonly.setToolTipText("Claude replies in the threads of this Send without editing any file");
        DialogWrapper dialog = new DialogWrapper(project) {
            {
                setTitle("Send to Claude");
                setOKButtonText("Send");
                init();
            }

            @Override
            protected JComponent createCenterPanel() {
                JPanel panel = new JPanel(new BorderLayout(0, JBUI.scale(8)));
                panel.add(new JBLabel("Review message, optional"), BorderLayout.NORTH);
                panel.add(new JBScrollPane(message), BorderLayout.CENTER);
                panel.add(readonly, BorderLayout.SOUTH);
                return panel;
            }

            @Override
            public JComponent getPreferredFocusedComponent() {
                return message;
            }
        };
        if (!dialog.showAndGet()) return false;
        body.addProperty("body", message.getText());
        body.addProperty("readonly", readonly.isSelected());
        return true;
    }

    private static AnAction approve(Project project, String id) {
        Supplier<String> refusal = () -> ThreadsInDiff.SESSIONS.get(id) instanceof JsonObject session ? Placement.approveRefusal(session) : null;
        return new ToolbarButton("Approve", AllIcons.Actions.Checked, false, refusal, () -> false, done -> approve(project, id, done));
    }

    /** Approve, once confirmed, then `done` on the EDT, approved, refused or cancelled. */
    static void approve(Project project, String id, Runnable done) {
        background(project, () -> {
            int open = 0;
            try {
                for (JsonElement thread : Server.get("/api/sessions/" + id).getAsJsonArray("threads")) {
                    if (!thread.getAsJsonObject().get("resolved").getAsBoolean()) open++;
                }
            } catch (IOException | RuntimeException e) {
                ApplicationManager.getApplication().invokeLater(done);
                throw e;
            }
            int threads = open;
            ApplicationManager.getApplication().invokeLater(() -> {
                String question = threads == 0 ? "Approve this session?" : "Approve this session with " + threads + " open threads?";
                if (Messages.showYesNoDialog(project, question, TITLE, null) != Messages.YES) {
                    done.run();
                    return;
                }
                background(project, () -> {
                    try {
                        Server.post("/api/sessions/" + id + "/approve", new JsonObject());
                        notify(project, "Session approved", null);
                    } finally {
                        ApplicationManager.getApplication().invokeLater(done);
                    }
                });
            });
        });
    }

    /** A button in the toolbar of the diff, as « Submit Review » in the review of the GitHub plugin; `primary` makes it blue. */
    private static final class ToolbarButton extends DumbAwareAction implements CustomComponentAction {
        private final boolean primary;
        private final Supplier<String> refusal;
        private final BooleanSupplier spinning;
        private final Icon icon;
        private final Consumer<Runnable> run;
        private volatile boolean writing;

        /**
         * `refusal` gives why the button is greyed, null while it is enabled; `spinning`, whether a spinner takes the place of its icon;
         * `run` writes, then runs the callback it is given on the EDT: the button stays greyed until then.
         */
        ToolbarButton(String text, Icon icon, boolean primary, Supplier<String> refusal, BooleanSupplier spinning, Consumer<Runnable> run) {
            super(text, null, icon);
            this.primary = primary;
            this.refusal = refusal;
            this.spinning = spinning;
            this.icon = icon;
            this.run = run;
        }

        @Override
        public ActionUpdateThread getActionUpdateThread() {
            return ActionUpdateThread.BGT;
        }

        @Override
        public void update(AnActionEvent event) {
            String why = refusal.get();
            event.getPresentation().setEnabled(!writing && why == null);
            event.getPresentation().setDescription(why);
            event.getPresentation().setIcon(spinning.getAsBoolean() ? AnimatedIcon.Default.INSTANCE : icon);
        }

        @Override
        public void actionPerformed(AnActionEvent event) {
            write();
        }

        private void write() {
            writing = true;
            run.accept(() -> writing = false);
        }

        @Override
        public void updateCustomComponent(JComponent component, Presentation presentation) {
            JButton button = (JButton) component.getComponent(0);
            button.setEnabled(presentation.isEnabled());
            button.setToolTipText(presentation.getDescription());
            ThreadView.spin(button, presentation.getIcon() == AnimatedIcon.Default.INSTANCE, icon);
        }

        @Override
        public JComponent createCustomComponent(Presentation presentation, String place) {
            JButton button = new JButton(presentation.getText(), presentation.getIcon());
            button.setFocusable(false);
            button.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            ClientProperty.put(button, DarculaButtonUI.DEFAULT_STYLE_KEY, primary);
            // A bare Swing listener, unlike an action, has to take the write-intent lock that saving the documents needs.
            button.addActionListener(e -> WriteIntentReadAction.run(this::write));
            JPanel margin = new JPanel(new BorderLayout());
            margin.setOpaque(false);
            margin.setBorder(JBUI.Borders.empty(0, 4));
            margin.add(button);
            return margin;
        }
    }

    /** The warning of the tool window that the Claude session is Blocked, short in the toolbar of the diff, whole in its tooltip. */
    private static final class Blocked extends DumbAwareAction implements CustomComponentAction {
        private final String id;

        Blocked(String id) {
            this.id = id;
        }

        @Override
        public ActionUpdateThread getActionUpdateThread() {
            return ActionUpdateThread.BGT;
        }

        @Override
        public void update(AnActionEvent event) {
            event.getPresentation().setVisible(ThreadsInDiff.SESSIONS.get(id) instanceof JsonObject session && Placement.blocked(session));
        }

        @Override
        public void actionPerformed(AnActionEvent event) {}

        @Override
        public JComponent createCustomComponent(Presentation presentation, String place) {
            JBLabel label = new JBLabel("Claude is waiting for your answer in its session", AllIcons.General.Warning, SwingConstants.LEFT);
            label.setToolTipText(ReviewToolWindow.BLOCKED);
            label.setBorder(JBUI.Borders.empty(0, 4));
            return label;
        }
    }

    /** A balloon of the IDE, also kept in its Notifications tool window. */
    static void notify(Project project, String text, Icon icon) {
        Notification notification = NotificationGroupManager.getInstance().getNotificationGroup("Local Reviews").createNotification(text, NotificationType.INFORMATION);
        if (icon != null) notification.setIcon(icon);
        notification.notify(project);
    }

    /** The messages the last Send published: the ones it numbered. */
    private static int sent(JsonObject session) {
        int send = session.get("sends").getAsInt();
        int sent = 0;
        for (JsonElement thread : session.getAsJsonArray("threads")) {
            for (JsonElement message : thread.getAsJsonObject().getAsJsonArray("messages")) {
                JsonElement review = message.getAsJsonObject().get("review");
                if (review != null && !review.isJsonNull() && review.getAsInt() == send) sent++;
            }
        }
        return sent;
    }

    interface Call {
        void run() throws IOException;
    }

    /** Calls the server off the EDT, and shows its failure in a dialog: a 409 says why the server refused. */
    static void background(Project project, Call call) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                call.run();
            } catch (IOException e) {
                ApplicationManager.getApplication().invokeLater(() -> Messages.showErrorDialog(project, message(e), TITLE));
            } catch (RuntimeException e) {
                ApplicationManager.getApplication().invokeLater(() -> Messages.showErrorDialog(project, "Unexpected answer of the claude-reviews server: " + e, TITLE));
            }
        });
    }

    static String message(IOException e) {
        return e instanceof Server.Failure ? e.getMessage()
            : "The claude-reviews server does not answer (no server at " + Server.ENDPOINT + "): start a Claude session with the local-reviews mod, or npm start.";
    }

    private static String path(JsonElement file) {
        return file.getAsJsonObject().get("path").getAsString();
    }

    private static String status(JsonElement file) {
        return file.getAsJsonObject().get("status").getAsString();
    }
}
