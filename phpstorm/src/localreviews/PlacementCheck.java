package localreviews;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import javax.swing.tree.DefaultMutableTreeNode;
import javax.swing.tree.TreeNode;
import java.util.Collections;
import java.util.List;

/**
 * Run by build.sh: fails the build when Placement leaves out or lets in the wrong threads, when raw HTML gets through a message,
 * or when the navigation, the Replied mark, a suggestion or the Markdown copy of the threads goes wrong,
 * when the listeners of a port, read in /proc/net/tcp to tell a server of another account, come out wrong,
 * when the files of the tool window group wrong by directory, or when the window of a thread cuts its excerpt wrong.
 */
final class PlacementCheck {
    private PlacementCheck() {}

    public static void main(String[] args) throws java.io.IOException {
        JsonObject session = JsonParser.parseString("""
            { "threads": [
              { "id": 1, "resolved": false, "anchor": { "path": "a.php", "side": "new" }, "at": { "start": 2, "end": 3 } },
              { "id": 2, "resolved": false, "anchor": { "path": "a.php", "side": "old" }, "at": { "start": 5, "end": 5 } },
              { "id": 3, "resolved": true, "anchor": { "path": "a.php", "side": "new" }, "at": { "start": 7, "end": 7 } },
              { "id": 4, "resolved": false, "anchor": { "path": "a.php", "side": "new" }, "at": null },
              { "id": 5, "resolved": false, "anchor": { "path": "b.php", "side": "new" }, "at": { "start": 1, "end": 1 } },
              { "id": 6, "resolved": false, "anchor": { "path": "a.php", "side": "new" }, "at": { "start": 9, "end": 12 } }
            ] }""").getAsJsonObject();

        check(ids(Placement.threads(session, "a.php", "new")).equals(List.of(1, 3, 6)), "the placed threads of a.php on the new side, Resolved included");
        check(ids(Placement.threads(session, "a.php", "old")).equals(List.of(2)), "the thread of a.php on the old side");
        check(Placement.end(Placement.threads(session, "a.php", "new").get(2)) == 12, "the last line of a thread's place");
        check(Placement.startClaude(JsonParser.parseString("{ \"worktree\": \"/home/me/src/app\" }").getAsJsonObject()).equals("cd /home/me/src/app && claude"), "the command that starts a Claude session");
        check(Placement.startClaude(JsonParser.parseString("{ \"worktree\": \"/home/me/my app's\" }").getAsJsonObject()).equals("cd '/home/me/my app'\\''s' && claude"), "the command quotes a worktree with a space or a quote");
        check(!Placement.claude(JsonParser.parseString("{ \"claudeSession\": false }").getAsJsonObject()), "no Claude session reads the session");
        check(Placement.claude(new JsonObject()), "a server without the field takes a Claude session for granted");
        JsonArray diffed = JsonParser.parseString("[{ \"path\": \"c.php\" }]").getAsJsonArray();
        check(Placement.navigable(session, diffed, "b.php") && Placement.navigable(session, diffed, "c.php") && !Placement.navigable(session, diffed, "README.md"),
            "the arrows of the threads in a file of an unresolved thread or of the diff, not in another one");
        JsonObject resolved = JsonParser.parseString("{ \"threads\": [{ \"id\": 1, \"resolved\": true, \"anchor\": { \"path\": \"c.php\", \"side\": \"new\" } }] }").getAsJsonObject();
        check(!Placement.navigable(resolved, diffed, "c.php"), "no arrows once every thread is Resolved");
        check(Placement.blocked(JsonParser.parseString("{ \"claudeBlocked\": true }").getAsJsonObject()) && !Placement.blocked(new JsonObject()), "Blocked as the server says, never from a server without the field");
        JsonObject statuses = JsonParser.parseString("""
            { "threads": [
              { "id": 1, "resolved": false, "status": "open", "anchor": { "path": "a.php", "side": "new" }, "messages": [{ "date": "x" }, { "date": null }] },
              { "id": 2, "resolved": false, "status": "open", "anchor": { "path": "a.php", "side": "old" }, "messages": [{ "date": "x" }] },
              { "id": 3, "resolved": false, "status": "waiting-for-claude", "anchor": { "path": "a.php", "side": "new" }, "messages": [{ "date": "x" }] },
              { "id": 4, "resolved": true, "status": "resolved", "anchor": { "path": "a.php", "side": "new" }, "messages": [{ "date": null }] },
              { "id": 5, "resolved": false, "status": "open", "anchor": { "path": "b.php", "side": "new" }, "messages": [{ "date": "x" }] }
            ] }""").getAsJsonObject();
        check(java.util.Arrays.equals(Placement.counts(statuses, "a.php"), new int[] {1, 1, 1}), "waiting for Claude, Pending outside Resolved threads, Resolved, of one file");
        check(java.util.Arrays.equals(Placement.counts(statuses, null), new int[] {1, 1, 1}), "the same counts for the whole session");
        check(ThreadView.status(statuses.getAsJsonArray("threads").get(0).getAsJsonObject()).isEmpty(), "an open thread shows no status");
        JsonObject resolvedPending = JsonParser.parseString("""
            { "claudeSession": true, "approvedAt": null, "threads": [
              { "id": 1, "resolved": true, "status": "resolved", "anchor": { "path": "a.php", "side": "new" }, "messages": [{ "author": "me", "date": null }] }
            ] }""").getAsJsonObject();
        JsonObject approved = resolvedPending.deepCopy();
        approved.addProperty("approvedAt", "2026-11-14T10:00:00.000Z");
        check(Placement.approveRefusal(statuses) != null, "Approve greyed while a thread not Resolved has a Pending message");
        check(Placement.approveRefusal(resolvedPending) == null, "the Pending messages of a Resolved thread let Approve through");
        check(Placement.approveRefusal(approved) != null && Placement.sendRefusal(approved) != null, "Approve and Send greyed on an approved session");
        check(Placement.sendRefusal(resolvedPending) == null, "a Send without a Pending message takes its Snapshot");
        check(Placement.sendRefusal(JsonParser.parseString("{ \"claudeSession\": false, \"worktree\": \"/a\", \"threads\": [] }").getAsJsonObject()) != null, "Send greyed without a Claude session");
        JsonObject waiting = JsonParser.parseString("""
            { "id": "s", "threads": [{ "id": 1, "resolved": false, "status": "waiting-for-claude", "messages": [{ "author": "me", "date": "x" }] }] }""").getAsJsonObject();
        JsonObject resolvedByMe = JsonParser.parseString("""
            { "id": "s", "threads": [{ "id": 1, "resolved": true, "status": "resolved", "messages": [{ "author": "me", "date": "x" }] }] }""").getAsJsonObject();
        JsonObject answered = JsonParser.parseString("""
            { "id": "s", "threads": [{ "id": 1, "resolved": false, "status": "open", "messages": [{ "author": "me", "date": "x" }, { "author": "claude", "date": "y" }] }] }""").getAsJsonObject();
        check(Placement.repliedEverywhere(waiting, answered), "Claude replied in every thread");
        check(!Placement.repliedEverywhere(waiting, resolvedByMe), "no notification when I resolve the last thread waiting for Claude");
        java.nio.file.Path tmp = java.nio.file.Files.createTempDirectory("placement");
        java.nio.file.Path repo = java.nio.file.Files.createDirectories(tmp.resolve("repo/sub"));
        java.nio.file.Path file = java.nio.file.Files.createFile(repo.resolve("a.php"));
        java.nio.file.Path link = java.nio.file.Files.createSymbolicLink(tmp.resolve("link"), tmp.resolve("repo"));
        for (java.nio.file.Path made : List.of(tmp, tmp.resolve("repo"), repo, file, link)) made.toFile().deleteOnExit();
        check("sub/a.php".equals(Placement.relative(tmp.resolve("repo").toString(), file.toString())), "a file of the worktree, opened in a sub-folder of it");
        check("sub/a.php".equals(Placement.relative(tmp.resolve("repo").toString(), link.resolve("sub/a.php").toString())), "a file reached through a symlink");
        check("sub/gone/b.php".equals(Placement.relative(link.toString(), repo.resolve("gone/b.php").toString())), "a deleted file of the worktree");
        check(Placement.relative(repo.toString(), tmp.resolve("repo/c.php").toString()) == null, "a file out of the worktree");
        check(ThreadView.lines(session.getAsJsonArray("threads").get(1).getAsJsonObject()).equals("Line -5"), "the place of a thread on the old side");
        JsonObject outdated = JsonParser.parseString("""
            { "anchor": { "side": "new", "start": 3, "end": 5 }, "at": null }""").getAsJsonObject();
        check(ThreadView.lines(outdated).equals("Lines +3 to +5"), "an Outdated thread at the lines of its Anchor");
        JsonObject belowDeletion = JsonParser.parseString("""
            { "side": "new", "start": 3, "end": 4, "hunk": { "header": "@@ -1,9 +1,4 @@", "lines": [
              { "type": "context", "oldNo": 1, "newNo": 1, "text": "a" }, { "type": "context", "oldNo": 2, "newNo": 2, "text": "b" },
              { "type": "del", "oldNo": 3, "newNo": null, "text": "x1" }, { "type": "del", "oldNo": 4, "newNo": null, "text": "x2" },
              { "type": "del", "oldNo": 5, "newNo": null, "text": "x3" }, { "type": "del", "oldNo": 6, "newNo": null, "text": "x4" },
              { "type": "context", "oldNo": 7, "newNo": 3, "text": "c" }, { "type": "del", "oldNo": 8, "newNo": null, "text": "y" },
              { "type": "add", "oldNo": null, "newNo": 4, "text": "d" }] } }""").getAsJsonObject();
        check(ThreadWindow.excerpt(belowDeletion).equals("-x2\n-x3\n-x4\n c\n-y\n+d"), "the excerpt of a thread from 3 lines above its range, whatever their side");
        JsonObject nearTop = JsonParser.parseString("""
            { "side": "old", "start": 2, "end": 2, "hunk": { "header": "@@ -1,2 +1,1 @@", "lines": [
              { "type": "context", "oldNo": 1, "newNo": 1, "text": "a" }, { "type": "del", "oldNo": 2, "newNo": null, "text": "b" }] } }""").getAsJsonObject();
        check(ThreadWindow.excerpt(nearTop).equals("@@ -1,2 +1,1 @@\n a\n-b"), "a whole excerpt keeps its header");
        JsonObject outOfDiff = JsonParser.parseString("""
            { "side": "new", "start": 7, "end": 8, "hunk": null, "lines": ["e", "f"] }""").getAsJsonObject();
        check(ThreadWindow.excerpt(outOfDiff).equals("e\nf"), "the lines of an Anchor out of the diff");
        check(ThreadView.escapeHtml("a <img src=x> `<b>` b").equals("a &lt;img src=x> `<b>` b"), "raw HTML escaped outside a code span, kept in it");
        check(ThreadView.escapeHtml("```php\n$a = <<<X;\n```\n<i>").equals("```php\n$a = <<<X;\n```\n&lt;i>"), "raw HTML escaped after a code block, kept in it");
        check(ThreadView.escapeHtml("~~~\n<?php\n~~~").equals("~~~\n<?php\n~~~"), "a code block of tildes kept as written");
        check(ThreadView.escapeHtml("`<?php`").equals("`<?php`"), "a code span kept as written");
        check(ThreadView.escapeHtml("``a<b``").equals("``a<b``"), "a code span of two backticks kept as written");
        // Each of these reaches the converter as raw HTML unless escaped.
        for (String raw : List.of(
            "a ` <p style=x>", "\\`<p>`", "    ```\n<p>", "```x`\n<p>", "- a\n  ```\n<p>",
            "`a\\`<p>`", "x `a\n`<p>` y`", "```\nx\r```\n<p>\n```", "```\n```\t\n<p>\n```", "```\n    ```\n<p>\n```",
            "  ```\nx\n```\n<p>\n```", "  ~~~\nx\n~~~\n<p>\n~~~", "~~~ x`\n<p>\n~~~", "- ~~~\n  ~~~\n<p>",
            "~~~\n| a |\n|---|\n~~~\nx\n~~~\n<p>\n~~~", "[a]:\n```\n<p>\n```", "[a\n```\nb]: /u\n<p>", "-[ ] [a]:\n```\n<p>\n```", "```\n- ```\n<p>")) {
            check(!ThreadView.escapeHtml(raw).contains("<p"), "raw HTML escaped: " + raw);
        }
        check(ThreadView.name("me").equals("You") && ThreadView.name("claude").equals("Claude"), "the authors named as in the web page");
        check(ThreadView.withoutLoads("<p style=\"background-image:url(http://h/)\">a</p><td background='http://h/'>").equals("<p>a</p><td>"), "no attribute that loads a URL");
        check(ThreadView.withoutLoads("<span style=\"color:#0033b3;background-color:#fff\">url(a)</span>").equals("<span style=\"color:#0033b3;background-color:#fff\">url(a)</span>"), "the colors of the code and its text kept");
        check(ThreadView.withoutLoads("<object classid=\"javax.swing.JButton\"></object><link rel=stylesheet href=http://h/><p>a</p>")
            .equals("&lt;object classid=\"javax.swing.JButton\">&lt;/object>&lt;link rel=stylesheet href=http://h/><p>a</p>"), "a tag the converter never writes shows as text");

        JsonObject wholeFile = JsonParser.parseString("""
            { "threads": [
              { "id": 1, "resolved": false, "anchor": { "path": "a.php", "side": "new", "start": 0, "end": 0 }, "at": { "start": 0, "end": 0 } },
              { "id": 2, "resolved": false, "anchor": { "path": "a.php", "side": "old", "start": 0, "end": 0 }, "at": null }
            ] }""").getAsJsonObject();
        check(ids(Placement.threads(wholeFile, "a.php", "new")).equals(List.of(1)), "a thread on the whole file placed while its file is there");
        check(ThreadView.lines(wholeFile.getAsJsonArray("threads").get(0).getAsJsonObject()).equals("File"), "a thread on the whole file reads File");
        check(ThreadView.lines(wholeFile.getAsJsonArray("threads").get(1).getAsJsonObject()).equals("File"), "an Outdated thread on the whole file reads File too");

        JsonObject sent = JsonParser.parseString("""
            { "sentAt": "2026-11-14T10:05:00.000Z", "threads": [
              { "id": 1, "resolved": false, "messages": [{ "author": "me", "date": "2026-11-14T10:05:00.000Z" }, { "author": "claude", "date": "2026-11-14T10:06:00.000Z" }] },
              { "id": 2, "resolved": false, "messages": [{ "author": "claude", "date": "2026-11-14T10:04:00.000Z" }, { "author": "me", "date": "2026-11-14T10:05:00.000Z" }] },
              { "id": 3, "resolved": false, "messages": [{ "author": "claude", "date": "2026-11-14T10:05:00.000Z" }] },
              { "id": 4, "resolved": true, "messages": [{ "author": "me", "date": "2026-11-14T10:05:00.000Z" }, { "author": "claude", "date": "2026-11-14T10:06:00.000Z" }] }
            ] }""").getAsJsonObject();
        JsonArray sentThreads = sent.getAsJsonArray("threads");
        check(Placement.replied(sent, sentThreads.get(0).getAsJsonObject()), "Claude replied after my last Send");
        check(!Placement.replied(sent, sentThreads.get(1).getAsJsonObject()), "Claude wrote before my last Send only");
        check(Placement.replied(sent, sentThreads.get(2).getAsJsonObject()), "Claude wrote at the date of my last Send");
        check(!Placement.replied(sent, sentThreads.get(3).getAsJsonObject()), "no Replied on a Resolved thread, as in the web page");
        JsonObject neverSent = sent.deepCopy();
        neverSent.remove("sentAt");
        check(!Placement.replied(neverSent, sentThreads.get(0).getAsJsonObject()), "nothing replied before the first Send");

        List<Boolean> stops = List.of(false, true, false, true, true, false);
        check(Placement.step(stops, -1, true) == 1 && Placement.step(stops, -1, false) == 4, "from no selection, the first or the last thread");
        check(Placement.step(stops, 1, true) == 3 && Placement.step(stops, 3, false) == 1, "the next and the previous thread");
        check(Placement.step(stops, 4, true) == 1 && Placement.step(stops, 1, false) == 4, "around at the ends");
        check(Placement.step(stops, 2, true) == 3 && Placement.step(stops, 2, false) == 1, "from a file, the thread after or before it");
        check(Placement.step(List.of(false, true), 1, true) == 1, "the only thread stays");
        check(Placement.step(List.of(false, false), -1, true) == -1, "no thread to go to");

        check(ThreadView.suggestion("", "a\n  b").equals("```suggestion\na\n  b\n```"), "a suggestion of the lines of the thread");
        check(ThreadView.suggestion("Rather:", "a").equals("Rather:\n```suggestion\na\n```"), "a suggestion on its own lines, after the text typed");
        check(ThreadView.suggestion("Rather:\n", "a").equals("Rather:\n```suggestion\na\n```"), "no blank line added after a line break");
        check(ThreadView.suggestion("", "```php\n````").equals("`````suggestion\n```php\n````\n`````"), "a fence longer than the backticks of the lines");

        JsonObject copied = JsonParser.parseString("""
            { "threads": [
              { "id": 1, "resolved": false, "status": "waiting-for-claude", "anchor": { "path": "a.txt", "side": "new", "start": 2, "end": 2 }, "at": { "start": 2, "end": 2 },
                "messages": [{ "author": "me", "body": "Why?", "date": "x" }, { "author": "me", "body": "Not sent", "date": null }] },
              { "id": 2, "resolved": false, "status": null, "anchor": { "path": "a.txt", "side": "new", "start": 5, "end": 5 }, "at": { "start": 5, "end": 5 },
                "messages": [{ "author": "me", "body": "Pending only", "date": null }] },
              { "id": 3, "resolved": true, "status": "resolved", "anchor": { "path": "src/b.php", "side": "old", "start": 3, "end": 4 }, "at": { "start": 3, "end": 4 },
                "messages": [{ "author": "me", "body": "Gone?\\n\\n- yes", "date": "x" }] },
              { "id": 4, "resolved": false, "status": "open", "anchor": { "path": "c.md", "side": "new", "start": 0, "end": 0 }, "at": { "start": 0, "end": 0 },
                "messages": [{ "author": "me", "body": "Split it", "date": "x" }, { "author": "claude", "body": "Because…", "date": "y" }] }
            ] }""").getAsJsonObject();
        check(ThreadView.markdown(copied).equals("""
            ### `a.txt` line +2 · Waiting for Claude

            **You**: Why?

            ### `src/b.php` lines -3 to -4 · Resolved

            **You**: Gone?

            - yes

            ### `c.md` file

            **You**: Split it

            **Claude**: Because…
            """), "the threads with a sent message as Markdown, Pending messages left out, ended by a newline as in the web page");
        check(ThreadView.markdown(JsonParser.parseString("{ \"threads\": [] }").getAsJsonObject()).isEmpty(), "no thread, no Markdown");
        // /proc/net/tcp then /proc/net/tcp6: a listener of uid 1000 on 127.0.0.1:0xA609, a connection of uid 1001 from that port,
        // a listener of 1001 on 0.0.0.0:7778, one of 1002 on [::ffff:127.0.0.1]:0xA609.
        String proc = """
              sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
               0: 0100007F:A609 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 84322 1 0000000000000000 100 0 0 10 0
               1: 0100007F:A609 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1001        0 0 1 0000000000000000 20 4 30 10 -1
               2: 00000000:1E62 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 7964741 1 0000000000000000 100 0 0 10 0
               0: 0000000000000000FFFF00000100007F:A609 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 10494914 1 0000000000000000 100 0 0 10 0
            """;
        check(Server.listeners(proc, 0xA609).equals(List.of(1000, 1002)), "the listeners of a port, IPv4 or IPv6, a connection from it left out");
        check(Server.listeners(proc, 7778).equals(List.of(1001)), "a listener on any address");
        check(Server.listeners(proc, 1234).isEmpty(), "no listener on a free port");

        DefaultMutableTreeNode root = new DefaultMutableTreeNode();
        for (String path : List.of("a.php", "src/Mapping/Driver/XmlDriver.php", "src/Tools/Validator.php", "tests/ORM/Mapping/A.php", "tests/ORM/Mapping/xml/User.xml", "tests/ORM/Tools/T.php")) {
            JsonObject changed = new JsonObject();
            changed.addProperty("path", path);
            DefaultMutableTreeNode node = new DefaultMutableTreeNode(changed);
            node.add(new DefaultMutableTreeNode("#1"));
            root.add(node);
        }
        ReviewToolWindow.Dir.group(root);
        check(tree(root, "").equals("""
            src
              Mapping/Driver
                XmlDriver.php
                  #1
              Tools
                Validator.php
                  #1
            tests/ORM
              Mapping
                xml
                  User.xml
                    #1
                A.php
                  #1
              Tools
                T.php
                  #1
            a.php
              #1
            """), "the files under their directories, the directories first, a directory that holds only a directory merged with it");
        check(((ReviewToolWindow.Dir) ((DefaultMutableTreeNode) root.getFirstChild().getChildAt(0)).getUserObject()).path().equals("src/Mapping/Driver"), "a merged directory keeps the path of the deepest");
        System.out.println("PlacementCheck: ok");
    }

    private static String tree(TreeNode node, String indent) {
        StringBuilder text = new StringBuilder();
        for (TreeNode child : Collections.list(node.children())) {
            Object shown = ((DefaultMutableTreeNode) child).getUserObject();
            String path = shown instanceof JsonObject file ? file.get("path").getAsString() : null;
            text.append(indent).append(shown instanceof ReviewToolWindow.Dir dir ? dir.name() : path != null ? path.substring(path.lastIndexOf('/') + 1) : shown).append('\n');
            text.append(tree(child, indent + "  "));
        }
        return text.toString();
    }

    private static List<Integer> ids(List<JsonObject> threads) {
        return threads.stream().map(thread -> thread.get("id").getAsInt()).toList();
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }
}
