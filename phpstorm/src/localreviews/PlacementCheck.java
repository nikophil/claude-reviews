package localreviews;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.List;

/** Run by build.sh: fails the build when Placement leaves out or lets in the wrong threads, or when raw HTML gets through a message. */
final class PlacementCheck {
    private PlacementCheck() {}

    public static void main(String[] args) {
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
        check(ThreadView.lines(session.getAsJsonArray("threads").get(1).getAsJsonObject()).equals("Line -5"), "the place of a thread on the old side");
        JsonObject outdated = JsonParser.parseString("""
            { "anchor": { "side": "new", "start": 3, "end": 5 }, "at": null }""").getAsJsonObject();
        check(ThreadView.lines(outdated).equals("Lines +3 to +5"), "an Outdated thread at the lines of its Anchor");
        check(ThreadView.escapeHtml("a <img src=x> `<b>` b").equals("a &lt;img src=x> `<b>` b\n"), "raw HTML escaped outside a code span, kept in it");
        check(ThreadView.escapeHtml("```php\n$a = <<<X;\n```\n<i>").equals("```php\n$a = <<<X;\n```\n&lt;i>\n"), "raw HTML escaped after a code block, kept in it");
        System.out.println("PlacementCheck: ok");
    }

    private static List<Integer> ids(List<JsonObject> threads) {
        return threads.stream().map(thread -> thread.get("id").getAsInt()).toList();
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }
}
