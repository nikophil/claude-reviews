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
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/** The claude-reviews server, through its HTTP API only, as the mod calls it: no Origin, 2 s at most per call. */
final class Server {
    static final String URL = "http://127.0.0.1:" + System.getenv().getOrDefault("CLAUDE_REVIEWS_PORT", "7778");
    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    private Server() {}

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
        return call(HttpRequest.newBuilder(URI.create(URL + path)).GET()).getAsJsonObject();
    }

    /** A route that answers an array of objects, as /bases. */
    static List<JsonObject> getArray(String path) throws IOException {
        List<JsonObject> objects = new ArrayList<>();
        for (JsonElement element : call(HttpRequest.newBuilder(URI.create(URL + path)).GET()).getAsJsonArray()) objects.add(element.getAsJsonObject());
        return objects;
    }

    static JsonObject post(String path, JsonObject body) throws IOException {
        return call(HttpRequest.newBuilder(URI.create(URL + path))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))).getAsJsonObject();
    }

    static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static JsonElement call(HttpRequest.Builder request) throws IOException {
        HttpResponse<String> response;
        try {
            response = CLIENT.send(request.timeout(Duration.ofSeconds(2)).build(), HttpResponse.BodyHandlers.ofString());
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
