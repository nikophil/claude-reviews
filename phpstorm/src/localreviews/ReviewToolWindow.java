package localreviews;

import com.google.gson.JsonArray;
import com.intellij.diff.util.Side;
import com.intellij.ide.impl.ProjectUtil;
import com.intellij.ui.AppIcon;
import com.intellij.ui.SystemNotifications;
import com.google.gson.JsonElement;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonObject;
import com.intellij.icons.AllIcons;
import com.intellij.ide.ui.laf.darcula.ui.DarculaButtonUI;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.DefaultActionGroup;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.WriteIntentReadAction;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.ComboBox;
import com.intellij.openapi.vcs.FileStatus;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.ClientProperty;
import com.intellij.ui.ColoredTreeCellRenderer;
import com.intellij.ui.DoubleClickListener;
import com.intellij.ui.JBColor;
import com.intellij.ui.PopupHandler;
import com.intellij.openapi.ui.popup.ListSeparator;
import com.intellij.ui.ComboboxSpeedSearch;
import com.intellij.ui.GroupedComboBoxRenderer;
import com.intellij.ui.RowIcon;
import com.intellij.ui.components.JBRadioButton;
import com.intellij.util.ui.LafIconLookup;
import com.intellij.ui.SimpleTextAttributes;
import com.intellij.ui.components.JBCheckBox;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.ui.components.panels.VerticalLayout;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.treeStructure.Tree;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.tree.TreeUtil;

import javax.swing.ButtonGroup;
import javax.swing.DefaultComboBoxModel;
import javax.swing.Icon;
import javax.swing.JButton;
import javax.swing.JPanel;
import javax.swing.JTree;
import javax.swing.SwingConstants;
import javax.swing.tree.DefaultMutableTreeNode;
import javax.swing.tree.DefaultTreeModel;
import javax.swing.tree.TreePath;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.FlowLayout;
import java.awt.GridLayout;
import java.awt.Rectangle;
import java.awt.event.MouseAdapter;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/** The review of the worktree, on the left: its base, Send and Approve, and its changed files with their threads. */
public final class ReviewToolWindow implements ToolWindowFactory, DumbAware {
    private static final Color AMBER = new JBColor(new Color(0x8A5A00), new Color(0xE8B05A));
    private static final Icon CHECKBOX = LafIconLookup.getIcon("checkBox", false);
    private static final Icon CHECKED = LafIconLookup.getIcon("checkBox", true);

    // At the opening of the project, before any click on its button: the threads go in the editors, and the button tells what awaits.
    @Override
    public void init(ToolWindow toolWindow) {
        String[] shown = {null};
        ReviewService.get(toolWindow.getProject()).listen(state -> {
            // /review-local asked to show the review: once per request, and only a recent one, which a project the launcher opens still finds.
            JsonElement requested = state.session() == null ? null : state.session().get("showRequestedAt");
            if (requested instanceof JsonPrimitive at && !at.getAsString().equals(shown[0])) {
                shown[0] = at.getAsString();
                if (Instant.parse(shown[0]).isAfter(Instant.now().minusSeconds(30))) show(toolWindow, state.root());
            }
        }, toolWindow.getDisposable());
    }

    /**
     * Shows the tool window, and draws the eye to PhpStorm: a desktop notification, the icon of the dock, and the focus;
     * under Wayland, GNOME refuses the focus without a token of activation, and shakes no icon: the notification remains.
     */
    private static void show(ToolWindow toolWindow, String root) {
        Project project = toolWindow.getProject();
        toolWindow.activate(null);
        ProjectUtil.focusProjectWindow(project, true);
        AppIcon.getInstance().requestAttention(project, true);
        SystemNotifications.getInstance().notify("Local Reviews", "Claude Reviews", "The review of " + root + " is open in PhpStorm");
    }

    @Override
    public void createToolWindowContent(Project project, ToolWindow toolWindow) {
        toolWindow.getContentManager().addContent(ContentFactory.getInstance().createContent(new Panel(project, toolWindow), "", false));
        toolWindow.setTitleActions(List.of(
            ActionManager.getInstance().getAction("localreviews.ReviewDiff"),
            DumbAwareAction.create("Refresh", AllIcons.Actions.Refresh, event -> ReviewService.get(project).refresh())));
    }

    private record Dir(String path) {}

    private record ThreadNode(JsonObject thread) {}

    private static final class Panel extends JPanel {
        private static final long serialVersionUID = 1L;

        private final transient Project project;
        private final transient ReviewService service;
        private final ComboBox<JsonObject> bases = new ComboBox<>();
        private final JBRadioButton editorView = new JBRadioButton("Editor");
        private final JBRadioButton diffView = new JBRadioButton("Diff");
        private final JBCheckBox threadsInEditor = new JBCheckBox("Show threads");
        private final JBCheckBox resolvedToo = new JBCheckBox("Show resolved");
        private final JButton send = new JButton("Send", AllIcons.Actions.Upload);
        private final JButton approve = new JButton("Approve", AllIcons.Actions.Checked);
        private final JBLabel summary = new JBLabel();
        private final JPanel startClaude = new JPanel(new BorderLayout());
        private final Tree tree = new Tree(new DefaultTreeModel(new DefaultMutableTreeNode()));
        private final JPanel header = new JPanel(new VerticalLayout(JBUI.scale(8)));
        private final JPanel empty = new JPanel(new VerticalLayout(JBUI.scale(8)));
        private final JBLabel emptyText = new JBLabel();
        private final JButton start = new JButton("Start review");
        private transient ReviewService.State state = ReviewService.State.NONE;
        private transient String basesOf;
        private transient Object shownKey;
        private boolean updating;
        private boolean rebuilding;

        Panel(Project project, ToolWindow toolWindow) {
            super(new BorderLayout());
            this.project = project;
            this.service = ReviewService.get(project);

            // The quick choices, then the pull requests, the local and the remote branches, each under its separator; typing searches them.
            bases.setRenderer(new GroupedComboBoxRenderer<JsonObject>(bases) {
                @Override
                public String getText(JsonObject base) {
                    return base.get("name").getAsString() + (disabled(base) ? " (after a Send)" : "");
                }

                @Override
                public ListSeparator separatorFor(JsonObject base) {
                    String group = group(base);
                    int index = ((DefaultComboBoxModel<JsonObject>) bases.getModel()).getIndexOf(base);
                    return group != null && (index == 0 || !group.equals(group(bases.getItemAt(index - 1)))) ? new ListSeparator(group) : null;
                }
            });
            ComboboxSpeedSearch.installSpeedSearch(bases, (JsonObject base) -> base.get("name").getAsString());
            // A long title of a pull request widens the popup, not the tool window.
            bases.setMinimumAndPreferredWidth(JBUI.scale(120));
            bases.addActionListener(e -> chooseBase());
            JPanel base = new JPanel(new BorderLayout(JBUI.scale(8), 0));
            base.add(new JBLabel("Base"), BorderLayout.WEST);
            base.add(bases, BorderLayout.CENTER);

            threadsInEditor.setSelected(service.threadsInEditor());
            threadsInEditor.addActionListener(e -> WriteIntentReadAction.run(() -> service.threadsInEditor(threadsInEditor.isSelected())));
            resolvedToo.setSelected(service.resolvedToo());
            resolvedToo.addActionListener(e -> WriteIntentReadAction.run(() -> {
                service.resolvedToo(resolvedToo.isSelected());
                show(state, true);
            }));
            JPanel toggles = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(12), 0));
            toggles.add(threadsInEditor);
            toggles.add(resolvedToo);

            ButtonGroup views = new ButtonGroup();
            views.add(editorView);
            views.add(diffView);
            (service.diffView() ? diffView : editorView).setSelected(true);
            editorView.addActionListener(e -> view(false));
            diffView.addActionListener(e -> view(true));
            JPanel view = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(12), 0));
            view.add(new JBLabel("Open files in"));
            view.add(editorView);
            view.add(diffView);
            editorView.setToolTipText("Double-click opens a file in the editor, with its threads");
            diffView.setToolTipText("Double-click opens a file in the diff, and each file has its Viewed checkbox, as in a pull request");

            ClientProperty.put(send, DarculaButtonUI.DEFAULT_STYLE_KEY, true);
            // Bare Swing listeners: saving the documents before a Send needs the write-intent lock.
            send.addActionListener(e -> {
                send.setEnabled(false);
                ThreadView.spin(send, true, AllIcons.Actions.Upload);
                WriteIntentReadAction.run(() -> ReviewDiffAction.send(project, state.id(), null, ReviewService.SENT_FROM_TOOL_WINDOW, service::refresh));
            });
            approve.addActionListener(e -> ReviewDiffAction.approve(project, state.id(), service::refresh));
            JPanel buttons = new JPanel(new GridLayout(1, 2, JBUI.scale(8), 0));
            buttons.add(send);
            buttons.add(approve);

            summary.setForeground(JBColor.GRAY);
            header.add(base);
            header.add(view);
            header.add(toggles);
            header.add(buttons);
            header.add(summary);
            startClaude.setOpaque(false);
            header.add(startClaude);
            header.setBorder(JBUI.Borders.empty(8));

            start.addActionListener(e -> service.start());
            emptyText.setVerticalAlignment(SwingConstants.TOP);
            empty.add(emptyText);
            empty.add(start);
            empty.setBorder(JBUI.Borders.empty(12));

            tree.setRootVisible(false);
            tree.setCellRenderer(new Renderer());
            new DoubleClickListener() {
                @Override
                protected boolean onDoubleClick(MouseEvent event) {
                    if (checkbox(event) == null) openSelected(service.diffView(), true);
                    return true;
                }
            }.installOn(tree);
            tree.addMouseListener(new MouseAdapter() {
                @Override
                public void mousePressed(MouseEvent event) {
                    JsonObject file = checkbox(event);
                    if (file == null) return;
                    event.consume();
                    toggleViewed(file);
                }
            });
            tree.addKeyListener(new KeyAdapter() {
                @Override
                public void keyPressed(KeyEvent e) {
                    if (e.getKeyCode() == KeyEvent.VK_ENTER) openSelected(service.diffView(), true);
                    if (e.getKeyCode() == KeyEvent.VK_SPACE && selectedFile() != null) toggleViewed(selectedFile());
                }
            });
            DefaultActionGroup menu = new DefaultActionGroup(
                DumbAwareAction.create("Open", event -> openSelected(false, true)),
                DumbAwareAction.create("Show Diff", AllIcons.Actions.Diff, event -> openSelected(true, true)),
                DumbAwareAction.create("Toggle Viewed", event -> {
                    if (selectedFile() != null) toggleViewed(selectedFile());
                }));
            PopupHandler.installPopupMenu(tree, menu, "LocalReviewsFiles");
            // A click, or the arrows, show the file or the thread selected, the focus kept in the tree; a double-click or Enter takes it there.
            tree.addTreeSelectionListener(e -> {
                if (!rebuilding) openSelected(service.diffView(), false);
            });

            service.listen(changed -> show(changed, false), toolWindow.getDisposable());
        }

        /** Shows the state: the files rebuilt only when they or their threads changed, or when `all`. */
        private void show(ReviewService.State changed, boolean all) {
            state = changed;
            removeAll();
            if (changed.session() == null) {
                emptyText.setText(changed.error() != null ? html(changed.error()) : "No review of this worktree yet.");
                start.setVisible(changed.error() == null);
                add(empty, BorderLayout.CENTER);
                revalidate();
                repaint();
                return;
            }
            add(header, BorderLayout.NORTH);
            add(new JBScrollPane(tree), BorderLayout.CENTER);

            int[] counts = Placement.counts(changed.session(), null);
            send.setText(counts[1] == 0 ? "Send" : "Send " + counts[1] + " pending");
            boolean claude = Placement.claude(changed.session());
            send.setEnabled(counts[1] > 0 && claude);
            ThreadView.spin(send, service.spinning(ReviewService.SENT_FROM_TOOL_WINDOW, null), AllIcons.Actions.Upload);
            // A Send without a Claude session in the worktree would wait for nobody: it says how to start one instead.
            startClaude.removeAll();
            if (!claude) startClaude.add(ThreadView.startClaude(changed.session()), BorderLayout.CENTER);
            summary.setForeground(changed.error() != null ? JBColor.RED : JBColor.GRAY);
            int viewed = 0;
            for (JsonElement file : changed.files()) {
                if (ReviewService.viewed(changed.session(), file.getAsJsonObject().get("path").getAsString())) viewed++;
            }
            summary.setText(changed.error() != null ? html(changed.error())
                : changed.files().size() + " files" + (service.diffView() ? " · " + viewed + " viewed" : "")
                    + " · " + counts[0] + " waiting for Claude");

            String key = changed.id() + "#" + changed.session().get("sends").getAsInt();
            if (!key.equals(basesOf)) {
                basesOf = key;
                loadBases(changed.id());
            } else {
                selectBase();
            }

            Object shown = List.of(changed.files(), changed.session().get("threads"));
            if (all || !shown.equals(shownKey)) {
                shownKey = shown;
                rebuild();
            }
            revalidate();
            repaint();
        }

        /** The files of the diff, then those only threads name, each with its threads. */
        private void rebuild() {
            Object selected = selected();
            DefaultMutableTreeNode root = new DefaultMutableTreeNode();
            Map<String, DefaultMutableTreeNode> dirs = new LinkedHashMap<>();
            DefaultMutableTreeNode reselect = null;
            Map<String, JsonObject> files = new LinkedHashMap<>();
            for (JsonElement element : state.files()) files.put(element.getAsJsonObject().get("path").getAsString(), element.getAsJsonObject());
            for (JsonElement element : state.session().getAsJsonArray("threads")) {
                // A thread out of the diff: its file is unchanged against the base.
                files.computeIfAbsent(element.getAsJsonObject().getAsJsonObject("anchor").get("path").getAsString(), path -> {
                    JsonObject unchanged = new JsonObject();
                    unchanged.addProperty("path", path);
                    unchanged.addProperty("status", "unchanged");
                    unchanged.add("hunks", new JsonArray());
                    return unchanged;
                });
            }
            for (JsonObject file : files.values()) {
                String path = file.get("path").getAsString();
                int cut = path.lastIndexOf('/');
                DefaultMutableTreeNode parent = cut < 0 ? root : dirs.computeIfAbsent(path.substring(0, cut), dir -> {
                    DefaultMutableTreeNode node = new DefaultMutableTreeNode(new Dir(dir));
                    root.add(node);
                    return node;
                });
                DefaultMutableTreeNode node = new DefaultMutableTreeNode(file);
                List<JsonObject> threads = threads(path);
                // A file that only Resolved threads name, Resolved ones hidden.
                if (threads.isEmpty() && file.get("status").getAsString().equals("unchanged")) continue;
                parent.add(node);
                if (path.equals(selected)) reselect = node;
                for (JsonObject thread : threads) {
                    DefaultMutableTreeNode child = new DefaultMutableTreeNode(new ThreadNode(thread));
                    node.add(child);
                    if (thread.get("id").getAsInt() == (selected instanceof Integer id ? id : 0)) reselect = child;
                }
            }
            rebuilding = true;
            tree.setModel(new DefaultTreeModel(root));
            TreeUtil.expandAll(tree);
            if (reselect != null) TreeUtil.selectNode(tree, reselect);
            rebuilding = false;
        }

        private void loadBases(String id) {
            ReviewDiffAction.background(project, () -> {
                List<JsonObject> loaded = Server.getArray("/api/sessions/" + id + "/bases");
                ApplicationManager.getApplication().invokeLater(() -> {
                    updating = true;
                    bases.removeAllItems();
                    for (JsonObject base : loaded) bases.addItem(base);
                    updating = false;
                    selectBase();
                });
            });
        }

        private void selectBase() {
            updating = true;
            for (int i = 0; i < bases.getItemCount(); i++) {
                if (bases.getItemAt(i).get("ref").getAsString().equals(state.ref())) bases.setSelectedIndex(i);
            }
            updating = false;
        }

        private void chooseBase() {
            JsonObject chosen = (JsonObject) bases.getSelectedItem();
            if (updating || chosen == null || state.id() == null || chosen.get("ref").getAsString().equals(state.ref())) return;
            if (disabled(chosen)) {
                selectBase();
                return;
            }
            JsonObject body = new JsonObject();
            body.add("base", chosen.get("ref"));
            ReviewDiffAction.background(project, () -> {
                Server.post("/api/sessions/" + state.id() + "/base", body);
                service.refresh();
            });
        }

        private void view(boolean diff) {
            service.diffView(diff);
            show(state, true);
        }

        /** The file of the diff whose Viewed checkbox `event` is on, in the Diff view; null elsewhere. */
        private JsonObject checkbox(MouseEvent event) {
            if (!service.diffView()) return null;
            TreePath path = tree.getPathForLocation(event.getX(), event.getY());
            if (path == null || !(((DefaultMutableTreeNode) path.getLastPathComponent()).getUserObject() instanceof JsonObject file) || !checkable(file)) return null;
            Rectangle bounds = tree.getPathBounds(path);
            return bounds != null && event.getX() < bounds.x + CHECKBOX.getIconWidth() + JBUI.scale(4) ? file : null;
        }

        private JsonObject selectedFile() {
            DefaultMutableTreeNode node = (DefaultMutableTreeNode) tree.getLastSelectedPathComponent();
            return node != null && node.getUserObject() instanceof JsonObject file && checkable(file) ? file : null;
        }

        private void toggleViewed(JsonObject file) {
            String path = file.get("path").getAsString();
            WriteIntentReadAction.run(() -> ReviewDiffAction.markViewed(project, state.id(), path, !ReviewService.viewed(state.session(), path), service::refresh));
        }

        /** A file of the diff: a file that only threads name has nothing to view. */
        private static boolean checkable(JsonObject file) {
            return !file.get("status").getAsString().equals("unchanged");
        }

        private static String group(JsonObject base) {
            return base.get("group") instanceof JsonPrimitive group ? group.getAsString() : null;
        }

        /** The threads of `path` the tool window shows: Resolved ones only with « Show resolved ». */
        private List<JsonObject> threads(String path) {
            List<JsonObject> threads = new ArrayList<>();
            for (JsonElement element : state.session().getAsJsonArray("threads")) {
                JsonObject thread = element.getAsJsonObject();
                if (!thread.getAsJsonObject("anchor").get("path").getAsString().equals(path)) continue;
                if (service.resolvedToo() || !thread.get("resolved").getAsBoolean()) threads.add(thread);
            }
            return threads;
        }

        /** The path of the selected file, or the id of the selected thread. */
        private Object selected() {
            DefaultMutableTreeNode node = (DefaultMutableTreeNode) tree.getLastSelectedPathComponent();
            if (node != null && node.getUserObject() instanceof JsonObject file) return file.get("path").getAsString();
            if (node != null && node.getUserObject() instanceof ThreadNode shown) return shown.thread().get("id").getAsInt();
            return null;
        }

        /**
         * Opens the selected file in the editor at its first thread, else at its first added line; a deleted file, or `diff`, in the diff.
         * A thread opens where its code is: the editor for the new code, the diff for the old one, its own window when Outdated and `focus`.
         * The focus goes there when `focus`, else stays in the tree.
         */
        private void openSelected(boolean diff, boolean focus) {
            DefaultMutableTreeNode node = (DefaultMutableTreeNode) tree.getLastSelectedPathComponent();
            if (node != null && node.getUserObject() instanceof ThreadNode shown) {
                openThread(shown.thread(), diff, focus);
                return;
            }
            if (node == null || !(node.getUserObject() instanceof JsonObject file)) return;
            String path = file.get("path").getAsString();
            VirtualFile local = LocalFileSystem.getInstance().refreshAndFindFileByPath(state.root() + "/" + path);
            if (diff || local == null || file.get("status").getAsString().equals("deleted")) {
                ReviewDiffAction.open(project, path, Side.RIGHT, -1, focus);
                return;
            }
            new OpenFileDescriptor(project, local, firstLine(file) - 1, 0).navigate(focus);
        }

        private void openThread(JsonObject thread, boolean diff, boolean focus) {
            JsonObject anchor = thread.getAsJsonObject("anchor");
            String path = anchor.get("path").getAsString();
            if (!(thread.get("at") instanceof JsonObject at)) {
                // A window of its own: not at each move of the selection.
                if (focus) OutdatedThread.open(project, thread);
                return;
            }
            int start = at.get("start").getAsInt();
            boolean old = anchor.get("side").getAsString().equals("old");
            VirtualFile local = old ? null : LocalFileSystem.getInstance().refreshAndFindFileByPath(state.root() + "/" + path);
            if (diff || local == null) ReviewDiffAction.open(project, path, old ? Side.LEFT : Side.RIGHT, start, focus);
            else new OpenFileDescriptor(project, local, start - 1, 0).navigate(focus);
        }

        private int firstLine(JsonObject file) {
            List<JsonObject> threads = Placement.threads(state.session(), file.get("path").getAsString(), "new");
            if (!threads.isEmpty()) return threads.get(0).getAsJsonObject("at").get("start").getAsInt();
            for (JsonElement hunk : file.getAsJsonArray("hunks")) {
                for (JsonElement line : hunk.getAsJsonObject().getAsJsonArray("lines")) {
                    if (line.getAsJsonObject().get("type").getAsString().equals("add")) return line.getAsJsonObject().get("newNo").getAsInt();
                }
            }
            return 1;
        }

        private static boolean disabled(JsonObject base) {
            JsonElement disabled = base.get("disabled");
            return disabled != null && disabled.getAsBoolean();
        }

        private static String html(String text) {
            return "<html>" + text.replace("&", "&amp;").replace("<", "&lt;") + "</html>";
        }

        /** A directory in grey; a file colored by its status, then its threads by status. */
        private final class Renderer extends ColoredTreeCellRenderer {
            private static final long serialVersionUID = 1L;

            @Override
            public void customizeCellRenderer(JTree tree, Object value, boolean selected, boolean expanded, boolean leaf, int row, boolean hasFocus) {
                Object shown = ((DefaultMutableTreeNode) value).getUserObject();
                if (shown instanceof Dir dir) {
                    setIcon(AllIcons.Nodes.Folder);
                    append(dir.path(), SimpleTextAttributes.GRAYED_ATTRIBUTES);
                    return;
                }
                if (shown instanceof ThreadNode node) {
                    thread(node.thread());
                    return;
                }
                if (!(shown instanceof JsonObject file)) return;
                String path = file.get("path").getAsString();
                String name = path.substring(path.lastIndexOf('/') + 1);
                String status = file.get("status").getAsString();
                boolean viewed = ReviewService.viewed(state.session(), path);
                Icon icon = FileTypeManager.getInstance().getFileTypeByFileName(name).getIcon();
                // The Diff view, as a pull request: a Viewed checkbox before each file of the diff, and a viewed file in grey.
                setIcon(service.diffView() && checkable(file) ? new RowIcon(viewed ? CHECKED : CHECKBOX, icon) : icon);
                FileStatus color = switch (status) {
                    case "added" -> FileStatus.ADDED;
                    case "deleted" -> FileStatus.DELETED;
                    case "unchanged" -> FileStatus.NOT_CHANGED;
                    default -> FileStatus.MODIFIED;
                };
                append(name, new SimpleTextAttributes(status.equals("deleted") ? SimpleTextAttributes.STYLE_STRIKEOUT : SimpleTextAttributes.STYLE_PLAIN,
                    service.diffView() && viewed ? JBColor.GRAY : color.getColor()));
                int[] counts = Placement.counts(state.session(), path);
                if (counts[0] > 0) append("  " + counts[0] + " waiting for Claude", SimpleTextAttributes.GRAYED_ATTRIBUTES);
                if (counts[1] > 0) append("  " + counts[1] + " pending", new SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, AMBER));
                if (counts[2] > 0 && service.resolvedToo()) append("  " + counts[2] + " resolved", SimpleTextAttributes.GRAYED_ATTRIBUTES);
            }

            /** « #12 · Line -5 · Pending · old code », the status, if any, in the color of the file's counts. */
            private void thread(JsonObject thread) {
                String status = ThreadView.status(thread);
                setIcon(status.equals("Resolved") ? AllIcons.Actions.Checked : AllIcons.Toolwindows.ToolWindowMessages);
                append("#" + thread.get("id").getAsInt() + " · " + ThreadView.lines(thread));
                if (!status.isEmpty()) append(" · " + status, status.equals("Pending") ? new SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, AMBER) : SimpleTextAttributes.GRAYED_ATTRIBUTES);
                if (thread.getAsJsonObject("anchor").get("side").getAsString().equals("old")) append(" · old code", SimpleTextAttributes.GRAYED_ATTRIBUTES);
                if (!(thread.get("at") instanceof JsonObject)) append(" · Outdated", SimpleTextAttributes.ERROR_ATTRIBUTES);
            }
        }
    }
}
