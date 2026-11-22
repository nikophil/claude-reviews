package localreviews;

import com.google.gson.JsonObject;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.editor.ComponentInlayAlignment;
import com.intellij.openapi.editor.ComponentInlayKt;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorCustomElementRenderer;
import com.intellij.openapi.editor.FoldRegion;
import com.intellij.openapi.editor.FoldingModel;
import com.intellij.openapi.editor.Inlay;
import com.intellij.openapi.editor.RangeMarker;
import com.intellij.openapi.editor.event.EditorMouseEvent;
import com.intellij.openapi.editor.event.EditorMouseListener;
import com.intellij.openapi.editor.markup.TextAttributes;
import com.intellij.openapi.editor.InlayProperties;
import com.intellij.openapi.editor.markup.HighlighterLayer;
import com.intellij.openapi.editor.markup.HighlighterTargetArea;
import com.intellij.openapi.editor.markup.RangeHighlighter;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.util.Key;
import com.intellij.openapi.util.TextRange;
import com.intellij.ui.ColorUtil;
import com.intellij.ui.JBColor;
import com.intellij.util.ui.JBUI;

import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.io.IOException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** The threads of one side of one file, each after its lines in an editor. Runs on the EDT. */
final class Threads {
    /** The threads an editor shows: one side in the side-by-side diff, the new then the old side in the unified diff. */
    static final Key<List<Threads>> KEY = Key.create("localreviews.Threads");

    private static final Color OPEN = new JBColor(new Color(0xE0A030), new Color(0xD9A343));
    private static final Color RESOLVED = JBColor.GRAY;

    /** The lines of a side in the editor that shows them, from 1; 0 for a line the editor does not show. */
    interface Lines {
        int toEditor(int line);

        int fromEditor(int line);

        Lines SAME = new Lines() {
            @Override
            public int toEditor(int line) {
                return line;
            }

            @Override
            public int fromEditor(int line) {
                return line;
            }
        };
    }

    /** A thread shown as a view, or as a pill at the end of its last line while the threads are collapsed. */
    private record Shown(JsonObject thread, boolean claude, boolean approved, ThreadView view, Inlay<?> pill) {
        void dispose() {
            if (view != null) Disposer.dispose(view);
            if (pill != null) Disposer.dispose(pill);
        }
    }

    private final Project project;
    private final Editor editor;
    private Review review;
    private final String side;
    private final Document document;
    private final Lines lines;
    private final Runnable refresh;
    private final Disposable parent;
    private final Map<Integer, Shown> shown = new HashMap<>();
    private final Map<Integer, Anchor> anchors = new HashMap<>();
    private ThreadView draft;
    /** The lines of the draft, followed through the edits; null for a draft on the whole file. */
    private RangeMarker drafted;
    private boolean collapsed;
    private JsonObject last;

    /** The lines the server gave a thread, followed by a marker through the edits of the document since. */
    private record Anchor(JsonObject at, RangeMarker marker) {}

    /**
     * `document` holds the side, which the editor shows itself or through `lines`;
     * `refresh` polls the server again at once, after a write; the views are disposed with `parent` at the latest.
     */
    Threads(Project project, Editor editor, Review review, String side, Document document, Lines lines, Runnable refresh, Disposable parent) {
        this.project = project;
        this.editor = editor;
        this.review = review;
        this.side = side;
        this.document = document;
        this.lines = lines;
        this.refresh = refresh;
        this.parent = parent;
        // A click on a pill opens its thread alone.
        editor.addEditorMouseListener(new EditorMouseListener() {
            @Override
            public void mouseClicked(EditorMouseEvent event) {
                Inlay<?> inlay = event.getInlay();
                if (inlay == null || !(inlay.getRenderer() instanceof Pill pill) || pill.owner() != Threads.this) return;
                event.consume();
                ReviewService.get(project).open(Threads.this.review.session(), pill.id());
            }
        }, parent);
        Disposer.register(parent, () -> anchors.values().forEach(anchor -> anchor.marker().dispose()));
    }

    Lines lines() {
        return lines;
    }

    Review review() {
        return review;
    }

    /** The same file on another base id: what the draft posts from now on. */
    void review(Review review) {
        this.review = review;
    }

    /** Shows each thread as a pill at the end of its last line, until it is opened; the next `show` applies it. */
    void collapsed(boolean collapsed) {
        this.collapsed = collapsed;
    }

    /** Shows the last session again, once a thread opened. */
    void reshow() {
        if (last != null) show(last, false);
    }

    /** Whether a new thread can open here: not in an approved session. */
    boolean writable() {
        return last == null || !Placement.approved(last);
    }

    /**
     * Places the threads of the session: only a thread whose JSON changed is rebuilt, with the text being typed in it;
     * `all` rebuilds them all, once the editor got a new document, the draft too, on its lines.
     */
    void show(JsonObject session, boolean all) {
        last = session;
        if (!writable()) closeDraft();
        Map<Integer, JsonObject> placed = new HashMap<>();
        Map<Integer, int[]> ranges = new HashMap<>();
        for (JsonObject thread : Placement.threads(session, review.path(), side)) {
            int n = thread.get("id").getAsInt();
            int[] range = range(n, thread.getAsJsonObject("at"));
            int end = toEditor(range[1]);
            // A thread on the whole file, 0 to 0, goes above the first line.
            if (range[1] == 0 || end > 0 && end <= editor.getDocument().getLineCount()) {
                placed.put(n, thread);
                ranges.put(n, range);
            }
        }
        anchors.keySet().removeIf(n -> {
            if (placed.containsKey(n)) return false;
            anchors.get(n).marker().dispose();
            return true;
        });
        for (Iterator<Map.Entry<Integer, Shown>> it = shown.entrySet().iterator(); it.hasNext(); ) {
            Shown old = it.next().getValue();
            if (!placed.containsKey(old.thread().get("id").getAsInt())) {
                old.dispose();
                it.remove();
            }
        }
        boolean claude = Placement.claude(session);
        boolean approved = Placement.approved(session);
        ReviewService service = ReviewService.get(project);
        placed.forEach((n, thread) -> {
            Shown old = shown.get(n);
            boolean pill = collapsed && !service.opened(review.session(), n);
            if (!all && old != null && old.thread().equals(thread) && old.claude() == claude && old.approved() == approved && (old.pill() != null) == pill) return;
            int end = toEditor(ranges.get(n)[1]);
            if (pill) {
                if (old != null) old.dispose();
                // At the end of the first line for a thread on the whole file.
                Inlay<?> inlay = editor.getInlayModel().addAfterLineEndElement(editor.getDocument().getLineEndOffset(Math.max(end, 1) - 1), true, new Pill(this, n, "Thread #" + n + (ThreadView.status(thread).isEmpty() ? "" : " · " + ThreadView.status(thread))));
                if (inlay != null) Disposer.register(parent, inlay);
                shown.put(n, new Shown(thread, claude, approved, null, inlay));
                return;
            }
            Supplier<String> suggested = side.equals("new") && end > 0 ? () -> text(range(n, thread.getAsJsonObject("at"))) : null;
            ThreadView view = new ThreadView(project, session, thread, suggested, refresh);
            int start = toEditor(ranges.get(n)[0]);
            add(start > 0 ? start : end, end, thread.get("resolved").getAsBoolean(), view::hovered, view);
            // Only the hovered thread shows its lines: the marks of threads on the same lines would pile up.
            view.onHover(() -> editor.getComponent().repaint());
            if (old != null) {
                // The new view is in the editor before it takes the focus of the old one.
                if (old.view() != null) view.resume(old.view());
                old.dispose();
            }
            shown.put(n, new Shown(thread, claude, approved, view, null));
        });
        if (all && draft != null) {
            int[] range = drafted == null ? new int[] {0, 0} : span(drafted);
            if (drafted != null && (range[0] == 0 || toEditor(range[0]) == 0 || toEditor(range[1]) == 0)) closeDraft();
            else draft(range[0], range[1], false);
        }
    }

    /** Expands the folds of unchanged code of the diff over the lines of the threads shown: a fold does not hide a thread. */
    void unfold() {
        Document document = editor.getDocument();
        FoldingModel folding = editor.getFoldingModel();
        folding.runBatchFoldingOperation(() -> shown.forEach((n, thread) -> {
            int[] range = range(n, thread.thread().getAsJsonObject("at"));
            int start = toEditor(range[0]);
            int end = toEditor(range[1]);
            // A thread on the whole file goes above the first line, out of any fold.
            if (start < 1 || end < 1 || end > document.getLineCount()) return;
            int from = document.getLineStartOffset(start - 1);
            int to = document.getLineEndOffset(end - 1);
            for (FoldRegion region : folding.getAllFoldRegions()) {
                if (!region.isExpanded() && region.getStartOffset() <= to && region.getEndOffset() >= from) region.setExpanded(true);
            }
        }));
    }

    /**
     * The lines `{start, end}` of the thread `n` on its side, from 1:
     * those of `at` moved by the edits made since the server read them,
     * which the unified diff needs as it rebuilds its document at each edit.
     */
    private int[] range(int n, JsonObject at) {
        int start = at.get("start").getAsInt();
        int end = at.get("end").getAsInt();
        Anchor anchor = anchors.get(n);
        if (anchor == null || !anchor.at().equals(at)) {
            if (anchor != null) anchor.marker().dispose();
            anchors.remove(n);
            // ponytail: the server reads the lines of the file on disk; on a document not saved, they land on the lines of the same numbers, until it is saved.
            if (start < 1 || end > document.getLineCount()) return new int[] {start, end};
            anchor = new Anchor(at, document.createRangeMarker(document.getLineStartOffset(start - 1), document.getLineEndOffset(end - 1)));
            anchors.put(n, anchor);
        }
        int[] moved = span(anchor.marker());
        return moved[0] == 0 ? new int[] {start, end} : moved;
    }

    /** The lines of the side a marker spans now, from 1; {0, 0} once its text is gone. */
    private int[] span(RangeMarker marker) {
        if (!marker.isValid()) return new int[] {0, 0};
        return new int[] {document.getLineNumber(marker.getStartOffset()) + 1, document.getLineNumber(marker.getEndOffset()) + 1};
    }

    /** The text of the lines `range` of the side, from 1, as the document has them now. */
    private String text(int[] range) {
        if (range[0] < 1 || range[1] > document.getLineCount()) return "";
        return document.getText(new TextRange(document.getLineStartOffset(range[0] - 1), document.getLineEndOffset(range[1] - 1)));
    }

    /** A line of the side in the editor, 0 staying 0: the line of a thread on the whole file. */
    private int toEditor(int line) {
        return line == 0 ? 0 : lines.toEditor(line);
    }

    /**
     * A new thread on lines `start` to `end` of the side, from 1, or on the whole file for 0 and 0, with its field focused,
     * in place of the new thread already open, whose text it takes; its lines follow the edits of the document until it is sent.
     */
    void draft(int start, int end) {
        draft(start, end, true);
    }

    /** `focus` false for the draft put back by `show`: the focus moves only from the field of the draft it replaces. */
    private void draft(int start, int end, boolean focus) {
        if (!writable()) return;
        ModalityState modality = ModalityState.stateForComponent(editor.getComponent());
        RangeMarker marked = end == 0 ? null : document.createRangeMarker(document.getLineStartOffset(start - 1), document.getLineEndOffset(end - 1));
        ThreadView view = new ThreadView(project, review.session(), last, body -> {
            int[] range = new int[2];
            ApplicationManager.getApplication().invokeAndWait(() -> {
                FileDocumentManager.getInstance().saveAllDocuments();
                if (marked != null) System.arraycopy(span(marked), 0, range, 0, 2);
            }, modality);
            if (marked != null && range[0] == 0) throw new IOException("The lines of the thread are gone");
            JsonObject thread = new JsonObject();
            thread.addProperty("author", "me");
            thread.addProperty("path", review.path());
            thread.addProperty("side", side);
            thread.addProperty("start", range[0]);
            thread.addProperty("end", range[1]);
            thread.addProperty("body", body);
            thread.addProperty("base", review.base());
            thread.add("tree", Server.get("/api/sessions/" + review.session() + "/tree").get("tree"));
            return Placement.newest(Server.post("/api/sessions/" + review.session() + "/threads", thread));
        }, marked != null && side.equals("new") ? () -> text(span(marked)) : null, this::closeDraft, () -> {
            closeDraft();
            refresh.run();
        });
        if (marked != null) Disposer.register(view, marked::dispose);
        add(toEditor(start), toEditor(end), false, () -> true, view);
        // The text typed in the new thread already open moves to this one, as a click on another line number does in the browser.
        if (draft != null) view.resume(draft);
        closeDraft();
        draft = view;
        drafted = marked;
        if (!focus) return;
        // Above the first line, out of sight once the editor scrolled down.
        if (end == 0) editor.getScrollingModel().scrollVertically(0);
        view.focus();
    }

    private void closeDraft() {
        if (draft != null) Disposer.dispose(draft);
        draft = null;
        drafted = null;
    }

    /**
     * Puts the view in the editor after its lines `start` to `end` of the editor, from 1, or above the first line, unmarked, for 0 and 0;
     * disposing the view removes it.
     */
    private void add(int start, int end, boolean resolved, BooleanSupplier marked, ThreadView view) {
        Disposer.register(parent, view);
        Document document = editor.getDocument();
        if (end > 0) mark(document.getLineStartOffset(start - 1), document.getLineEndOffset(end - 1), resolved, marked, view);
        // Above the next line rather than under the last one: the diff stretches the band of a change over the inlays under its last line.
        boolean last = end > 0 && end >= document.getLineCount();
        int offset = last ? document.getLineEndOffset(end - 1) : document.getLineStartOffset(end);
        InlayProperties properties = new InlayProperties().relatesToPrecedingText(last).showAbove(!last);
        Inlay<?> inlay = ComponentInlayKt.addComponentInlay(editor, offset, properties, view, ComponentInlayAlignment.FIT_VIEWPORT_WIDTH);
        if (inlay != null) Disposer.register(view, inlay);
    }

    /**
     * Marks the lines of a thread, while `shown` says so, with a bar in the gutter;
     * an open one also with a veil over the colors of the diff, rather than in their place.
     */
    private void mark(int from, int to, boolean resolved, BooleanSupplier shown, ThreadView view) {
        RangeHighlighter marked = editor.getMarkupModel().addRangeHighlighter(from, to, HighlighterLayer.SELECTION - 1, null, HighlighterTargetArea.LINES_IN_RANGE);
        marked.setLineMarkerRenderer((editor, g, r) -> {
            if (!shown.getAsBoolean()) return;
            g.setColor(resolved ? RESOLVED : OPEN);
            eachLine(editor, marked, (top, height) -> g.fillRect(r.x, top, JBUI.scale(3), height));
        });
        if (!resolved) {
            marked.setCustomRenderer((editor, highlighter, g) -> {
                if (!shown.getAsBoolean()) return;
                g.setColor(ColorUtil.withAlpha(OPEN, 0.15));
                eachLine(editor, highlighter, (top, height) -> g.fillRect(0, top, editor.getContentComponent().getWidth(), height));
            });
        }
        Disposer.register(view, () -> editor.getMarkupModel().removeHighlighter(marked));
    }

    private interface Paint {
        void line(int top, int height);
    }

    /** The top and height of each line of the highlighter, its soft wraps included: the threads between its lines stay out of the mark. */
    private static void eachLine(Editor editor, RangeHighlighter highlighter, Paint paint) {
        Document document = editor.getDocument();
        int last = document.getLineNumber(highlighter.getEndOffset());
        for (int line = document.getLineNumber(highlighter.getStartOffset()); line <= last; line++) {
            int top = editor.visualLineToY(editor.offsetToVisualPosition(document.getLineStartOffset(line)).line);
            int bottom = editor.visualLineToY(editor.offsetToVisualPosition(document.getLineEndOffset(line)).line) + editor.getLineHeight();
            paint.line(top, bottom - top);
        }
    }

    /** The pill of a collapsed thread, colored by its status. */
    private record Pill(Threads owner, int id, String text) implements EditorCustomElementRenderer {
        private static final Color OTHER = new JBColor(new Color(0xDFE1E5), new Color(0x393B40));

        private Font font() {
            return JBUI.Fonts.smallFont().asBold();
        }

        @Override
        public int calcWidthInPixels(@SuppressWarnings("rawtypes") Inlay inlay) {
            return inlay.getEditor().getContentComponent().getFontMetrics(font()).stringWidth(text) + JBUI.scale(24);
        }

        @Override
        public void paint(@SuppressWarnings("rawtypes") Inlay inlay, Graphics g, Rectangle region, TextAttributes attributes) {
            Graphics2D g2 = (Graphics2D) g.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            int height = Math.min(region.height - JBUI.scale(2), JBUI.scale(16));
            int x = region.x + JBUI.scale(8);
            int y = region.y + (region.height - height) / 2;
            g2.setColor(OTHER);
            g2.fillRoundRect(x, y, region.width - JBUI.scale(8), height, height, height);
            g2.setFont(font());
            g2.setColor(JBColor.foreground());
            FontMetrics metrics = g2.getFontMetrics();
            g2.drawString(text, x + JBUI.scale(8), y + (height + metrics.getAscent() - metrics.getDescent()) / 2);
            g2.dispose();
        }
    }
}
