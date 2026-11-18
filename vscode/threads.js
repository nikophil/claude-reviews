// @ts-check
'use strict';
const vscode = require('vscode');
const review = require('./review.js');
const diff = require('./diff.js');

/** @type {any} */
let app;
/** @type {vscode.Uri} */
let claudeIcon;

/** A message as a comment: Pending until a Send, markdown without images, the avatar of its author. */
function comment(/** @type {any} */ message) {
    const me = app.me();
    const mine = message.author === 'me';
    return {
        body: new vscode.MarkdownString(review.noImages(message.body)),
        mode: vscode.CommentMode.Preview,
        author: mine
            ? { name: me.name ?? me.login ?? 'Me', iconPath: me.login ? vscode.Uri.parse(`https://github.com/${encodeURIComponent(me.login)}.png?size=48`) : undefined }
            : { name: 'Claude', iconPath: claudeIcon },
        label: !message.date ? 'Pending' : mine ? `Send #${message.review}` : undefined,
        timestamp: message.date ? new Date(message.date) : undefined,
    };
}

/** Fills a comment thread with a thread of the session, folded when it shows first or got resolved or reopened. */
function fill(/** @type {vscode.CommentThread} */ shown, /** @type {any} */ thread, /** @type {any} */ session, /** @type {vscode.Range} */ range, /** @type {boolean} */ fold) {
    shown.range = range;
    shown.label = review.label(thread, session);
    shown.comments = thread.messages.map(comment);
    // A Resolved thread takes no message until its Unresolve.
    shown.canReply = !thread.resolved;
    shown.state = thread.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    shown.contextValue = `${thread.resolved ? 'resolved' : 'unresolved'} ${thread.readonly ? 'readonly' : 'writable'}`;
    if (fold) shown.collapsibleState = thread.resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
}

function register(/** @type {vscode.ExtensionContext} */ context, /** @type {any} */ shared) {
    app = shared;
    claudeIcon = vscode.Uri.joinPath(context.extensionUri, 'media', 'claude.svg');
    const controller = vscode.comments.createCommentController('local-reviews', 'Claude Reviews');
    controller.options = { prompt: 'Reply', placeHolder: 'Pending until Send' };
    // Any line of a file of the worktree, or of the base in a diff, takes a thread while a session is open.
    const ranges = {
        provideCommentingRanges(/** @type {vscode.TextDocument} */ document) {
            const state = app.state();
            if (!state.session || !diff.where(document.uri, state)) return [];
            return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
        },
    };
    let open = '';

    /** @type {Map<number, { shown: vscode.CommentThread, uri: string, json: string, resolved: boolean }>} */
    const threads = new Map();
    /** @type {Map<vscode.CommentThread, number>} */
    const ids = new Map();

    /** Places the threads of the session: only a thread whose JSON changed is filled again; one whose document changed is made again. */
    function show(/** @type {any} */ state) {
        const session = state.session;
        // Setting the provider again makes the editors open before a session ask for their ranges again.
        if (open !== `${session?.id}${state.root}${state.base}`) {
            open = `${session?.id}${state.root}${state.base}`;
            controller.commentingRangeProvider = ranges;
        }
        /** @type {Map<number, any>} */
        const placed = new Map((session?.threads ?? []).map((/** @type {any} */ thread) => [thread.id, thread]));
        for (const [id, old] of threads) {
            if (placed.has(id)) continue;
            ids.delete(old.shown);
            old.shown.dispose();
            threads.delete(id);
        }
        for (const thread of placed.values()) {
            const { path, side } = thread.anchor;
            const uri = !thread.at ? diff.outdatedUri(session.id, thread)
                : side === 'old' ? diff.baseUri(session.id, state.base, path) : vscode.Uri.file(`${state.root}/${path}`);
            // An Outdated thread goes under the last line of its excerpt, a thread on the whole file on its first line.
            const last = review.outdatedText(thread.anchor).split('\n').length;
            const range = thread.at ? new vscode.Range(Math.max(thread.at.start - 1, 0), 0, Math.max(thread.at.end - 1, 0), 0) : new vscode.Range(last - 1, 0, last - 1, 0);
            const json = JSON.stringify([thread, review.claude(session), app.me()]);
            const old = threads.get(thread.id);
            if (old?.uri === uri.toString()) {
                if (old.json !== json) fill(old.shown, thread, session, range, old.resolved !== thread.resolved);
                threads.set(thread.id, { ...old, json, resolved: thread.resolved });
                continue;
            }
            if (old) {
                ids.delete(old.shown);
                old.shown.dispose();
            }
            const shown = controller.createCommentThread(uri, range, []);
            fill(shown, thread, session, range, true);
            ids.set(shown, thread.id);
            threads.set(thread.id, { shown, uri: uri.toString(), json, resolved: thread.resolved });
        }
    }

    const route = (/** @type {vscode.CommentThread} */ shown) => `/api/sessions/${app.state().session.id}/threads/${ids.get(shown)}`;

    /** A new thread on the lines of the draft, with its first message, Pending until a Send: its id, which the thread just opened has as the largest of the session. */
    async function create(/** @type {vscode.CommentReply} */ reply) {
        const draft = reply.thread;
        const state = app.state();
        const place = diff.where(draft.uri, state);
        if (!reply.text.trim() || !place || !draft.range || !state.session) return undefined;
        const tree = await app.shownTree();
        const session = await app.call(`/api/sessions/${state.session.id}/threads`, {
            author: 'me', path: place.path, side: place.side, start: draft.range.start.line + 1, end: draft.range.end.line + 1,
            body: reply.text, base: place.base, tree,
        });
        draft.dispose();
        await app.refresh();
        return Math.max(...session.threads.map((/** @type {any} */ thread) => thread.id));
    }

    /** Adds my message to the thread: its id; with nothing typed, its id only while it has Pending messages, for a Send of them. */
    async function answer(/** @type {vscode.CommentReply} */ reply) {
        const id = ids.get(reply.thread);
        if (id === undefined) return undefined;
        if (!reply.text.trim()) return review.pending(app.state().session.threads.find((/** @type {any} */ thread) => thread.id === id)) ? id : undefined;
        await app.call(`${route(reply.thread)}/messages`, { author: 'me', body: reply.text });
        await app.refresh();
        return id;
    }

    context.subscriptions.push(controller,
        app.onChange(show),
        vscode.commands.registerCommand('localReviews.createThread', app.guard(async (/** @type {vscode.CommentReply} */ reply) => { await create(reply); })),
        vscode.commands.registerCommand('localReviews.createThreadAndSend', app.guard(async (/** @type {vscode.CommentReply} */ reply) => app.send(() => create(reply)))),
        vscode.commands.registerCommand('localReviews.cancelThread', (/** @type {vscode.CommentThread} */ draft) => draft.dispose()),
        vscode.commands.registerCommand('localReviews.reply', app.guard(async (/** @type {vscode.CommentReply} */ reply) => { await answer(reply); })),
        vscode.commands.registerCommand('localReviews.replyAndSend', app.guard(async (/** @type {vscode.CommentReply} */ reply) => app.send(() => answer(reply)))),
        vscode.commands.registerCommand('localReviews.resolve', app.guard(async (/** @type {vscode.CommentThread} */ shown) => {
            await app.call(`${route(shown)}/resolve`, {});
            await app.refresh();
        })),
        vscode.commands.registerCommand('localReviews.unresolve', app.guard(async (/** @type {vscode.CommentThread} */ shown) => {
            await app.call(`${route(shown)}/unresolve`, {});
            await app.refresh();
        })),
        ...[['localReviews.readonly', true], ['localReviews.allowChanges', false]].map(([command, readonly]) =>
            vscode.commands.registerCommand(String(command), app.guard(async (/** @type {vscode.CommentThread} */ shown) => {
                await app.call(`${route(shown)}/readonly`, { readonly });
                await app.refresh();
            }))),
    );
}

module.exports = { register };
