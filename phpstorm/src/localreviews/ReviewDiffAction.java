package localreviews;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.icons.AllIcons;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffDialogHints;
import com.intellij.diff.DiffManager;
import com.intellij.diff.chains.DiffRequestProducer;
import com.intellij.diff.chains.DiffRequestProducerException;
import com.intellij.diff.chains.SimpleDiffRequestChain;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.requests.DiffRequest;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.diff.util.DiffUserDataKeys;
import com.intellij.diff.util.Side;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.Presentation;
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
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.util.Pair;
import com.intellij.openapi.util.UserDataHolder;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.ClientProperty;
import com.intellij.util.ui.JBUI;

import javax.swing.Icon;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.awt.Cursor;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;

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

    /** Opens the diff of the session, at the file `path` when it is one of the diff. */
    static void open(Project project, String path) {
        open(project, path, -1);
    }

    /** Opens the diff of the session at the file `path`, scrolled to `oldLine`, from 1, of its old side. */
    static void open(Project project, String path, int oldLine) {
        background(project, () -> {
            JsonObject worktree = new JsonObject();
            worktree.addProperty("worktree", project.getBasePath());
            JsonObject session = Server.post("/api/sessions", worktree);
            String id = session.get("id").getAsString();
            JsonObject diff = Server.get("/api/sessions/" + id + "/diff");
            String root = session.get("worktree").getAsString();
            String base = diff.get("base").getAsString();
            List<DiffRequestProducer> files = new ArrayList<>();
            int at = 0;
            for (JsonElement file : diff.getAsJsonArray("files")) {
                // The diff viewer shows no text of a binary file.
                if (file.getAsJsonObject().get("binary").getAsBoolean()) continue;
                if (path(file).equals(path)) at = files.size();
                files.add(producer(project, new Review(id, root, base, path(file)), status(file), path(file).equals(path) ? oldLine : -1));
            }
            int index = at;
            ApplicationManager.getApplication().invokeLater(() -> {
                if (files.isEmpty()) {
                    Messages.showInfoMessage(project, "No changes against " + diff.get("ref").getAsString() + ".", TITLE);
                    return;
                }
                SimpleDiffRequestChain chain = SimpleDiffRequestChain.fromProducers(files, index);
                chain.putUserData(DiffUserDataKeys.CONTEXT_ACTIONS, List.of(send(project, id), approve(project, id)));
                DiffManager.getInstance().showDiff(project, chain, DiffDialogHints.DEFAULT);
            });
        });
    }

    /** Loads one file only when the diff shows it. */
    private static DiffRequestProducer producer(Project project, Review review, String status, int oldLine) {
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
                DiffContent right = file == null ? contents.createEmpty() : ReadAction.computeBlocking(() -> contents.create(project, file));
                SimpleDiffRequest request = new SimpleDiffRequest(review.path(), left, right, review.base().substring(0, 7), "Working tree");
                // The base is read only, the working tree is the file itself.
                request.putUserData(DiffUserDataKeys.FORCE_READ_ONLY_CONTENTS, new boolean[] {true, false});
                request.putUserData(Review.KEY, review);
                if (oldLine > 0) request.putUserData(DiffUserDataKeys.SCROLL_TO_LINE, Pair.create(Side.LEFT, oldLine - 1));
                return request;
            }
        };
    }

    /** Send: the tree the diff shows is the working tree, once its documents are saved. */
    private static AnAction send(Project project, String id) {
        // Greyed when no message is Pending, as the last poll of the diff read the session; until the first poll, Send stays enabled.
        BooleanSupplier pending = () -> {
            JsonObject session = ThreadsInDiff.SESSIONS.get(id);
            return session == null || ThreadsInDiff.pending(session);
        };
        return new ToolbarButton("Send", AllIcons.Actions.Upload, true, pending, () -> send(project, id, () -> {}));
    }

    /** Send, then `sent` on the EDT: the documents saved, the tree of the working tree is the one the diff and the editors show. Needs the write-intent lock. */
    static void send(Project project, String id, Runnable sent) {
        FileDocumentManager.getInstance().saveAllDocuments();
        background(project, () -> {
            JsonObject tree = new JsonObject();
            tree.add("tree", Server.get("/api/sessions/" + id + "/tree").get("tree"));
            JsonObject session = Server.post("/api/sessions/" + id + "/send", tree);
            ThreadsInDiff.SESSIONS.put(id, session);
            int count = sent(session);
            notify(project, count + (count == 1 ? " message sent to Claude" : " messages sent to Claude"), ThreadView.Avatars.CLAUDE_SMALL);
            ApplicationManager.getApplication().invokeLater(sent);
        });
    }

    private static AnAction approve(Project project, String id) {
        return new ToolbarButton("Approve", AllIcons.Actions.Checked, false, () -> true, () -> approve(project, id, () -> {}));
    }

    /** Approve, once confirmed, then `approved` on the EDT. */
    static void approve(Project project, String id, Runnable approved) {
        background(project, () -> {
            int open = 0;
            for (JsonElement thread : Server.get("/api/sessions/" + id).getAsJsonArray("threads")) {
                if (!thread.getAsJsonObject().get("resolved").getAsBoolean()) open++;
            }
            int threads = open;
            ApplicationManager.getApplication().invokeLater(() -> {
                String question = threads == 0 ? "Approve this session?" : "Approve this session with " + threads + " open threads?";
                if (Messages.showYesNoDialog(project, question, TITLE, null) != Messages.YES) return;
                background(project, () -> {
                    Server.post("/api/sessions/" + id + "/approve", new JsonObject());
                    notify(project, "Session approved", null);
                    ApplicationManager.getApplication().invokeLater(approved);
                });
            });
        });
    }

    /** A button in the toolbar of the diff, as « Submit Review » in the review of the GitHub plugin; `primary` makes it blue. */
    private static final class ToolbarButton extends DumbAwareAction implements CustomComponentAction {
        private final boolean primary;
        private final BooleanSupplier enabled;
        private final Runnable run;

        ToolbarButton(String text, Icon icon, boolean primary, BooleanSupplier enabled, Runnable run) {
            super(text, null, icon);
            this.primary = primary;
            this.enabled = enabled;
            this.run = run;
        }

        @Override
        public ActionUpdateThread getActionUpdateThread() {
            return ActionUpdateThread.BGT;
        }

        @Override
        public void update(AnActionEvent event) {
            event.getPresentation().setEnabled(enabled.getAsBoolean());
        }

        @Override
        public void actionPerformed(AnActionEvent event) {
            run.run();
        }

        @Override
        public void updateCustomComponent(JComponent component, Presentation presentation) {
            component.getComponent(0).setEnabled(presentation.isEnabled());
        }

        @Override
        public JComponent createCustomComponent(Presentation presentation, String place) {
            JButton button = new JButton(presentation.getText(), presentation.getIcon());
            button.setFocusable(false);
            button.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            ClientProperty.put(button, DarculaButtonUI.DEFAULT_STYLE_KEY, primary);
            // A bare Swing listener, unlike an action, has to take the write-intent lock that saving the documents needs.
            button.addActionListener(e -> WriteIntentReadAction.run(run));
            JPanel margin = new JPanel(new BorderLayout());
            margin.setOpaque(false);
            margin.setBorder(JBUI.Borders.empty(0, 4));
            margin.add(button);
            return margin;
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
            }
        });
    }

    static String message(IOException e) {
        return e instanceof Server.Failure ? e.getMessage()
            : "The claude-reviews server does not answer on " + Server.URL + ": start a Claude session with the local-reviews mod, or npm start.";
    }

    private static String path(JsonElement file) {
        return file.getAsJsonObject().get("path").getAsString();
    }

    private static String status(JsonElement file) {
        return file.getAsJsonObject().get("status").getAsString();
    }
}
