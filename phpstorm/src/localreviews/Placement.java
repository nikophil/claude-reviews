package localreviews;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

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
     * The threads of `path`, of the whole session when null, by status: awaiting you, waiting for Claude, Resolved;
     * and the Pending messages the next Send would publish, so none of a Resolved thread.
     */
    static int[] counts(JsonObject session, String path) {
        int[] counts = new int[4];
        for (JsonElement element : session.getAsJsonArray("threads")) {
            JsonObject thread = element.getAsJsonObject();
            if (path != null && !thread.getAsJsonObject("anchor").get("path").getAsString().equals(path)) continue;
            JsonElement status = thread.get("status");
            String name = status == null || status.isJsonNull() ? "" : status.getAsString();
            if (name.equals("awaiting-you")) counts[0]++;
            if (name.equals("waiting-for-claude")) counts[1]++;
            if (thread.get("resolved").getAsBoolean()) {
                counts[3]++;
                continue;
            }
            for (JsonElement message : thread.getAsJsonArray("messages")) {
                JsonElement date = message.getAsJsonObject().get("date");
                if (date == null || date.isJsonNull()) counts[2]++;
            }
        }
        return counts;
    }

    /** Whether a Claude session reads the session, so that a Send reaches Claude; true from a server without the field. */
    static boolean claude(JsonObject session) {
        JsonElement claude = session.get("claudeSession");
        return claude == null || claude.getAsBoolean();
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
