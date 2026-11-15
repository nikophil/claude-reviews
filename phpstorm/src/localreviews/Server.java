package localreviews;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/** The claude-reviews server, through its HTTP API only, as the mod calls it: the token from the endpoint file, no Origin, 2 s at most per read, 10 s per write. */
final class Server {
    /** The endpoint file this account's server writes, with its port and token; read fresh on each call, as both change on a restart. */
    static final String ENDPOINT = dataHome() + "/claude-reviews/endpoint";
    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    private Server() {}

    private static String dataHome() {
        String xdg = System.getenv("XDG_DATA_HOME");
        return xdg != null && !xdg.isEmpty() ? xdg : System.getProperty("user.home") + "/.local/share";
    }

    /** An answer other than 200, with the server's error message. */
    static final class Failure extends IOException {
        private static final long serialVersionUID = 1L;
        final int status;

        Failure(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    static JsonObject get(String path) throws IOException {
        return call(request(path).GET()).getAsJsonObject();
    }

    /** A route that answers an array of objects, as /bases. */
    static List<JsonObject> getArray(String path) throws IOException {
        List<JsonObject> objects = new ArrayList<>();
        for (JsonElement element : call(request(path).GET()).getAsJsonArray()) objects.add(element.getAsJsonObject());
        return objects;
    }

    static JsonObject post(String path, JsonObject body) throws IOException {
        return call(request(path)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))).getAsJsonObject();
    }

    static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    /**
     * A request to `path`, aimed at the port of the running server and carrying its token; a missing or corrupt endpoint file means no server,
     * and a port another account listens on, a squatter of a dead server's port, gets neither my messages nor the trust of the view.
     */
    private static HttpRequest.Builder request(String path) throws IOException {
        int port;
        String token;
        try {
            JsonObject endpoint = JsonParser.parseString(Files.readString(Path.of(ENDPOINT))).getAsJsonObject();
            port = endpoint.get("port").getAsInt();
            token = endpoint.get("token").getAsString();
        } catch (IOException | RuntimeException e) {
            throw new IOException("no claude-reviews server: " + ENDPOINT + " is missing or unreadable", e);
        }
        if (foreign(port)) throw new IOException("the port of " + ENDPOINT + " is held by another account: start a Claude session with the local-reviews mod, which starts a server of your own");
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).header("Authorization", "Bearer " + token);
    }

    /** The uids of the sockets listening on `port`, from the text of /proc/net/tcp and /proc/net/tcp6. */
    static List<Integer> listeners(String text, int port) {
        String local = String.format(":%04X", port);
        List<Integer> uids = new ArrayList<>();
        // Each line: sl, local address:port, remote address:port, state (0A when listening), queues, timer, retransmits, uid…
        for (String line : text.split("\n")) {
            String[] fields = line.trim().split("\\s+");
            if (fields.length > 7 && fields[1].endsWith(local) && fields[3].equals("0A")) uids.add(Integer.parseInt(fields[7]));
        }
        return uids;
    }

    /** Whether another account listens on `port`, as /proc/net/tcp tells every account; false without /proc (macOS), a machine of one account. */
    private static boolean foreign(int port) {
        int uid;
        try {
            uid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        } catch (IOException | RuntimeException e) {
            return false;
        }
        StringBuilder text = new StringBuilder();
        for (String file : List.of("/proc/net/tcp", "/proc/net/tcp6")) {
            try {
                text.append(Files.readString(Path.of(file))).append('\n');
            } catch (IOException e) {
                // No IPv6: tcp alone tells.
            }
        }
        return listeners(text.toString(), port).stream().anyMatch(owner -> owner != uid);
    }

    private static JsonElement call(HttpRequest.Builder request) throws IOException {
        HttpResponse<String> response;
        try {
            // A write may wait for the others, a Send for its Snapshot too: a timeout would say it failed, though the server records it.
            HttpRequest built = request.build();
            response = CLIENT.send(request.timeout(Duration.ofSeconds(built.method().equals("GET") ? 2 : 10)).build(), HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted", e);
        }
        JsonElement json = JsonParser.parseString(response.body());
        if (response.statusCode() != 200) {
            JsonElement error = json.isJsonObject() ? json.getAsJsonObject().get("error") : null;
            throw new Failure(response.statusCode(), error == null ? "HTTP " + response.statusCode() : error.getAsString());
        }
        return json;
    }
}
