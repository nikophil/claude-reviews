package localreviews;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.editor.ex.EditorGutterComponentEx;
import com.intellij.openapi.project.DumbAwareAction;

import java.util.List;

/** Opens a thread on the selected lines, the line of the caret, or the line number right-clicked, in an editor or a side of a diff that shows threads. */
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
        if (editor == null) return;
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
        // A right click on a line number outside the selection opens the thread on that line.
        Integer clicked = event.getData(EditorGutterComponentEx.LOGICAL_LINE_AT_CURSOR);
        if (clicked != null && (clicked < start || clicked > end)) {
            start = clicked;
            end = clicked;
        }
        open(editor, start, end);
    }

    /**
     * Opens a thread on the lines `start` to `end` of the editor, from 0:
     * in the unified diff, on the new side when the last line has one, else on the old side; the first line moves down onto a line of that side.
     */
    static void open(Editor editor, int start, int end) {
        List<Threads> sides = editor.getUserData(Threads.KEY);
        if (sides == null) return;
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
