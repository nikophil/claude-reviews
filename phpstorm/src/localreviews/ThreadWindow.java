package localreviews;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.util.Disposer;
import com.intellij.ui.EditorTextField;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.util.ui.JBUI;

import javax.swing.Action;
import javax.swing.JComponent;
import javax.swing.JPanel;
import javax.swing.Scrollable;
import java.awt.BorderLayout;
import java.awt.Dimension;
import java.awt.Rectangle;

/**
 * A thread in a window of its own: an Outdated one, whose lines no code shows any more, or a Resolved one, which the code shows folded.
 * The code it was opened on, its discussion and its field, kept up to date by the poll.
 */
final class ThreadWindow extends DialogWrapper {
    private final JPanel panel = new JPanel(new BorderLayout(0, JBUI.scale(12)));
    private final JPanel column = new Column();
    private final Project project;
    private final ReviewService service;
    private final int id;
    private ThreadView view;
    private JsonObject shown;
    private boolean claude;

    static void open(Project project, JsonObject thread) {
        new ThreadWindow(project, thread).show();
    }

    private ThreadWindow(Project project, JsonObject thread) {
        // Modeless: the code stays at hand while the thread is open.
        super(project, false, IdeModalityType.MODELESS);
        this.project = project;
        this.service = ReviewService.get(project);
        this.id = thread.get("id").getAsInt();
        JsonObject anchor = thread.getAsJsonObject("anchor");
        setTitle("Thread #" + id + " · " + anchor.get("path").getAsString() + (thread.get("at") instanceof JsonObject ? "" : " · Outdated"));
        // A thread on the whole file has no lines to show.
        if (anchor.get("end").getAsInt() > 0) panel.add(code(project, anchor), BorderLayout.NORTH);
        panel.add(new JBScrollPane(column), BorderLayout.CENTER);
        show(thread);
        service.listen(state -> {
            if (state.session() == null) return;
            for (JsonElement element : state.session().getAsJsonArray("threads")) {
                JsonObject fresh = element.getAsJsonObject();
                if (fresh.get("id").getAsInt() == id && (!fresh.equals(shown) || Placement.claude(state.session()) != claude)) show(fresh);
            }
        }, getDisposable());
        init();
    }

    private void show(JsonObject thread) {
        // Unfolded when it opens and once resolved: the window is there to read it.
        boolean unfold = shown == null || shown.get("resolved").getAsBoolean() != thread.get("resolved").getAsBoolean();
        shown = thread;
        claude = Placement.claude(service.state().session());
        ThreadView previous = view;
        view = new ThreadView(project, service.state().session(), thread, null, service::refresh);
        Disposer.register(getDisposable(), view);
        if (previous != null) {
            view.resume(previous);
            column.remove(previous);
            Disposer.dispose(previous);
        }
        if (unfold) view.unfold();
        column.add(view, BorderLayout.CENTER);
        column.revalidate();
        column.repaint();
    }

    /**
     * The diff the thread was opened on, from 3 lines above its range down to its last line, as GitHub shows it, rather than a whole added file;
     * else the lines of its Anchor when they were out of the diff.
     */
    private static JComponent code(Project project, JsonObject anchor) {
        StringBuilder text = new StringBuilder();
        JsonElement hunk = anchor.get("hunk");
        if (hunk instanceof JsonObject diff) {
            JsonArray lines = diff.getAsJsonArray("lines");
            String side = anchor.get("side").getAsString().equals("old") ? "oldNo" : "newNo";
            int from = 0;
            for (int i = lines.size() - 1; i >= 0 && from == 0; i--) {
                if (lines.get(i).getAsJsonObject().get(side) instanceof JsonPrimitive no && no.getAsInt() < anchor.get("start").getAsInt() - 3) from = i + 1;
            }
            // The header no longer counts the lines of a cut excerpt.
            if (from == 0) text.append(diff.get("header").getAsString()).append('\n');
            for (JsonElement element : lines.asList().subList(from, lines.size())) {
                JsonObject line = element.getAsJsonObject();
                String sign = switch (line.get("type").getAsString()) {
                    case "add" -> "+";
                    case "del" -> "-";
                    case "note" -> "\\ ";
                    default -> " ";
                };
                text.append(sign).append(line.get("text").getAsString()).append('\n');
            }
        } else {
            for (JsonElement line : anchor.getAsJsonArray("lines")) text.append(line.getAsString()).append('\n');
        }
        // The patch file type colors the added and deleted lines.
        EditorTextField code = new EditorTextField(EditorFactory.getInstance().createDocument(text.toString().stripTrailing()), project,
            hunk instanceof JsonObject ? FileTypeManager.getInstance().getFileTypeByExtension("patch")
                : FileTypeManager.getInstance().getFileTypeByFileName(anchor.get("path").getAsString()), true, false);
        code.setFontInheritedFromLAF(false);
        return code;
    }

    /** The thread at the width of the window, scrolled once it outgrows it: its texts wrap rather than scroll sideways. */
    private static final class Column extends JPanel implements Scrollable {
        private static final long serialVersionUID = 1L;

        Column() {
            super(new BorderLayout());
        }

        @Override
        public Dimension getPreferredScrollableViewportSize() {
            Dimension size = getPreferredSize();
            // A long thread opens the window at most this high.
            return new Dimension(size.width, Math.min(size.height, JBUI.scale(600)));
        }

        @Override
        public int getScrollableUnitIncrement(Rectangle visible, int orientation, int direction) {
            return JBUI.scale(16);
        }

        @Override
        public int getScrollableBlockIncrement(Rectangle visible, int orientation, int direction) {
            return visible.height;
        }

        @Override
        public boolean getScrollableTracksViewportWidth() {
            return true;
        }

        @Override
        public boolean getScrollableTracksViewportHeight() {
            return false;
        }
    }

    @Override
    protected JComponent createCenterPanel() {
        return panel;
    }

    @Override
    protected Action[] createActions() {
        getCancelAction().putValue(Action.NAME, "Close");
        return new Action[] {getCancelAction()};
    }
}
