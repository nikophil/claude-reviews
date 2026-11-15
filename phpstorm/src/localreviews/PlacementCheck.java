package localreviews;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.List;

/** Run by build.sh: fails the build when Placement leaves out or lets in the wrong threads, or when raw HTML gets through a message. */
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
        System.out.println("PlacementCheck: ok");
    }

    private static List<Integer> ids(List<JsonObject> threads) {
        return threads.stream().map(thread -> thread.get("id").getAsInt()).toList();
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }
}
