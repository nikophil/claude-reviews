package localreviews;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.icons.AllIcons;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.ide.ui.laf.darcula.ui.DarculaButtonUI;
import com.intellij.markdown.utils.doc.DocMarkdownToHtmlConverter;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.actionSystem.CommonShortcuts;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.application.WriteIntentReadAction;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.colors.EditorColorsManager;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.fileTypes.FileTypes;
import com.intellij.openapi.keymap.KeymapUtil;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.util.IconLoader;
import com.intellij.ui.AnimatedIcon;
import com.intellij.ui.ClientProperty;
import com.intellij.ui.components.ActionLink;
import com.intellij.openapi.ide.CopyPasteManager;
import com.intellij.ui.ColorUtil;
import com.intellij.ui.EditorTextField;
import com.intellij.ui.JBColor;
import com.intellij.ui.RoundedLineBorder;
import com.intellij.ui.components.JBCheckBox;
import com.intellij.ui.components.JBHtmlPane;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.panels.HorizontalLayout;
import com.intellij.ui.components.panels.VerticalLayout;
import com.intellij.ui.hover.HoverStateListener;
import com.intellij.util.IconUtil;
import com.intellij.util.ThrowableConsumer;
import com.intellij.util.ThrowableConvertor;
import com.intellij.util.text.DateFormatUtil;
import com.intellij.util.io.HttpRequests;
import com.intellij.util.ui.ImageUtil;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.WrapLayout;

import kotlin.text.CharsKt;
import kotlin.text.StringsKt;

import javax.imageio.ImageIO;
import javax.swing.AbstractButton;
import javax.swing.BorderFactory;
import javax.swing.Icon;
import javax.swing.JButton;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.JPopupMenu;
import javax.swing.JSeparator;
import javax.swing.SwingUtilities;
import javax.swing.text.DefaultCaret;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Container;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.datatransfer.StringSelection;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.RenderingHints;
import java.awt.KeyboardFocusManager;
import java.awt.event.ActionListener;
import java.awt.event.FocusAdapter;
import java.awt.event.FocusEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A thread under its lines, written into as in the review of the GitHub plugin:
 * a field, Ctrl+Enter adds a Pending message, and Send adds it then sends this thread alone.
 * Only the field takes the focus: a key typed elsewhere in the thread would reach the actions of the editor around it.
 */
final class ThreadView extends JPanel implements Disposable {
    private static final long serialVersionUID = 1L;
    private static final int MAX_WIDTH = 800;
    private static final int AVATAR = 24;
    private static final Pattern IMAGE = Pattern.compile("<img\\b[^>]*>", Pattern.CASE_INSENSITIVE);

    // Filled with the background of the editor, inside its rounded border: the code and the colors of the diff stay out of it.
    private final JPanel card = new JPanel(new VerticalLayout(JBUI.scale(8))) {
        private static final long serialVersionUID = 1L;

        @Override
        protected void paintComponent(Graphics g) {
            Graphics2D g2 = (Graphics2D) g.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setColor(EditorColorsManager.getInstance().getGlobalScheme().getDefaultBackground());
            g2.fillRoundRect(0, 0, getWidth(), getHeight(), JBUI.scale(8), JBUI.scale(8));
            g2.dispose();
        }
    };
    private final JPanel content = new JPanel(new VerticalLayout(JBUI.scale(10)));
    private final JBLabel title = new JBLabel();
    private final EditorTextField field;
    private final JBLabel error = failure();
    private final JButton other;
    /** Opens the edit of my Pending message at an index of the thread, with a text. */
    private final transient Map<Integer, Consumer<String>> edits = new HashMap<>();
    private EditorTextField editing;
    private int editingIndex;
    private static final Color PENDING = new JBColor(new Color(0xB86E00), new Color(0xD9A343));
    private final JButton add = button("Add pending", null);
    private final JButton send = button("Send", AllIcons.Actions.Upload);
    /** « Answer without changing code », on a thread not Resolved; null otherwise. */
    private JBCheckBox readonly;
    private final JBLabel shortcutHint = hint(KeymapUtil.getFirstKeyboardShortcutText(CommonShortcuts.getCtrlEnter()) + " to add pending");
    private boolean folded;
    private boolean resolved;
    private volatile boolean hovered;

    /** An open thread of the session; `lines` gives its lines as the document has them, for « Suggest Change », null without them. */
    ThreadView(Project project, JsonObject session, JsonObject thread, Supplier<String> lines, Runnable written) {
        super(null);
        int id = thread.get("id").getAsInt();
        String sessionId = session.get("id").getAsString();
        String route = "/api/sessions/" + sessionId + "/threads/" + id;
        resolved = thread.get("resolved").getAsBoolean();
        boolean claude = Placement.claude(session);
        String status = status(thread);
        // Without a Claude session in the worktree, nobody answers: no spinner, but how to start one.
        boolean waiting = status.equals("Waiting for Claude");
        card.add(header("Thread #" + id + " · " + lines(thread), waiting && !claude ? "No Claude session" : status));
        messages(project, route, thread.getAsJsonArray("messages"), written);
        // At the bottom too: the header of a long thread is out of sight.
        if (waiting && claude) content.add(hint("Waiting for Claude…"));
        if (waiting && !claude) content.add(startClaude(session));
        field = field(project, "Reply", "");
        // A Resolved thread takes no message until its Unresolve.
        other = resolved ? button("Unresolve", AllIcons.Actions.Rollback) : button("Resolve", AllIcons.Actions.Checked);
        String toggle = route + (resolved ? "/unresolve" : "/resolve");
        other.addActionListener(e -> write(field, error, List.of(other, add), body -> Server.post(toggle, new JsonObject()), written));
        if (!resolved) {
            readonly = new JBCheckBox("Answer without changing code", thread.has("readonly") && thread.get("readonly").getAsBoolean());
            readonly.setToolTipText("Claude replies in this thread without editing any file");
            JBCheckBox box = readonly;
            box.addActionListener(e -> write(null, error, List.of(box), body -> {
                JsonObject checked = new JsonObject();
                checked.addProperty("readonly", box.isSelected());
                Server.post(route + "/readonly", checked);
            }, written));
        }
        // Send spins, the only spinner, until Claude answers the thread.
        spin(send, ReviewService.get(project).spinning("thread:" + id, thread), AllIcons.Actions.Upload);
        finish(project, sessionId, Placement.sendRefusal(session), pending(thread) ? id : null, body -> {
            Server.post(route + "/messages", reply(body));
            return id;
        }, resolved ? null : lines, written);
        if (resolved) {
            field.setVisible(false);
            add.setVisible(false);
            send.setVisible(false);
            shortcutHint.setVisible(false);
        }
        // A Resolved thread shows folded, its discussion one click away.
        if (resolved) fold();
    }

    /**
     * A new thread of the session `sessionId`, opened by `create` with its first message, which gives its id;
     * `sendRefusal` as Placement gives it, `lines` as for an open thread.
     */
    ThreadView(Project project, String sessionId, String sendRefusal, ThrowableConvertor<String, Integer, IOException> create, Supplier<String> lines, Runnable cancel, Runnable written) {
        super(null);
        card.add(header("New thread", ""));
        field = field(project, "Comment", "");
        other = button("Cancel", null);
        // Removing the inlay changes the editor: a bare Swing listener needs the write-intent lock for it.
        other.addActionListener(e -> WriteIntentReadAction.run(cancel));
        finish(project, sessionId, sendRefusal, null, create, lines, written);
        // A new thread left empty closes once the focus goes elsewhere, the IDE losing it aside.
        field.addFocusListener(new FocusAdapter() {
            @Override
            public void focusLost(FocusEvent e) {
                if (e.isTemporary()) return;
                ApplicationManager.getApplication().invokeLater(() -> {
                    Editor editor = field.getEditor();
                    boolean back = editor != null && editor.getContentComponent().hasFocus();
                    if (!back && field.getText().isBlank()) cancel.run();
                }, ModalityState.stateForComponent(ThreadView.this));
            }
        });
    }

    /**
     * Takes over the text being typed in the view this one replaces, that of a message being edited while it is still Pending,
     * their focus, and whether it is folded unless it got resolved or reopened.
     */
    void resume(ThreadView previous) {
        field.setText(previous.field.getText());
        if (previous.editing != null && edits.containsKey(previous.editingIndex)) edits.get(previous.editingIndex).accept(previous.editing.getText());
        if (previous.resolved == resolved && previous.folded != folded) fold();
        // No focus owner while the IDE is in the background.
        Component owner = KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner();
        if (owner != null && SwingUtilities.isDescendingFrom(owner, previous.field)) {
            field.requestFocusInWindow();
        }
        if (owner != null && editing != null && SwingUtilities.isDescendingFrom(owner, previous.editing)) editing.requestFocusInWindow();
    }

    void focus() {
        field.requestFocusInWindow();
    }

    /** Whether the mouse is over the thread, one of its parts included. */
    boolean hovered() {
        return hovered;
    }

    /** Runs `changed` when the mouse enters or leaves the thread. */
    void onHover(Runnable changed) {
        new HoverStateListener() {
            @Override
            protected void hoverChanged(Component component, boolean hovered) {
                ThreadView.this.hovered = hovered;
                changed.run();
            }
        }.addTo(this, this);
    }

    // The bodies are disposed with the view.
    @Override
    public void dispose() {}

    /** The header folds and unfolds the thread down to itself. */
    private JPanel header(String text, String status) {
        title.setText(text);
        title.setIcon(AllIcons.General.ArrowDown);
        title.setFont(JBUI.Fonts.label().asBold());
        JPanel header = new JPanel(new BorderLayout());
        header.setOpaque(false);
        header.add(title, BorderLayout.WEST);
        JBLabel right = hint(status);
        if (status.equals("Resolved")) right.setIcon(AllIcons.Actions.Checked);
        header.add(right, BorderLayout.EAST);
        header.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        header.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                fold();
            }
        });
        return header;
    }

    void unfold() {
        if (folded) fold();
    }

    private void fold() {
        folded = !folded;
        content.setVisible(!folded);
        title.setIcon(folded ? AllIcons.General.ArrowRight : AllIcons.General.ArrowDown);
        revalidate();
        repaint();
    }

    /** The messages, a turn per run of messages of the same author: its avatar, its name, then each message; a line between turns. */
    private void messages(Project project, String route, JsonArray messages, Runnable written) {
        List<List<JsonObject>> turns = new ArrayList<>();
        for (JsonElement element : messages) {
            JsonObject message = element.getAsJsonObject();
            List<JsonObject> last = turns.isEmpty() ? null : turns.get(turns.size() - 1);
            // My Pending messages make a turn of their own, all of it in the color of Pending.
            if (last != null && author(last.get(0)).equals(author(message)) && unsent(last.get(0)) == unsent(message)) last.add(message);
            else turns.add(new ArrayList<>(List.of(message)));
        }
        int index = 0; // of the message in the thread: the turns keep their order
        for (List<JsonObject> turn : turns) {
            if (content.getComponentCount() > 0) content.add(new JSeparator());
            String author = author(turn.get(0));
            boolean unsent = unsent(turn.get(0));
            JPanel column = new JPanel(new VerticalLayout(JBUI.scale(4)));
            column.setOpaque(false);
            JBLabel name = new JBLabel(name(author));
            name.setFont(JBUI.Fonts.label().asBold());
            // In a row of its own: the vertical layout would stretch the badge over the width.
            JPanel nameRow = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0));
            nameRow.setOpaque(false);
            nameRow.add(name);
            if (unsent) nameRow.add(badge());
            column.add(nameRow);
            for (JsonObject message : turn) {
                if (!unsent) column.add(hint(when(message)));
                String markdown = message.get("body").getAsString();
                column.add(unsent ? pending(project, route, index, markdown, messages.size() == 1, written) : body(project, markdown));
                index++;
            }
            JPanel avatar = new JPanel(new BorderLayout());
            avatar.setOpaque(false);
            avatar.setBorder(JBUI.Borders.emptyRight(8));
            avatar.add(new JBLabel(author.equals("claude") ? Avatars.CLAUDE : Avatars.me(project)), BorderLayout.NORTH);
            JPanel shown = unsent ? pendingTurn() : new JPanel(new BorderLayout());
            shown.setOpaque(false);
            shown.add(avatar, BorderLayout.WEST);
            shown.add(column, BorderLayout.CENTER);
            content.add(shown);
        }
    }

    /**
     * My Pending message `index` of the thread: Edit swaps it for a field, until saved or cancelled; Delete asks first.
     * `alone` when it is the only message of the thread, which goes with it.
     */
    private JPanel pending(Project project, String route, int index, String markdown, boolean alone, Runnable written) {
        JPanel message = new JPanel(new VerticalLayout(JBUI.scale(4)));
        message.setOpaque(false);
        JPanel shown = new JPanel(new VerticalLayout(JBUI.scale(2)));
        shown.setOpaque(false);
        shown.add(body(project, markdown));
        JPanel links = new JPanel(new HorizontalLayout(JBUI.scale(10)));
        links.setOpaque(false);
        links.add(link("Edit", e -> {
            edits.get(index).accept(markdown);
            editing.requestFocusInWindow();
        }));
        links.add(link("Delete", e -> delete(project, route + "/messages/" + index + "/delete", alone, written)));
        shown.add(links);
        message.add(shown);
        edits.put(index, text -> {
            EditorTextField edited = field(project, "Message", text);
            JBLabel failed = failure();
            JButton cancel = button("Cancel", null);
            JButton save = button("Save", null);
            ClientProperty.put(save, DarculaButtonUI.DEFAULT_STYLE_KEY, true);
            JPanel buttons = row();
            buttons.add(cancel);
            buttons.add(save);
            JPanel form = new JPanel(new VerticalLayout(JBUI.scale(4)));
            form.setOpaque(false);
            form.add(edited);
            form.add(failed);
            form.add(buttons);
            Runnable close = () -> {
                editing = null;
                message.remove(form);
                shown.setVisible(true);
                revalidate();
                repaint();
            };
            cancel.addActionListener(e -> close.run());
            save.addActionListener(e -> {
                if (edited.getText().isBlank()) return;
                write(edited, failed, List.of(cancel, save), body -> {
                    JsonObject edit = new JsonObject();
                    edit.addProperty("body", body);
                    Server.post(route + "/messages/" + index, edit);
                }, () -> {
                    close.run();
                    written.run();
                });
            });
            DumbAwareAction.create(e -> save.doClick()).registerCustomShortcutSet(CommonShortcuts.getCtrlEnter(), edited);
            shown.setVisible(false);
            message.add(form);
            editing = edited;
            editingIndex = index;
            revalidate();
            repaint();
        });
        return message;
    }

    /** Posts to `route`, once confirmed, then runs `written`; the failure shows in a dialog. */
    private void delete(Project project, String route, boolean alone, Runnable written) {
        String question = alone ? "Delete this pending message? Its thread goes with it." : "Delete this pending message?";
        if (Messages.showYesNoDialog(project, question, "Delete Message", "Delete", "Cancel", null) != Messages.YES) return;
        ModalityState modality = ModalityState.stateForComponent(this);
        ReviewDiffAction.background(project, () -> {
            Server.post(route, new JsonObject());
            ApplicationManager.getApplication().invokeLater(written, modality);
        });
    }

    /**
     * The field and its buttons: Add pending writes the text through `addPending`, which gives the id of its thread;
     * Send does the same, then sends this thread alone, without the Pending messages of the others, or, with nothing typed,
     * the thread `pending` when it has Pending messages.
     */
    private void finish(Project project, String sessionId, String sendRefusal, Integer pending, ThrowableConvertor<String, Integer, IOException> addPending, Supplier<String> lines, Runnable written) {
        // A write gives its buttons back once done: not a Send greyed for its refusal.
        List<JButton> buttons = sendRefusal == null ? List.of(other, add, send) : List.of(other, add);
        add.addActionListener(e -> {
            if (!field.getText().isBlank()) write(field, error, buttons, addPending::convert, written);
        });
        send.setEnabled(sendRefusal == null);
        send.setToolTipText(sendRefusal != null ? sendRefusal : "Add the message, then send this thread alone to Claude");
        int[] thread = {pending == null ? 0 : pending};
        Runnable sendThread = () -> {
            send.setEnabled(false);
            spin(send, true, AllIcons.Actions.Upload);
            // Enabled again once the Send ends: a Send that fails leaves the thread as it was, and its view too.
            WriteIntentReadAction.run(() -> ReviewDiffAction.send(project, sessionId, thread[0], null, () -> {
                send.setEnabled(true);
                spin(send, false, AllIcons.Actions.Upload);
                written.run();
            }));
        };
        send.addActionListener(e -> {
            if (!field.getText().isBlank()) write(field, error, buttons, body -> thread[0] = addPending.convert(body), sendThread);
            else if (pending != null) sendThread.run();
        });
        ClientProperty.put(add, DarculaButtonUI.DEFAULT_STYLE_KEY, true);
        DumbAwareAction.create(e -> add.doClick()).registerCustomShortcutSet(CommonShortcuts.getCtrlEnter(), field);
        content.add(field);
        content.add(error);
        // In a narrow column, the hint and the buttons wrap onto more rows rather than running out of the card.
        JPanel footer = row();
        if (readonly != null) footer.add(readonly);
        if (lines != null) footer.add(suggest(lines));
        footer.add(shortcutHint);
        footer.add(other);
        footer.add(send);
        footer.add(add);
        content.add(footer);
        content.setOpaque(false);
        card.add(content);
        card.setOpaque(false);
        card.setBorder(BorderFactory.createCompoundBorder(new RoundedLineBorder(JBColor.border(), JBUI.scale(8), 1), JBUI.Borders.empty(8, 10)));
        setOpaque(false);
        add(card);
    }

    /** « Suggest Change »: a suggestion block of the lines of the thread after the text of the field, the caret at the end of the lines. */
    private JButton suggest(Supplier<String> lines) {
        JButton suggest = button("Suggest Change", null);
        suggest.setToolTipText("Suggest new code for the lines of the thread: Claude applies it once he reads the thread");
        // Setting the text of the field is a write: a bare Swing listener needs the write-intent lock for it.
        suggest.addActionListener(e -> WriteIntentReadAction.run(() -> {
            String text = suggestion(field.getText(), ReadAction.computeBlocking(lines::get));
            field.setText(text);
            field.setCaretPosition(text.lastIndexOf('\n'));
            field.requestFocusInWindow();
        }));
        return suggest;
    }

    /**
     * Runs a write of the text of `source` off the EDT, `buttons` greyed meanwhile:
     * on success the field empties and `written` runs, on failure the error shows in `failed` and the text stays; a null `source` writes no text.
     */
    private void write(EditorTextField source, JBLabel failed, List<? extends AbstractButton> buttons, ThrowableConsumer<String, IOException> action, Runnable written) {
        String body = source == null ? "" : source.getText().strip();
        buttons.forEach(button -> button.setEnabled(false));
        ModalityState modality = ModalityState.stateForComponent(this);
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            String failure = null;
            try {
                action.consume(body);
            } catch (IOException e) {
                failure = e.getMessage() != null ? e.getMessage() : "The claude-reviews server does not answer; no server at " + Server.ENDPOINT;
            } catch (RuntimeException e) {
                // An answer that is not JSON, say: the buttons come back, with why.
                failure = "Unexpected answer of the claude-reviews server: " + e;
            }
            String shown = failure;
            ApplicationManager.getApplication().invokeLater(() -> {
                buttons.forEach(button -> button.setEnabled(true));
                failed.setText(shown);
                failed.setVisible(shown != null);
                if (shown == null) {
                    if (source != null) source.setText("");
                    written.run();
                }
                revalidate();
                repaint();
            }, modality);
        });
    }

    // The card is at most MAX_WIDTH wide, at the left of the width the editor gives the inlay.
    @Override
    public void doLayout() {
        card.setBounds(0, 0, cardWidth(), getHeight());
    }

    @Override
    public Dimension getPreferredSize() {
        int width = cardWidth();
        // A wrapped text reports the height of its current width: lay the card out at its width, down to the texts, before asking it.
        card.setSize(width, card.getHeight());
        layOut(card);
        return new Dimension(width, card.getPreferredSize().height);
    }

    private static void layOut(Container container) {
        container.doLayout();
        for (Component child : container.getComponents()) {
            if (child instanceof Container inner) layOut(inner);
        }
    }

    private int cardWidth() {
        int max = JBUI.scale(MAX_WIDTH);
        return getWidth() == 0 ? max : Math.min(getWidth(), max);
    }

    private static JsonObject reply(String body) {
        JsonObject reply = new JsonObject();
        reply.addProperty("author", "me");
        reply.addProperty("body", body);
        return reply;
    }

    /** The thread's place, else, Outdated, the lines of its Anchor; « File » for a thread on the whole file. */
    static String lines(JsonObject thread) {
        JsonObject anchor = thread.getAsJsonObject("anchor");
        JsonObject at = thread.get("at") instanceof JsonObject placed ? placed : anchor;
        String sign = anchor.get("side").getAsString().equals("old") ? "-" : "+";
        int start = at.get("start").getAsInt();
        int end = at.get("end").getAsInt();
        if (end == 0) return "File";
        return start == end ? "Line " + sign + start : "Lines " + sign + start + " to " + sign + end;
    }

    private static boolean pending(JsonObject thread) {
        for (JsonElement message : thread.getAsJsonArray("messages")) {
            JsonElement date = message.getAsJsonObject().get("date");
            if (date == null || date.isJsonNull()) return true;
        }
        return false;
    }

    static String status(JsonObject thread) {
        JsonElement status = thread.get("status");
        if (status == null || status.isJsonNull()) return "Pending";
        return switch (status.getAsString()) {
            case "open" -> "";
            case "resolved" -> "Resolved";
            default -> "Waiting for Claude";
        };
    }

    /** The name of an author, as in the web page. */
    static String name(String author) {
        return author.equals("me") ? "You" : "Claude";
    }

    /** `text` followed by a suggestion block of `lines`, on lines of its own: Claude applies it once he reads the thread. */
    static String suggestion(String text, String lines) {
        String fence = "```";
        while (lines.contains(fence)) fence += "`";
        return text + (text.isEmpty() || text.endsWith("\n") ? "" : "\n") + fence + "suggestion\n" + lines + "\n" + fence;
    }

    /**
     * The threads with a sent message, in the order of the session, as the web page copies them:
     * a heading with the file, the place and the status, then each sent message, a blank line between all.
     */
    static String markdown(JsonObject session) {
        List<String> threads = new ArrayList<>();
        for (JsonElement element : session.getAsJsonArray("threads")) {
            JsonObject thread = element.getAsJsonObject();
            List<String> parts = new ArrayList<>();
            for (JsonElement message : thread.getAsJsonArray("messages")) {
                if (unsent(message.getAsJsonObject())) continue;
                parts.add("**" + name(author(message.getAsJsonObject())) + "**: " + message.getAsJsonObject().get("body").getAsString());
            }
            if (parts.isEmpty()) continue;
            String place = lines(thread);
            String status = status(thread);
            parts.add(0, "### `" + thread.getAsJsonObject("anchor").get("path").getAsString() + "` " + Character.toLowerCase(place.charAt(0)) + place.substring(1)
                + (status.isEmpty() ? "" : " · " + status));
            threads.add(String.join("\n\n", parts));
        }
        return threads.isEmpty() ? "" : String.join("\n\n", threads) + "\n";
    }

    private static String author(JsonObject message) {
        return message.get("author").getAsString();
    }

    /** « Start a Claude session in this worktree », its command, and a link that copies the command. */
    static JPanel startClaude(JsonObject session) {
        String command = Placement.startClaude(session);
        JPanel panel = new JPanel(new VerticalLayout(JBUI.scale(2)));
        panel.setOpaque(false);
        JBLabel text = new JBLabel("Start a Claude session in this worktree to send to Claude:");
        text.setForeground(PENDING);
        JBLabel shown = new JBLabel(command);
        shown.setFont(JBUI.Fonts.create(Font.MONOSPACED, JBUI.Fonts.label().getSize()));
        shown.setToolTipText(command);
        panel.add(text);
        panel.add(shown);
        ActionListener copy = e -> CopyPasteManager.getInstance().setContents(new StringSelection(command));
        panel.add(new ActionLink("Copy command", copy));
        return panel;
    }

        /** A turn of my Pending messages: its avatar, name and bodies on the color of Pending. */
    private static JPanel pendingTurn() {
        JPanel panel = new JPanel(new BorderLayout()) {
            private static final long serialVersionUID = 1L;

            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(ColorUtil.withAlpha(PENDING, 0.12));
                g2.fillRoundRect(0, 0, getWidth(), getHeight(), JBUI.scale(8), JBUI.scale(8));
                g2.dispose();
            }
        };
        panel.setBorder(JBUI.Borders.empty(6));
        return panel;
    }

    private static JBLabel badge() {
        JBLabel badge = new JBLabel("Pending");
        badge.setFont(JBUI.Fonts.smallFont().asBold());
        badge.setForeground(PENDING);
        badge.setBorder(BorderFactory.createCompoundBorder(new RoundedLineBorder(PENDING, JBUI.scale(8), 1), JBUI.Borders.empty(0, 6)));
        return badge;
    }

    private static boolean unsent(JsonObject message) {
        JsonElement date = message.get("date");
        return date == null || date.isJsonNull();
    }

    /** A spinner in place of the icon of `button`, also while it is greyed, or its own `icon` back. */
    static void spin(JButton button, boolean spinning, Icon icon) {
        button.setIcon(spinning ? AnimatedIcon.Default.INSTANCE : icon);
        button.setDisabledIcon(spinning ? AnimatedIcon.Default.INSTANCE : null);
    }

    /** « Today 23:05 », « Send #2 · Today 23:05 ». */
    private static String when(JsonObject message) {
        JsonElement date = message.get("date");
        String when = DateFormatUtil.formatPrettyDateTime(Instant.parse(date.getAsString()).toEpochMilli());
        return author(message).equals("me") ? "Send #" + message.get("review").getAsInt() + " · " + when : when;
    }

    // ponytail: links are not clickable.
    /**
     * The body in markdown, its code blocks colored as in the editor, like the quick documentation.
     * Its text selects with the mouse and copies by its context menu, without the focus that would hand the keys to the editor around.
     */
    private JBHtmlPane body(Project project, String markdown) {
        String html = ReadAction.computeBlocking(() -> DocMarkdownToHtmlConverter.convert(project, escapeHtml(markdown)));
        JBHtmlPane body = new JBHtmlPane();
        Disposer.register(this, body);
        // As in the web page: an image shows nothing, rather than loading its URL.
        // ponytail: when its parser fails, the converter shows the markdown itself as HTML, code included; withoutLoads still keeps Swing from loading anything.
        body.setText(withoutLoads(IMAGE.matcher(html).replaceAll("")));
        body.setEditable(false);
        body.setFocusable(false);
        body.setOpaque(false);
        body.setBorder(JBUI.Borders.empty());
        DefaultCaret caret = new DefaultCaret() {
            private static final long serialVersionUID = 1L;

            // The selection shows without the focus, that would hide it again on its loss.
            @Override
            public void setSelectionVisible(boolean visible) {
                super.setSelectionVisible(true);
            }
        };
        body.setCaret(caret);
        // Swing shows a selection only once its caret is told so, which it is on a focus the pane never gets.
        caret.setSelectionVisible(true);
        JMenuItem copy = new JMenuItem("Copy", AllIcons.Actions.Copy);
        copy.addActionListener(e -> body.copy());
        JPopupMenu menu = new JPopupMenu();
        menu.add(copy);
        body.setComponentPopupMenu(menu);
        return body;
    }

    /**
     * Raw HTML shows as text, as in the web page: `<` is escaped but in the code DocMarkdownToHtmlConverter shows as code too, erring on the side of escaping.
     * The lines are read as it reads them: split as by Kotlin, without their common indentation nor their trailing whitespace, a ``` line indented moved to the start.
     */
    static String escapeHtml(String markdown) {
        List<String> lines = StringsKt.lines(markdown);
        int indent = Integer.MAX_VALUE;
        for (String line : lines) {
            if (!StringsKt.isBlank(line)) indent = Math.min(indent, indent(line));
        }
        List<String> escaped = new ArrayList<>();
        String fence = null; // the run that closes the open code block
        boolean shown = false; // whether the open code block shows its text as written: not one opened by an indented line
        boolean span = false; // whether a code span may go on from a line above, until a blank line
        boolean all = false; // everything escaped from here on
        for (int n = 0; n < lines.size(); n++) {
            String line = lines.get(n);
            String read = StringsKt.trimEnd((CharSequence) (line.length() <= indent ? "" : line.substring(indent))).toString();
            boolean indented = INDENTED_TICKS.matcher(read).matches();
            if (indented) read = read.substring(indent(read));
            // A table, which the converter turns into HTML lines; a fence after a marker, which the converter may take for one or not;
            // a link reference definition, which may take the lines below for its destination or title.
            all = all || line.contains("|") && n + 1 < lines.size() && delimiterRow(lines.get(n + 1))
                || !read.startsWith("```") && !read.startsWith("~~~") && (read.contains("```") || read.contains("~~~"))
                || fence == null && (line.contains("]:") || line.lastIndexOf('[') > line.lastIndexOf(']'));
            Matcher opening = FENCE.matcher(read);
            if (all) {
                escaped.add(escape(line));
            } else if (fence != null) {
                escaped.add(shown ? line : escape(line));
                if (closes(read, fence)) fence = null;
            } else if (opening.matches()) {
                fence = opening.group(1);
                shown = !indented;
                escaped.add(escape(line));
            } else {
                if (read.isEmpty()) span = false;
                StringBuilder out = new StringBuilder();
                if (span) out.append(escape(line));
                else span = inline(line, out);
                escaped.add(out.toString());
            }
        }
        return String.join("\n", escaped);
    }

    private static final Pattern INDENTED_TICKS = Pattern.compile("\\s+```.*");
    // A backtick in the info string makes it no fence, of backticks or of tildes alike.
    private static final Pattern FENCE = Pattern.compile("(`{3,}|~{3,})[^`]*");

    /** Escapes a line outside code blocks: a code span shows as written; true when a run of backticks stays open, maybe closed on a line below. */
    private static boolean inline(String line, StringBuilder out) {
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '\\' && i + 1 < line.length() && (line.charAt(i + 1) == '`' || line.charAt(i + 1) == '\\')) {
                out.append(c).append(line.charAt(++i));
            } else if (c == '`') {
                int run = i;
                while (run < line.length() && line.charAt(run) == '`') run++;
                int end = closing(line, run, run - i);
                if (end < 0) {
                    out.append(escape(line.substring(i)));
                    return true;
                }
                out.append(line, i, end);
                i = end - 1;
            } else {
                out.append(c == '<' ? "&lt;" : String.valueOf(c));
            }
        }
        return false;
    }

    /** The end of the next run of exactly `length` backticks from `from`, -1 without one: a backslash escapes nothing in a code span. */
    private static int closing(String line, int from, int length) {
        for (int i = from; i < line.length(); i++) {
            int run = i;
            while (run < line.length() && line.charAt(run) == '`') run++;
            if (run - i == length) return run;
            i = run;
        }
        return -1;
    }

    private static boolean closes(String read, String fence) {
        String body = read.replaceFirst("^ {0,3}", "");
        return body.startsWith(fence) && body.chars().allMatch(c -> c == fence.charAt(0));
    }

    /** A line the converter may take for the delimiter row of a table: only pipes, dashes, colons and whitespace. */
    private static boolean delimiterRow(String line) {
        return line.chars().allMatch(c -> c == '|' || c == '-' || c == ':' || CharsKt.isWhitespace((char) c)) && (line.contains("-") || line.contains(":"));
    }

    private static int indent(String line) {
        int i = 0;
        while (i < line.length() && CharsKt.isWhitespace(line.charAt(i))) i++;
        return i;
    }

    private static String escape(String text) {
        return text.replace("<", "&lt;");
    }

    private static final Pattern LOADING_ATTRIBUTE = Pattern.compile("(?i)\\s*(?<![\\w-])(background|style)\\s*=\\s*(\"[^\"]*(?:\"|$)|'[^']*(?:'|$)|[^\\s>\"']+)");
    private static final Pattern LOADING_STYLE = Pattern.compile("(?i)url|image|[&\\\\]");

    /**
     * A second barrier, should raw HTML get through: no background attribute, and no style with an image, a url( or an escape that could hide one,
     * which Swing would load as it shows the message; the colors of the code stay.
     */
    static String withoutLoads(String html) {
        String known = TAG.matcher(html).replaceAll(tag -> Matcher.quoteReplacement(TAGS.contains(tag.group(1).toLowerCase(Locale.ROOT)) ? tag.group() : "&lt;" + tag.group().substring(1)));
        return LOADING_ATTRIBUTE.matcher(known).replaceAll(attribute -> attribute.group(1).equalsIgnoreCase("style") && !LOADING_STYLE.matcher(attribute.group(2)).find()
            ? Matcher.quoteReplacement(attribute.group()) : "");
    }

    private static final Pattern TAG = Pattern.compile("</?([a-zA-Z][a-zA-Z0-9]*)");
    // The tags DocMarkdownToHtmlConverter writes: any other (object, link, frame, input…) could load a URL or build a component, and shows as text.
    private static final Set<String> TAGS = Set.of("a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "li", "ol", "p",
        "pre", "s", "span", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul");

    private static EditorTextField field(Project project, String placeholder, String text) {
        EditorTextField field = new EditorTextField(text, project, FileTypes.PLAIN_TEXT);
        field.setOneLineMode(false);
        field.setPlaceholder(placeholder);
        field.addSettingsProvider(editor -> editor.getSettings().setUseSoftWraps(true));
        field.setBorder(BorderFactory.createCompoundBorder(new RoundedLineBorder(JBColor.border(), JBUI.scale(6), 1), JBUI.Borders.empty(4, 6)));
        return field;
    }

    /** Buttons at the right, wrapped onto more rows in a narrow column. */
    private static JPanel row() {
        JPanel row = new JPanel(new WrapLayout(FlowLayout.RIGHT, JBUI.scale(6), JBUI.scale(4)));
        row.setOpaque(false);
        return row;
    }

    /** Where the failure of a write shows, hidden until one. */
    private static JBLabel failure() {
        JBLabel failure = new JBLabel();
        failure.setForeground(JBColor.RED);
        failure.setVisible(false);
        return failure;
    }

    /** A link that leaves the focus where it is, as the buttons do. */
    private static ActionLink link(String text, ActionListener listener) {
        ActionLink link = new ActionLink(text, listener);
        link.setFocusable(false);
        return link;
    }

    private static JBLabel hint(String text) {
        return hint(text, null);
    }

    private static JBLabel hint(String text, Icon icon) {
        JBLabel hint = new JBLabel(text, icon, JBLabel.LEFT);
        hint.setForeground(JBColor.GRAY);
        return hint;
    }

    private static JButton button(String text, Icon icon) {
        JButton button = new JButton(text, icon);
        button.setFocusable(false);
        button.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        return button;
    }

    /** Loaded on the first thread shown. */
    static final class Avatars {
        // The icon of the Claude Code plugin, when it is installed.
        static final Icon CLAUDE = IconUtil.resizeSquared(claude(), AVATAR);
        // At the size of the icon of a notification.
        static final Icon CLAUDE_SMALL = IconUtil.resizeSquared(claude(), 16);
        private static final Icon USER = IconUtil.resizeSquared(AllIcons.General.User, AVATAR);
        private static final AtomicBoolean LOADING = new AtomicBoolean();
        private static volatile Image github;

        /** The GitHub avatar of the account set in the IDE, a generic user until it is loaded or without such an account. */
        static Icon me(Project project) {
            if (LOADING.compareAndSet(false, true)) ApplicationManager.getApplication().executeOnPooledThread(() -> load(project));
            return ME;
        }

        // Paints the GitHub avatar once loaded: the threads already shown take it at their next repaint.
        private static final Icon ME = new Icon() {
            @Override
            public void paintIcon(Component c, Graphics g, int x, int y) {
                Image image = github;
                if (image == null) {
                    USER.paintIcon(c, g, x, y);
                    return;
                }
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                g2.drawImage(image, x, y, getIconWidth(), getIconHeight(), null);
                g2.dispose();
            }

            @Override
            public int getIconWidth() {
                return USER.getIconWidth();
            }

            @Override
            public int getIconHeight() {
                return USER.getIconHeight();
            }
        };

        private static Icon claude() {
            IdeaPluginDescriptor plugin = PluginManagerCore.getPlugin(PluginId.getId("com.anthropic.code.plugin"));
            Icon icon = plugin == null || plugin.getPluginClassLoader() == null ? null : IconLoader.findIcon("icons/claude.svg", plugin.getPluginClassLoader());
            return icon != null ? icon : AllIcons.General.User;
        }

        private static void load(Project project) {
            String login = githubLogin(project);
            if (login == null) return;
            try {
                // At twice the size, to stay sharp on a HiDPI screen.
                byte[] png = HttpRequests.request("https://github.com/" + Server.encode(login) + ".png?size=" + 2 * USER.getIconWidth()).readBytes(null);
                BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
                if (image != null) github = ImageUtil.createCircleImage(image);
            } catch (IOException e) {
                // No network: the generic user stays.
            }
        }

        // ponytail: reflection rather than an optional dependency on the GitHub plugin in plugin.xml; a change of its API leaves the generic user.
        /** The login of the github.com account the GitHub plugin uses for the project, or null. */
        private static String githubLogin(Project project) {
            IdeaPluginDescriptor plugin = PluginManagerCore.getPlugin(PluginId.getId("org.jetbrains.plugins.github"));
            if (plugin == null || plugin.getPluginClassLoader() == null) return null;
            try {
                Class<?> accounts = Class.forName("org.jetbrains.plugins.github.authentication.GHAccountsUtil", true, plugin.getPluginClassLoader());
                Object account = accounts.getMethod("getSingleOrDefaultAccount", Project.class).invoke(null, project);
                if (account == null) return null;
                Object server = account.getClass().getMethod("getServer").invoke(account);
                if (!(Boolean) server.getClass().getMethod("isGithubDotCom").invoke(server)) return null;
                return (String) account.getClass().getMethod("getName").invoke(account);
            } catch (ReflectiveOperationException | RuntimeException e) {
                return null;
            }
        }
    }
}
