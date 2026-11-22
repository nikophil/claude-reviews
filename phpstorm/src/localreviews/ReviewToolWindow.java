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
import com.intellij.diff.tools.util.DiffDataKeys;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.DefaultActionGroup;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.WriteIntentReadAction;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorKind;
import com.intellij.openapi.editor.markup.InspectionWidgetActionProvider;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.ide.CopyPasteManager;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.DumbAwareToggleAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.ComboBox;
import com.intellij.openapi.vcs.FileStatus;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.openapi.wm.ToolWindowManager;
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
import com.intellij.ui.content.Content;
import com.intellij.ui.treeStructure.Tree;
import com.intellij.util.ui.JBUI;

import javax.swing.ButtonGroup;
import javax.swing.DefaultComboBoxModel;
import javax.swing.Icon;
import javax.swing.JButton;
import javax.swing.JPanel;
import javax.swing.JTree;
import javax.swing.SwingConstants;
import javax.swing.tree.DefaultMutableTreeNode;
import javax.swing.tree.DefaultTreeModel;
import javax.swing.tree.TreeNode;
import javax.swing.tree.TreePath;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.FlowLayout;
import java.awt.GridLayout;
import java.awt.Rectangle;
import java.awt.datatransfer.StringSelection;
import java.awt.event.MouseAdapter;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.LinkedHashMap;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/** The review of the worktree, on the left: its base, Send and Approve, and its changed files with their threads. */
public final class ReviewToolWindow implements ToolWindowFactory, DumbAware {
    private static final Color AMBER = new JBColor(new Color(0x8A5A00), new Color(0xE8B05A));
    private static final Color REPLIED = new JBColor(new Color(0x0969DA), new Color(0x4493F8));
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

    static final String BLOCKED = "Claude is waiting for your answer in its session, to a permission or a question, before it replies in the threads.";

    @Override
    public void createToolWindowContent(Project project, ToolWindow toolWindow) {
        Panel panel = new Panel(project, toolWindow);
        toolWindow.getContentManager().addContent(ContentFactory.getInstance().createContent(panel, "", false));
        // As in the Commit tool window: its files in the tree of their directories, or flat.
        DefaultActionGroup groupBy = DefaultActionGroup.createPopupGroup(() -> "Group By");
        groupBy.getTemplatePresentation().setIcon(AllIcons.Actions.GroupBy);
        groupBy.add(new DumbAwareToggleAction("Directory") {
            @Override
            public ActionUpdateThread getActionUpdateThread() {
                return ActionUpdateThread.EDT;
            }

            @Override
            public boolean isSelected(AnActionEvent event) {
                return ReviewService.get(project).groupByDirectory();
            }

            @Override
            public void setSelected(AnActionEvent event, boolean grouped) {
                panel.groupByDirectory(grouped);
            }
        });
        ActionManager actions = ActionManager.getInstance();
        toolWindow.setTitleActions(List.of(
            groupBy,
            actions.getAction("localreviews.ReviewDiff"),
            actions.getAction("localreviews.PreviousThread"),
            actions.getAction("localreviews.NextThread"),
            DumbAwareAction.create("Copy Threads as Markdown", AllIcons.Actions.Copy, event -> {
                JsonObject session = ReviewService.get(project).state().session();
                String markdown = session == null ? "" : ThreadView.markdown(session);
                if (markdown.isEmpty()) ReviewDiffAction.notify(project, "No thread with a sent message to copy", null);
                else CopyPasteManager.getInstance().setContents(new StringSelection(markdown));
            }),
            DumbAwareAction.create("Refresh", AllIcons.Actions.Refresh, event -> ReviewService.get(project).refresh())));
    }

    /** « Next Thread »: the next thread not Resolved in the tree of the tool window, after its selection, around at the end; opened as a click opens it. */
    public static class NextThread extends DumbAwareAction {
        private final boolean forward;

        public NextThread() {
            this(true);
        }

        NextThread(boolean forward) {
            this.forward = forward;
        }

        @Override
        public ActionUpdateThread getActionUpdateThread() {
            return ActionUpdateThread.BGT;
        }

        @Override
        public void update(AnActionEvent event) {
            event.getPresentation().setEnabled(event.getProject() != null && ReviewService.get(event.getProject()).state().session() != null);
        }

        @Override
        public void actionPerformed(AnActionEvent event) {
            Panel panel = event.getProject() == null ? null : panel(event.getProject());
            if (panel == null) return;
            // Where it was clicked or pressed: a diff, an editor, else the view of the tool window.
            Editor editor = event.getData(CommonDataKeys.EDITOR);
            boolean diff = event.getData(DiffDataKeys.DIFF_REQUEST) != null
                || (editor == null || editor.getEditorKind() != EditorKind.MAIN_EDITOR) && ReviewService.get(event.getProject()).diffView();
            panel.step(forward, diff);
        }
    }

    /** The panel of the tool window of `project`, null without one. */
    private static Panel panel(Project project) {
        ToolWindow window = ToolWindowManager.getInstance(project).getToolWindow("Claude Reviews");
        // The content of a tool window never shown is made here.
        Content content = window == null ? null : window.getContentManager().getContent(0);
        return content != null && content.getComponent() instanceof Panel panel ? panel : null;
    }

    /** Once `path` is marked Viewed in the bar of the diff: selects the next file not Viewed of the tree, for the diff to show; null without one. */
    static String viewedNext(Project project, String path) {
        Panel panel = panel(project);
        return panel == null ? null : panel.viewedNext(path, true);
    }

    /** « Previous Thread »: as Next Thread, backward. */
    public static final class PreviousThread extends NextThread {
        public PreviousThread() {
            super(false);
        }
    }

    /** Previous Thread and Next Thread in the bar at the top right of the editor of a file of the review, beside the arrows of its problems. */
    public static final class EditorArrows implements InspectionWidgetActionProvider {
        @Override
        public AnAction createAction(Editor editor) {
            // The editors of a diff have the arrows in the toolbar of the diff.
            if (editor.getEditorKind() != EditorKind.MAIN_EDITOR) return null;
            ActionManager actions = ActionManager.getInstance();
            return new DefaultActionGroup(actions.getAction("localreviews.PreviousThread"), actions.getAction("localreviews.NextThread")) {
                @Override
                public ActionUpdateThread getActionUpdateThread() {
                    return ActionUpdateThread.BGT;
                }

                @Override
                public void update(AnActionEvent event) {
                    List<Threads> threads = editor.getUserData(Threads.KEY);
                    ReviewService.State state = editor.getProject() == null ? null : ReviewService.get(editor.getProject()).state();
                    event.getPresentation().setVisible(threads != null && state != null && state.session() != null
                        && Placement.navigable(state.session(), state.files(), threads.get(0).review().path()));
                }
            };
        }
    }

    /** A directory of the tree of the tool window: its path, and its name there, which takes those of the directories it merges. */
    record Dir(String path, String name) {
        /**
         * Moves the files under `root` into the tree of their directories, as the Commit tool window groups them:
         * the directories before the files, and a directory that holds only a directory merged with it (`src/Mapping`).
         */
        static void group(DefaultMutableTreeNode root) {
            Map<String, DefaultMutableTreeNode> dirs = new HashMap<>(Map.of("", root));
            for (TreeNode file : Collections.list(root.children())) {
                String path = ((JsonObject) ((DefaultMutableTreeNode) file).getUserObject()).get("path").getAsString();
                directory(dirs, path.substring(0, Math.max(path.lastIndexOf('/'), 0))).add((DefaultMutableTreeNode) file);
            }
            merge(root);
        }

        /** The node of the directory `path`, made with those of its parents, after the directories and before the files of its parent. */
        private static DefaultMutableTreeNode directory(Map<String, DefaultMutableTreeNode> dirs, String path) {
            DefaultMutableTreeNode node = dirs.get(path);
            if (node != null) return node;
            int cut = path.lastIndexOf('/');
            DefaultMutableTreeNode parent = directory(dirs, cut < 0 ? "" : path.substring(0, cut));
            node = new DefaultMutableTreeNode(new Dir(path, path.substring(cut + 1)));
            int at = 0;
            while (at < parent.getChildCount() && ((DefaultMutableTreeNode) parent.getChildAt(at)).getUserObject() instanceof Dir) at++;
            parent.insert(node, at);
            dirs.put(path, node);
            return node;
        }

        private static void merge(DefaultMutableTreeNode node) {
            for (int i = 0; i < node.getChildCount(); i++) {
                DefaultMutableTreeNode child = (DefaultMutableTreeNode) node.getChildAt(i);
                while (child.getUserObject() instanceof Dir dir && child.getChildCount() == 1
                    && ((DefaultMutableTreeNode) child.getFirstChild()).getUserObject() instanceof Dir inner) {
                    DefaultMutableTreeNode merged = (DefaultMutableTreeNode) child.getFirstChild();
                    merged.setUserObject(new Dir(inner.path(), dir.name() + "/" + inner.name()));
                    node.remove(i);
                    node.insert(merged, i);
                    child = merged;
                }
                merge(child);
            }
        }
    }

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
        /** How to start a Claude session, or the warning that the Claude session waits for my answer; empty otherwise. */
        private final JPanel notice = new JPanel(new BorderLayout());
        private final JBLabel blocked = new JBLabel("<html>" + BLOCKED + "</html>", AllIcons.General.Warning, SwingConstants.LEFT);
        private final Tree tree = new Tree(new DefaultTreeModel(new DefaultMutableTreeNode()));
        // Made once: a new one at each change of the state would scroll back to the top, and take the focus from the tree.
        private final JBScrollPane scroll = new JBScrollPane(tree);
        private final JPanel header = new JPanel(new VerticalLayout(JBUI.scale(8)));
        private final JPanel empty = new JPanel(new VerticalLayout(JBUI.scale(8)));
        private final JBLabel emptyText = new JBLabel();
        private final JButton start = new JButton("Start review");
        private transient ReviewService.State state = ReviewService.State.NONE;
        private transient String basesOf;
        private transient Object shownKey;
        private boolean updating;
        private boolean rebuilding;
        /** Whether the tool window showed a session that is now closed: approved, or its worktree gone. */
        private boolean closed;
        /** The button whose write runs, Send or Approve, greyed with the other until it ends; null without one. */
        private JButton writing;

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
                write(send);
                WriteIntentReadAction.run(() -> ReviewDiffAction.send(project, state.id(), null, ReviewService.SENT_FROM_TOOL_WINDOW, this::written));
            });
            approve.addActionListener(e -> {
                write(approve);
                ReviewDiffAction.approve(project, state.id(), this::written);
            });
            JPanel buttons = new JPanel(new GridLayout(1, 2, JBUI.scale(8), 0));
            buttons.add(send);
            buttons.add(approve);

            summary.setForeground(JBColor.GRAY);
            header.add(base);
            header.add(view);
            header.add(toggles);
            header.add(buttons);
            header.add(summary);
            notice.setOpaque(false);
            header.add(notice);
            header.setBorder(JBUI.Borders.empty(8));

            start.addActionListener(e -> service.start());
            emptyText.setVerticalAlignment(SwingConstants.TOP);
            empty.add(emptyText);
            empty.add(start);
            empty.setBorder(JBUI.Borders.empty(12));

            tree.setRootVisible(false);
            tree.setCellRenderer(new Renderer());
            // A double click opens a file or a thread, and only folds a directory.
            tree.setToggleClickCount(0);
            new DoubleClickListener() {
                @Override
                protected boolean onDoubleClick(MouseEvent event) {
                    TreePath path = tree.getPathForLocation(event.getX(), event.getY());
                    if (path != null && ((DefaultMutableTreeNode) path.getLastPathComponent()).getUserObject() instanceof Dir) {
                        if (tree.isExpanded(path)) tree.collapsePath(path);
                        else tree.expandPath(path);
                    } else if (checkbox(event) == null) {
                        WriteIntentReadAction.run(() -> openSelected(service.diffView(), true, true));
                    }
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
                    if (e.getKeyCode() == KeyEvent.VK_ENTER) WriteIntentReadAction.run(() -> openSelected(service.diffView(), true, true));
                    if (e.getKeyCode() == KeyEvent.VK_SPACE && selectedFile() != null) toggleViewed(selectedFile());
                }
            });
            DefaultActionGroup menu = new DefaultActionGroup(
                DumbAwareAction.create("Open", event -> openSelected(false, true, true)),
                DumbAwareAction.create("Show Diff", AllIcons.Actions.Diff, event -> openSelected(true, true, false)),
                new DumbAwareAction("Resolve") {
                    @Override
                    public ActionUpdateThread getActionUpdateThread() {
                        return ActionUpdateThread.EDT;
                    }

                    @Override
                    public void update(AnActionEvent event) {
                        JsonObject thread = selectedThread();
                        event.getPresentation().setEnabledAndVisible(thread != null && !Placement.approved(state.session()));
                        if (thread != null) event.getPresentation().setText(thread.get("resolved").getAsBoolean() ? "Unresolve" : "Resolve");
                    }

                    @Override
                    public void actionPerformed(AnActionEvent event) {
                        JsonObject thread = selectedThread();
                        if (thread == null) return;
                        String route = "/api/sessions/" + state.id() + "/threads/" + thread.get("id").getAsInt() + (thread.get("resolved").getAsBoolean() ? "/unresolve" : "/resolve");
                        ReviewDiffAction.background(project, () -> {
                            Server.post(route, new JsonObject());
                            service.refresh();
                        });
                    }
                },
                new DumbAwareAction("Toggle Viewed") {
                    @Override
                    public ActionUpdateThread getActionUpdateThread() {
                        return ActionUpdateThread.EDT;
                    }

                    @Override
                    public void update(AnActionEvent event) {
                        event.getPresentation().setEnabledAndVisible(selectedFile() != null);
                    }

                    @Override
                    public void actionPerformed(AnActionEvent event) {
                        if (selectedFile() != null) toggleViewed(selectedFile());
                    }
                },
                new DumbAwareAction("Comment on File") {
                    @Override
                    public ActionUpdateThread getActionUpdateThread() {
                        return ActionUpdateThread.EDT;
                    }

                    @Override
                    public void update(AnActionEvent event) {
                        event.getPresentation().setEnabledAndVisible(local() != null);
                    }

                    // ponytail: in the editor, even in the Diff view; a deleted file takes its thread from the context menu of its diff.
                    @Override
                    public void actionPerformed(AnActionEvent event) {
                        VirtualFile local = local();
                        Editor editor = local == null ? null : FileEditorManager.getInstance(project).openTextEditor(new OpenFileDescriptor(project, local, 0, 0), false);
                        List<Threads> threads = editor == null ? null : editor.getUserData(Threads.KEY);
                        if (threads != null) threads.get(0).draft(0, 0);
                    }
                });
            PopupHandler.installPopupMenu(tree, menu, "LocalReviewsFiles");
            // A click, or the arrows, show the file or the thread selected, the focus kept in the tree; a double-click or Enter takes it there.
            // Bare Swing listeners: finding a file the VFS does not know yet, as one Claude just wrote, refreshes it under the write-intent lock.
            tree.addTreeSelectionListener(e -> {
                if (!rebuilding) WriteIntentReadAction.run(() -> openSelected(service.diffView(), false, false));
            });

            service.listen(changed -> show(changed, false), toolWindow.getDisposable());
        }

        private void write(JButton button) {
            writing = button;
            buttons();
        }

        private void written() {
            writing = null;
            buttons();
            service.refresh();
        }

        /** Send and Approve, greyed with why during a write and as the session refuses them; Send spins while it runs, then while Claude answers. */
        private void buttons() {
            if (state.session() == null) return;
            String sendRefusal = Placement.sendRefusal(state.session());
            String approveRefusal = Placement.approveRefusal(state.session());
            send.setEnabled(writing == null && sendRefusal == null);
            send.setToolTipText(sendRefusal != null ? sendRefusal : Placement.sendWarning(state.session()));
            approve.setEnabled(writing == null && approveRefusal == null);
            approve.setToolTipText(approveRefusal);
            ThreadView.spin(send, writing == send || service.spinning(ReviewService.SENT_FROM_TOOL_WINDOW, null), AllIcons.Actions.Upload);
        }

        /** Shows the state: the files rebuilt only when they or their threads changed, or when `all`. */
        private void show(ReviewService.State changed, boolean all) {
            closed = changed.session() == null && (closed || state.session() != null);
            state = changed;
            if (changed.session() == null) {
                // The tree, hidden below, repaints as it loses the focus: it holds no thread of the session gone, approved, to render against none.
                if (shownKey != null) {
                    rebuilding = true;
                    try {
                        tree.setModel(new DefaultTreeModel(new DefaultMutableTreeNode()));
                    } finally {
                        rebuilding = false;
                    }
                    shownKey = null;
                }
                emptyText.setText(changed.error() != null ? html(changed.error()) : closed ? "The review of this worktree is closed." : "No review of this worktree yet.");
                start.setVisible(changed.error() == null);
                if (empty.getParent() != this) {
                    removeAll();
                    add(empty, BorderLayout.CENTER);
                }
                revalidate();
                repaint();
                return;
            }
            if (header.getParent() != this) {
                removeAll();
                add(header, BorderLayout.NORTH);
                add(scroll, BorderLayout.CENTER);
            }

            int[] counts = Placement.counts(changed.session(), null);
            send.setText(counts[1] == 0 ? "Send" : "Send " + counts[1] + " pending");
            boolean claude = Placement.claude(changed.session());
            buttons();
            // A Send without a Claude session in the worktree waits for one: it says how to start one.
            notice.removeAll();
            if (!claude) notice.add(ThreadView.startClaude(changed.session()), BorderLayout.CENTER);
            else if (Placement.blocked(changed.session())) notice.add(blocked, BorderLayout.CENTER);
            summary.setForeground(changed.error() != null ? JBColor.RED : JBColor.GRAY);
            int viewed = 0;
            for (JsonElement file : changed.files()) {
                if (ReviewService.viewed(changed.session(), file.getAsJsonObject().get("path").getAsString())) viewed++;
            }
            summary.setText(changed.error() != null ? html(changed.error())
                : changed.files().size() + " files" + (service.diffView() ? " · " + viewed + " viewed" : "")
                    + " · " + counts[0] + " waiting for Claude");

            // Loaded again at each Send, for « Since my last review », and for a base chosen elsewhere that the list does not have yet.
            boolean listed = false;
            for (int i = 0; i < bases.getItemCount(); i++) listed |= bases.getItemAt(i).get("ref").getAsString().equals(changed.ref());
            String key = changed.id() + "#" + changed.session().get("sends").getAsInt() + (listed ? "" : "#" + changed.ref());
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

        /** The files of the diff, then those only threads name, each with its threads: the nodes collapsed stay so, the selection stays. */
        private void rebuild() {
            Object selected = selected();
            Set<Object> collapsed = new HashSet<>();
            for (Enumeration<TreeNode> nodes = ((DefaultMutableTreeNode) tree.getModel().getRoot()).breadthFirstEnumeration(); nodes.hasMoreElements(); ) {
                DefaultMutableTreeNode node = (DefaultMutableTreeNode) nodes.nextElement();
                if (!node.isRoot() && !node.isLeaf() && !tree.isExpanded(new TreePath(node.getPath()))) collapsed.add(key(node));
            }
            DefaultMutableTreeNode root = new DefaultMutableTreeNode();
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
                DefaultMutableTreeNode node = new DefaultMutableTreeNode(file);
                List<JsonObject> threads = threads(path);
                // A file that only Resolved threads name, Resolved ones hidden.
                if (threads.isEmpty() && file.get("status").getAsString().equals("unchanged")) continue;
                root.add(node);
                if (path.equals(selected)) reselect = node;
                for (JsonObject thread : threads) {
                    DefaultMutableTreeNode child = new DefaultMutableTreeNode(new ThreadNode(thread));
                    node.add(child);
                    if (thread.get("id").getAsInt() == (selected instanceof Integer id ? id : 0)) reselect = child;
                }
            }
            if (service.groupByDirectory()) Dir.group(root);
            rebuilding = true;
            tree.setModel(new DefaultTreeModel(root));
            // Expanded again where it was, without scrolling to the nodes it expands.
            boolean scrolls = tree.getScrollsOnExpand();
            tree.setScrollsOnExpand(false);
            for (Enumeration<TreeNode> nodes = root.breadthFirstEnumeration(); nodes.hasMoreElements(); ) {
                DefaultMutableTreeNode node = (DefaultMutableTreeNode) nodes.nextElement();
                TreePath path = new TreePath(node.getPath());
                if (!node.isLeaf() && !collapsed.contains(key(node)) && (node.isRoot() || tree.isExpanded(path.getParentPath()))) tree.expandPath(path);
            }
            tree.setScrollsOnExpand(scrolls);
            if (reselect != null) tree.setSelectionPath(new TreePath(reselect.getPath()));
            rebuilding = false;
        }

        /** What a node of a directory or a file stays across rebuilds: its path. */
        private static Object key(DefaultMutableTreeNode node) {
            return node.getUserObject() instanceof JsonObject file ? file.get("path").getAsString() : node.getUserObject();
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

        void groupByDirectory(boolean grouped) {
            service.groupByDirectory(grouped);
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

        private JsonObject selectedThread() {
            DefaultMutableTreeNode node = (DefaultMutableTreeNode) tree.getLastSelectedPathComponent();
            return node != null && node.getUserObject() instanceof ThreadNode shown ? shown.thread() : null;
        }

        /** The selected file of the diff, which has a Viewed checkbox: in the Diff view only. */
        private JsonObject selectedFile() {
            DefaultMutableTreeNode node = (DefaultMutableTreeNode) tree.getLastSelectedPathComponent();
            return service.diffView() && node != null && node.getUserObject() instanceof JsonObject file && checkable(file) ? file : null;
        }

        /** The file of the worktree of the selected file node, null for another node or a file no longer there. */
        private VirtualFile local() {
            DefaultMutableTreeNode node = (DefaultMutableTreeNode) tree.getLastSelectedPathComponent();
            if (node == null || !(node.getUserObject() instanceof JsonObject file) || state.root() == null) return null;
            return LocalFileSystem.getInstance().findFileByPath(state.root() + "/" + file.get("path").getAsString());
        }

        /**
         * Selects and opens the next thread not Resolved after the selection of the tree, or the one before it, around at the ends:
         * as a click from the tree, which keeps the focus; from elsewhere, the focus goes to it, an Outdated one opening its window;
         * in the diff when `diff`, else in the editor.
         */
        void step(boolean forward, boolean diff) {
            // The tree of a tool window just made is still empty.
            if (state != service.state()) show(service.state(), false);
            List<DefaultMutableTreeNode> nodes = new ArrayList<>();
            for (Enumeration<TreeNode> all = ((DefaultMutableTreeNode) tree.getModel().getRoot()).preorderEnumeration(); all.hasMoreElements(); ) {
                nodes.add((DefaultMutableTreeNode) all.nextElement());
            }
            List<Boolean> stops = nodes.stream().map(node -> node.getUserObject() instanceof ThreadNode shown && !shown.thread().get("resolved").getAsBoolean()).toList();
            int next = Placement.step(stops, nodes.indexOf(tree.getLastSelectedPathComponent()), forward);
            if (next < 0) return;
            boolean focus = !tree.hasFocus();
            TreePath path = new TreePath(nodes.get(next).getPath());
            // Opened below, with the focus or not, rather than by the listener of the selection.
            rebuilding = true;
            tree.setSelectionPath(path);
            rebuilding = false;
            tree.scrollPathToVisible(path);
            openThread(((ThreadNode) nodes.get(next).getUserObject()).thread(), diff, focus, false);
        }

        private void toggleViewed(JsonObject file) {
            String path = file.get("path").getAsString();
            boolean viewed = !ReviewService.viewed(state.session(), path);
            WriteIntentReadAction.run(() -> ReviewDiffAction.markViewed(project, state.id(), path, viewed, service::refresh));
            if (viewed) viewedNext(path, false);
        }

        /**
         * Once `path` is marked Viewed, as in a pull request: selects the next file of the tree not Viewed, none after the last one, which opens as a click opens it, and returns its path;
         * `inDiff`, from the bar of the diff, only selects it, for the diff to show, a binary file left out as the diff leaves it out.
         */
        String viewedNext(String path, boolean inDiff) {
            if (state != service.state()) show(service.state(), false);
            boolean after = false;
            for (Enumeration<TreeNode> all = ((DefaultMutableTreeNode) tree.getModel().getRoot()).preorderEnumeration(); all.hasMoreElements(); ) {
                DefaultMutableTreeNode node = (DefaultMutableTreeNode) all.nextElement();
                if (!(node.getUserObject() instanceof JsonObject file) || !checkable(file)) continue;
                String next = file.get("path").getAsString();
                if (next.equals(path)) after = true;
                else if (after && !ReviewService.viewed(state.session(), next) && !(inDiff && file.get("binary").getAsBoolean())) {
                    TreePath selection = new TreePath(node.getPath());
                    rebuilding = inDiff;
                    tree.setSelectionPath(selection);
                    rebuilding = false;
                    tree.scrollPathToVisible(selection);
                    return next;
                }
            }
            return null;
        }

        /** A file of the diff: a file that only threads name has nothing to view. */
        private static boolean checkable(JsonObject file) {
            return !file.get("status").getAsString().equals("unchanged");
        }

        private static String group(JsonObject base) {
            return base.get("group") instanceof JsonPrimitive group ? group.getAsString() : null;
        }

        /** The threads of `path` the tool window shows, by line: Resolved ones only with « Show resolved ». */
        private List<JsonObject> threads(String path) {
            List<JsonObject> threads = new ArrayList<>();
            for (JsonElement element : state.session().getAsJsonArray("threads")) {
                JsonObject thread = element.getAsJsonObject();
                if (!thread.getAsJsonObject("anchor").get("path").getAsString().equals(path)) continue;
                if (service.resolvedToo() || !thread.get("resolved").getAsBoolean()) threads.add(thread);
            }
            return Placement.byLine(threads);
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
         * A thread opens where its code is: the editor for the new code, the diff for the old one, its own window when Outdated, or Resolved and `read`, and `focus`.
         * The focus goes there when `focus`, else stays in the tree.
         */
        private void openSelected(boolean diff, boolean focus, boolean read) {
            DefaultMutableTreeNode node = (DefaultMutableTreeNode) tree.getLastSelectedPathComponent();
            if (node != null && node.getUserObject() instanceof ThreadNode shown) {
                openThread(shown.thread(), diff, focus, read);
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

        private void openThread(JsonObject thread, boolean diff, boolean focus, boolean read) {
            JsonObject anchor = thread.getAsJsonObject("anchor");
            String path = anchor.get("path").getAsString();
            // A window of its own, where a Resolved thread shows unfolded, except for Show Diff: not at each move of the selection.
            if (focus && (!(thread.get("at") instanceof JsonObject) || read && thread.get("resolved").getAsBoolean())) {
                ThreadWindow.open(project, thread);
                return;
            }
            if (!(thread.get("at") instanceof JsonObject at)) return;
            // Opened, rather than left a pill while « Show threads » is off.
            service.open(state.id(), thread.get("id").getAsInt());
            // The first line for a thread on the whole file, above which it shows.
            int start = Math.max(at.get("start").getAsInt(), 1);
            boolean old = anchor.get("side").getAsString().equals("old");
            VirtualFile local = old ? null : LocalFileSystem.getInstance().refreshAndFindFileByPath(state.root() + "/" + path);
            if (diff || local == null) ReviewDiffAction.open(project, path, old ? Side.LEFT : Side.RIGHT, start, focus);
            else new OpenFileDescriptor(project, local, start - 1, 0).navigate(focus);
        }

        /** The first line of the first thread of the new side the editor shows, a Resolved one only with « Show resolved », else of the first added line. */
        private int firstLine(JsonObject file) {
            for (JsonObject thread : Placement.byLine(Placement.threads(state.session(), file.get("path").getAsString(), "new"))) {
                if (service.resolvedToo() || !thread.get("resolved").getAsBoolean()) return Math.max(thread.getAsJsonObject("at").get("start").getAsInt(), 1);
            }
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

        /** A directory in grey; a file colored by its status, followed by its directory in grey when not grouped by directory, then its threads by status. */
        private final class Renderer extends ColoredTreeCellRenderer {
            private static final long serialVersionUID = 1L;

            @Override
            public void customizeCellRenderer(JTree tree, Object value, boolean selected, boolean expanded, boolean leaf, int row, boolean hasFocus) {
                Object shown = ((DefaultMutableTreeNode) value).getUserObject();
                if (shown instanceof Dir dir) {
                    setIcon(AllIcons.Nodes.Folder);
                    append(dir.name(), SimpleTextAttributes.GRAYED_ATTRIBUTES);
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
                if (!service.groupByDirectory() && path.contains("/")) append("  " + path.substring(0, path.lastIndexOf('/')), SimpleTextAttributes.GRAYED_ATTRIBUTES);
                int[] counts = Placement.counts(state.session(), path);
                if (counts[0] > 0) append("  " + counts[0] + " waiting for Claude", SimpleTextAttributes.GRAYED_ATTRIBUTES);
                if (counts[1] > 0) append("  " + counts[1] + " pending", new SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, AMBER));
                if (counts[2] > 0 && service.resolvedToo()) append("  " + counts[2] + " resolved", SimpleTextAttributes.GRAYED_ATTRIBUTES);
            }

            /** « #12 · Line -5 · Pending · old code », the status, if any, in the color of the file's counts; « Replied » on a thread not Resolved where Claude wrote after my last sent message. */
            private void thread(JsonObject thread) {
                String status = ThreadView.status(thread);
                setIcon(status.equals("Resolved") ? AllIcons.Actions.Checked : AllIcons.Toolwindows.ToolWindowMessages);
                append("#" + thread.get("id").getAsInt() + " · " + ThreadView.lines(thread));
                if (!status.isEmpty()) append(" · " + status, status.equals("Pending") ? new SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, AMBER) : SimpleTextAttributes.GRAYED_ATTRIBUTES);
                if (Placement.replied(thread)) append(" · Replied", new SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, REPLIED));
                if (thread.getAsJsonObject("anchor").get("side").getAsString().equals("old")) append(" · old code", SimpleTextAttributes.GRAYED_ATTRIBUTES);
                if (!(thread.get("at") instanceof JsonObject)) append(" · Outdated", SimpleTextAttributes.ERROR_ATTRIBUTES);
            }
        }
    }
}
