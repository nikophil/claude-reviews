package localreviews;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Which threads of a session go on one side of one file, placed in the code the session was asked about. */
final class Placement {
    private Placement() {}

    /** The threads of `path` on `side` that have a place `at`, Resolved ones included, in the order of the session. */
    static List<JsonObject> threads(JsonObject session, String path, String side) {
        List<JsonObject> placed = new ArrayList<>();
        for (JsonElement element : session.getAsJsonArray("threads")) {
            JsonObject thread = element.getAsJsonObject();
            JsonObject anchor = thread.getAsJsonObject("anchor");
            JsonElement at = thread.get("at");
            if (at == null || at.isJsonNull()) continue;
            if (anchor.get("path").getAsString().equals(path) && anchor.get("side").getAsString().equals(side)) placed.add(thread);
        }
        return placed;
    }

    /**
     * The threads of `path`, of the whole session when null, the threads waiting for Claude, the Pending messages the next Send would publish,
     * so none of a Resolved thread, and the Resolved threads.
     */
    static int[] counts(JsonObject session, String path) {
        int[] counts = new int[3];
        for (JsonElement element : session.getAsJsonArray("threads")) {
            JsonObject thread = element.getAsJsonObject();
            if (path != null && !thread.getAsJsonObject("anchor").get("path").getAsString().equals(path)) continue;
            JsonElement status = thread.get("status");
            String name = status == null || status.isJsonNull() ? "" : status.getAsString();
            if (name.equals("waiting-for-claude")) counts[0]++;
            if (thread.get("resolved").getAsBoolean()) {
                counts[2]++;
                continue;
            }
            for (JsonElement message : thread.getAsJsonArray("messages")) {
                JsonElement date = message.getAsJsonObject().get("date");
                if (date == null || date.isJsonNull()) counts[1]++;
            }
        }
        return counts;
    }

    /** Whether a Claude session reads the session, so that a Send reaches Claude; true from a server without the field. */
    static boolean claude(JsonObject session) {
        JsonElement claude = session.get("claudeSession");
        return claude == null || claude.getAsBoolean();
    }

    private static boolean approved(JsonObject session) {
        return session.get("approvedAt") instanceof JsonPrimitive;
    }

    /** Why Send is greyed, null while it is enabled: a Send without a Pending message still takes its Snapshot. */
    static String sendRefusal(JsonObject session) {
        if (approved(session)) return "The session is approved";
        return claude(session) ? null : "Start a Claude session in this worktree to send to Claude: " + startClaude(session);
    }

    /** Why Approve is greyed, null while it is enabled: the Pending messages of a Resolved thread stay Pending, as a Send leaves them. */
    static String approveRefusal(JsonObject session) {
        if (approved(session)) return "The session is approved";
        int pending = counts(session, null)[1];
        return pending == 0 ? null : "Send the " + pending + (pending == 1 ? " pending message" : " pending messages") + " first";
    }

    /** Whether Claude answered every thread waiting for it between two reads of a session: it wrote, and none waits any more. */
    static boolean repliedEverywhere(JsonObject before, JsonObject after) {
        return before.get("id").equals(after.get("id")) && ThreadsInDiff.waiting(before) > 0 && ThreadsInDiff.waiting(after) == 0
            && fromClaude(after) > fromClaude(before);
    }

    private static int fromClaude(JsonObject session) {
        int messages = 0;
        for (JsonElement thread : session.getAsJsonArray("threads")) {
            for (JsonElement message : thread.getAsJsonObject().getAsJsonArray("messages")) {
                if (message.getAsJsonObject().get("author").getAsString().equals("claude")) messages++;
            }
        }
        return messages;
    }

    /** The path of `file` from the worktree root `root`, both compared as real paths, through symlinks; null out of the worktree. */
    static String relative(String root, String file) {
        Path base = real(Path.of(root));
        Path path = real(Path.of(file));
        return path.startsWith(base) && !path.equals(base) ? base.relativize(path).toString() : null;
    }

    /** The real path, that of its nearest existing parent for a file that is no longer there. */
    private static Path real(Path path) {
        try {
            return path.toRealPath();
        } catch (IOException e) {
            Path parent = path.toAbsolutePath().getParent();
            return parent == null ? path.toAbsolutePath() : real(parent).resolve(path.getFileName());
        }
    }

    /** The shell command that starts a Claude session in the worktree of the session. */
    static String startClaude(JsonObject session) {
        String worktree = session.get("worktree").getAsString();
        return "cd " + (worktree.matches("[\\w./-]+") ? worktree : "'" + worktree.replace("'", "'\\''") + "'") + " && claude";
    }

    /** The last line of the thread's place, from 1. */
    static int end(JsonObject thread) {
        return thread.getAsJsonObject("at").get("end").getAsInt();
    }
}
