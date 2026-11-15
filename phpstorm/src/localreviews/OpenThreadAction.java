package localreviews;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.project.DumbAwareAction;

import java.util.List;

/** Opens a thread on the selected lines, or the line of the caret, in a side of the diff of the review. */
public final class OpenThreadAction extends DumbAwareAction {
    public OpenThreadAction() {
        super("Open Review Thread", "Open a review thread on the selected lines", null);
    }

    @Override
    public ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(AnActionEvent event) {
        Editor editor = event.getData(CommonDataKeys.EDITOR);
        event.getPresentation().setEnabledAndVisible(editor != null && editor.getUserData(Threads.KEY) != null);
    }

    @Override
    public void actionPerformed(AnActionEvent event) {
        Editor editor = event.getData(CommonDataKeys.EDITOR);
        List<Threads> sides = editor == null ? null : editor.getUserData(Threads.KEY);
        if (sides == null) return;
        Document document = editor.getDocument();
        SelectionModel selection = editor.getSelectionModel();
        int start = document.getLineNumber(selection.hasSelection() ? selection.getSelectionStart() : editor.getCaretModel().getOffset());
        int end = start;
        if (selection.hasSelection()) {
            int endOffset = selection.getSelectionEnd();
            end = document.getLineNumber(endOffset);
            // A selection of whole lines ends at column 0 of the next one.
            if (end > start && endOffset == document.getLineStartOffset(end)) end--;
        }
        // In the unified diff, the new side when the last line has one, else the old side; the first line moves down onto a line of that side.
        for (Threads threads : sides) {
            int last = threads.lines().fromEditor(end + 1);
            if (last == 0) continue;
            int first = 0;
            for (int line = start + 1; first == 0 && line <= end + 1; line++) first = threads.lines().fromEditor(line);
            threads.draft(first, last);
            return;
        }
    }
}
