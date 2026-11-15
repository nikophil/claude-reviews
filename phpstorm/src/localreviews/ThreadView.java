package localreviews;

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
import com.intellij.ui.components.JBHtmlPane;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.panels.VerticalLayout;
import com.intellij.ui.hover.HoverStateListener;
import com.intellij.util.IconUtil;
import com.intellij.util.ThrowableConsumer;
import com.intellij.util.text.DateFormatUtil;
import com.intellij.util.io.HttpRequests;
import com.intellij.util.ui.ImageUtil;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.WrapLayout;

import javax.imageio.ImageIO;
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
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * A thread under its lines, written into as in the review of the GitHub plugin:
 * a field, and Ctrl+Enter adds a Pending message.
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
    private final JBLabel error = new JBLabel();
    private final JButton other;
    private static final Color PENDING = new JBColor(new Color(0xB86E00), new Color(0xD9A343));
    private final JButton add = button("Add pending", null);
    private JButton send;
    private final JBLabel shortcutHint = hint(KeymapUtil.getFirstKeyboardShortcutText(CommonShortcuts.getCtrlEnter()) + " to add pending");
    private boolean folded;
    private boolean resolved;
    private volatile boolean hovered;

    /** An open thread of the session. */
    ThreadView(Project project, JsonObject session, JsonObject thread, Runnable written) {
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
        messages(project, thread.getAsJsonArray("messages"));
        // At the bottom too: the header of a long thread is out of sight.
        if (waiting && claude) content.add(hint("Waiting for Claude…"));
        if (waiting && !claude) content.add(startClaude(session));
        field = field(project, "Reply");
        // A Resolved thread takes no message until its Unresolve.
        other = resolved ? button("Unresolve", AllIcons.Actions.Rollback) : button("Resolve", AllIcons.Actions.Checked);
        String toggle = route + (resolved ? "/unresolve" : "/resolve");
        other.addActionListener(e -> write(body -> Server.post(toggle, new JsonObject()), written));
        // Sends this thread alone, without the Pending messages of the others; it spins, the only spinner, until Claude answers the thread.
        boolean spinning = ReviewService.get(project).spinning("thread:" + id, thread);
        if (!resolved && claude && (pending(thread) || spinning)) {
            JButton button = button("Send thread", AllIcons.Actions.Upload);
            send = button;
            spin(button, spinning, AllIcons.Actions.Upload);
            button.setEnabled(pending(thread));
            button.addActionListener(e -> {
                button.setEnabled(false);
                spin(button, true, AllIcons.Actions.Upload);
                WriteIntentReadAction.run(() -> ReviewDiffAction.send(project, sessionId, id, null, written));
            });
        }
        finish(body -> Server.post(route + "/messages", reply(body)), written);
        if (resolved) {
            field.setVisible(false);
            add.setVisible(false);
            shortcutHint.setVisible(false);
        }
        // A Resolved thread shows folded, its discussion one click away.
        if (resolved) fold();
    }

    /** A new thread, saved by `create` with its first message. */
    ThreadView(Project project, ThrowableConsumer<String, IOException> create, Runnable cancel, Runnable written) {
        super(null);
        card.add(header("New thread", ""));
        field = field(project, "Comment");
        other = button("Cancel", null);
        // Removing the inlay changes the editor: a bare Swing listener needs the write-intent lock for it.
        other.addActionListener(e -> WriteIntentReadAction.run(cancel));
        finish(create, written);
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

    /** Takes over the text being typed in the view this one replaces, its focus, and whether it is folded unless it got resolved or reopened. */
    void resume(ThreadView previous) {
        field.setText(previous.field.getText());
        if (previous.resolved == resolved && previous.folded != folded) fold();
        // No focus owner while the IDE is in the background.
        Component owner = KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner();
        if (owner != null && SwingUtilities.isDescendingFrom(owner, previous.field)) {
            field.requestFocusInWindow();
        }
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

    private void fold() {
        folded = !folded;
        content.setVisible(!folded);
        title.setIcon(folded ? AllIcons.General.ArrowRight : AllIcons.General.ArrowDown);
        revalidate();
        repaint();
    }

    /** The messages, a turn per run of messages of the same author: its avatar, its name, then each message; a line between turns. */
    private void messages(Project project, Iterable<JsonElement> messages) {
        List<List<JsonObject>> turns = new ArrayList<>();
        for (JsonElement element : messages) {
            JsonObject message = element.getAsJsonObject();
            List<JsonObject> last = turns.isEmpty() ? null : turns.get(turns.size() - 1);
            // My Pending messages make a turn of their own, all of it in the color of Pending.
            if (last != null && author(last.get(0)).equals(author(message)) && unsent(last.get(0)) == unsent(message)) last.add(message);
            else turns.add(new ArrayList<>(List.of(message)));
        }
        for (List<JsonObject> turn : turns) {
            if (content.getComponentCount() > 0) content.add(new JSeparator());
            String author = author(turn.get(0));
            boolean unsent = unsent(turn.get(0));
            JPanel column = new JPanel(new VerticalLayout(JBUI.scale(4)));
            column.setOpaque(false);
            JBLabel name = new JBLabel(author);
            name.setFont(JBUI.Fonts.label().asBold());
            // In a row of its own: the vertical layout would stretch the badge over the width.
            JPanel nameRow = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0));
            nameRow.setOpaque(false);
            nameRow.add(name);
            if (unsent) nameRow.add(badge());
            column.add(nameRow);
            for (JsonObject message : turn) {
                if (!unsent) column.add(hint(when(message)));
                column.add(body(project, message.get("body").getAsString()));
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

    private void finish(ThrowableConsumer<String, IOException> addPending, Runnable written) {
        add.addActionListener(e -> {
            if (!field.getText().isBlank()) write(addPending, written);
        });
        ClientProperty.put(add, DarculaButtonUI.DEFAULT_STYLE_KEY, true);
        DumbAwareAction.create(e -> add.doClick()).registerCustomShortcutSet(CommonShortcuts.getCtrlEnter(), field);
        content.add(field);
        error.setForeground(JBColor.RED);
        error.setVisible(false);
        content.add(error);
        // In a narrow column, the hint and the buttons wrap onto more rows rather than running out of the card.
        JPanel footer = new JPanel(new WrapLayout(FlowLayout.RIGHT, JBUI.scale(6), JBUI.scale(4)));
        footer.setOpaque(false);
        footer.add(shortcutHint);
        if (send != null) footer.add(send);
        footer.add(other);
        footer.add(add);
        content.add(footer);
        content.setOpaque(false);
        card.add(content);
        card.setOpaque(false);
        card.setBorder(BorderFactory.createCompoundBorder(new RoundedLineBorder(JBColor.border(), JBUI.scale(8), 1), JBUI.Borders.empty(8, 10)));
        setOpaque(false);
        add(card);
    }

    /** Runs a write off the EDT: on success the field empties and `written` runs, on failure the error shows and the text stays. */
    private void write(ThrowableConsumer<String, IOException> action, Runnable written) {
        String body = field.getText().strip();
        other.setEnabled(false);
        add.setEnabled(false);
        ModalityState modality = ModalityState.stateForComponent(this);
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            String failure = null;
            try {
                action.consume(body);
            } catch (IOException e) {
                failure = e.getMessage() != null ? e.getMessage() : "The claude-reviews server does not answer on " + Server.URL;
            }
            String shown = failure;
            ApplicationManager.getApplication().invokeLater(() -> {
                other.setEnabled(true);
                add.setEnabled(true);
                error.setText(shown);
                error.setVisible(shown != null);
                if (shown == null) {
                    field.setText("");
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

    /** The thread's place, else, Outdated, the lines of its Anchor. */
    static String lines(JsonObject thread) {
        JsonObject anchor = thread.getAsJsonObject("anchor");
        JsonObject at = thread.get("at") instanceof JsonObject placed ? placed : anchor;
        String sign = anchor.get("side").getAsString().equals("old") ? "-" : "+";
        int start = at.get("start").getAsInt();
        int end = at.get("end").getAsInt();
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
        body.setText(IMAGE.matcher(html).replaceAll(""));
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

    /** Raw HTML shows as text, as in the web page: `<` is escaped outside code blocks and code spans, whose text shows as written. */
    static String escapeHtml(String markdown) {
        StringBuilder escaped = new StringBuilder();
        boolean fence = false;
        for (String line : markdown.split("\n", -1)) {
            if (line.strip().startsWith("```")) {
                fence = !fence;
            } else if (!fence) {
                String[] parts = line.split("`", -1);
                for (int i = 0; i < parts.length; i += 2) parts[i] = parts[i].replace("<", "&lt;");
                line = String.join("`", parts);
            }
            escaped.append(line).append('\n');
        }
        return escaped.toString();
    }

    private static EditorTextField field(Project project, String placeholder) {
        EditorTextField field = new EditorTextField("", project, FileTypes.PLAIN_TEXT);
        field.setOneLineMode(false);
        field.setPlaceholder(placeholder);
        field.addSettingsProvider(editor -> editor.getSettings().setUseSoftWraps(true));
        field.setBorder(BorderFactory.createCompoundBorder(new RoundedLineBorder(JBColor.border(), JBUI.scale(6), 1), JBUI.Borders.empty(4, 6)));
        return field;
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
