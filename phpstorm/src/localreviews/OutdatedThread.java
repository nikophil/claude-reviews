package localreviews;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.util.Disposer;
import com.intellij.ui.EditorTextField;
import com.intellij.util.ui.JBUI;

import javax.swing.Action;
import javax.swing.JComponent;
import javax.swing.JPanel;
import java.awt.BorderLayout;

/** An Outdated thread, whose lines no code shows any more: the code it was opened on, its discussion and its field, kept up to date by the poll. */
final class OutdatedThread extends DialogWrapper {
    private final JPanel panel = new JPanel(new BorderLayout(0, JBUI.scale(12)));
    private final Project project;
    private final ReviewService service;
    private final int id;
    private ThreadView view;
    private JsonObject shown;

    static void open(Project project, JsonObject thread) {
        new OutdatedThread(project, thread).show();
    }

    private OutdatedThread(Project project, JsonObject thread) {
        // Modeless: the code stays at hand while the thread is open.
        super(project, false, IdeModalityType.MODELESS);
        this.project = project;
        this.service = ReviewService.get(project);
        this.id = thread.get("id").getAsInt();
        JsonObject anchor = thread.getAsJsonObject("anchor");
        setTitle("Thread #" + id + " · " + anchor.get("path").getAsString() + " · Outdated");
        panel.add(code(project, anchor), BorderLayout.NORTH);
        show(thread);
        service.listen(state -> {
            if (state.session() == null) return;
            for (JsonElement element : state.session().getAsJsonArray("threads")) {
                JsonObject fresh = element.getAsJsonObject();
                if (fresh.get("id").getAsInt() == id && !fresh.equals(shown)) show(fresh);
            }
        }, getDisposable());
        init();
    }

    private void show(JsonObject thread) {
        shown = thread;
        ThreadView previous = view;
        view = new ThreadView(project, service.state().id(), thread, service::refresh);
        Disposer.register(getDisposable(), view);
        if (previous != null) {
            view.resume(previous);
            panel.remove(previous);
            Disposer.dispose(previous);
        }
        panel.add(view, BorderLayout.CENTER);
        panel.revalidate();
        panel.repaint();
    }

    /** The diff the thread was opened on, down to its last line, else the lines of its Anchor when they were out of the diff. */
    private static JComponent code(Project project, JsonObject anchor) {
        StringBuilder text = new StringBuilder();
        JsonElement hunk = anchor.get("hunk");
        if (hunk instanceof JsonObject diff) {
            text.append(diff.get("header").getAsString()).append('\n');
            for (JsonElement element : diff.getAsJsonArray("lines")) {
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
