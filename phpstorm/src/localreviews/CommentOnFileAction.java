package localreviews;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.actionSystem.PlatformCoreDataKeys;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.TextEditor;
import com.intellij.openapi.project.DumbAwareAction;

import java.util.List;

/** Opens a thread on the whole file, above its first line, from the context menu of an editor, a side of a diff that shows threads, or an editor tab. */
public final class CommentOnFileAction extends DumbAwareAction {
    public CommentOnFileAction() {
        super("Comment on File", "Open a review thread on the whole file", null);
    }

    @Override
    public ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(AnActionEvent event) {
        List<Threads> sides = threads(event);
        event.getPresentation().setEnabledAndVisible(sides != null && sides.get(0).writable());
    }

    // In the unified diff, the new side, as the first one of the editor.
    @Override
    public void actionPerformed(AnActionEvent event) {
        List<Threads> sides = threads(event);
        if (sides != null) sides.get(0).draft(0, 0);
    }

    /** The threads of the editor, or of the text editor of the tab right-clicked. */
    private static List<Threads> threads(AnActionEvent event) {
        Editor editor = event.getData(CommonDataKeys.EDITOR);
        if (editor == null && event.getData(PlatformCoreDataKeys.FILE_EDITOR) instanceof TextEditor text) editor = text.getEditor();
        return editor == null ? null : editor.getUserData(Threads.KEY);
    }
}
