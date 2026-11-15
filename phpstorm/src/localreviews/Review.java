package localreviews;

import com.intellij.openapi.util.Key;

/** The session, worktree root, base id and file of a diff of the review: the threads of that diff come from them. */
record Review(String session, String root, String base, String path) {
    static final Key<Review> KEY = Key.create("localreviews.Review");
}
