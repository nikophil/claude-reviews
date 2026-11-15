// @ts-check
'use strict';
const vscode = require('vscode');
const review = require('./review.js');

/** The text of a file at the base, read from the server: a client does not read git. */
const BASE = 'local-reviews-base';
/** The code an Outdated thread was opened on, which no code shows any more. */
const OUTDATED = 'local-reviews-outdated';

/** @type {any} */
let app;

/** `path` in the commit or tree `object` of the session's repository. */
function baseUri(/** @type {string} */ session, /** @type {string} */ object, /** @type {string} */ path) {
    return vscode.Uri.from({ scheme: BASE, path: `/${path}`, query: new URLSearchParams({ session, object }).toString() });
}

/** The missing side of an added or deleted file. */
function emptyUri(/** @type {string} */ path) {
    return vscode.Uri.from({ scheme: BASE, path: `/${path}`, query: 'empty' });
}

/** The excerpt of an Outdated thread, named after its file, `.diff` when it is a diff excerpt, for its colors. */
function outdatedUri(/** @type {string} */ session, /** @type {any} */ thread) {
    return vscode.Uri.from({
        scheme: OUTDATED,
        path: `/${thread.anchor.path}${thread.anchor.hunk ? '.diff' : ''}`,
        query: new URLSearchParams({ session, thread: String(thread.id) }).toString(),
    });
}

/** The side and the file of the session a document shows, with the base it was read at; undefined for any other document. */
function where(/** @type {vscode.Uri} */ uri, /** @type {any} */ state) {
    if (uri.scheme === 'file' && state.root && uri.fsPath.startsWith(`${state.root}/`)) {
        return { side: 'new', path: uri.fsPath.slice(state.root.length + 1), base: state.base };
    }
    const query = new URLSearchParams(uri.query);
    if (uri.scheme === BASE && query.has('object')) return { side: 'old', path: uri.path.slice(1), base: query.get('object') };
}

/**
 * Opens the diff of `path` against the base of the session, at line `line` of its side `side`, from 1.
 * @param {string} path
 * @param {number} [line]
 */
async function open(path, side = 'new', line) {
    const state = app.state();
    const file = state.files.find((/** @type {any} */ file) => file.path === path);
    const left = file?.status === 'added' ? emptyUri(path) : baseUri(state.session.id, state.base, path);
    const right = file?.status === 'deleted' ? emptyUri(path) : vscode.Uri.file(`${state.root}/${path}`);
    const title = `${path.slice(path.lastIndexOf('/') + 1)} (${state.base.slice(0, 7)} ↔ Working tree)`;
    const at = line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, selection: side === 'new' ? at : undefined });
    // The options select on the new side only.
    if (at && side === 'old') vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === left.toString())?.revealRange(at, vscode.TextEditorRevealType.InCenter);
}

/** An Outdated thread, under the last line of the code it was opened on. */
async function openOutdated(/** @type {any} */ thread) {
    const document = await vscode.workspace.openTextDocument(outdatedUri(app.state().session.id, thread));
    const last = new vscode.Range(document.lineCount - 1, 0, document.lineCount - 1, 0);
    await vscode.window.showTextDocument(document, { preview: true, selection: last });
}

/** The path of the file a diff shows from the URI of its new side, as the toolbar of the diff gives it. */
function pathOf(/** @type {vscode.Uri} */ uri) {
    return where(uri, app.state())?.path ?? uri.path.slice(1);
}

function register(/** @type {vscode.ExtensionContext} */ context, /** @type {any} */ shared) {
    app = shared;
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(BASE, {
            async provideTextDocumentContent(uri) {
                const query = new URLSearchParams(uri.query);
                if (!query.has('object')) return '';
                try {
                    return (await app.call(`/api/sessions/${query.get('session')}/file?object=${query.get('object')}&path=${encodeURIComponent(uri.path.slice(1))}`)).text;
                } catch (error) {
                    if (/** @type {any} */ (error).status === 404) return '';
                    throw error;
                }
            },
        }),
        vscode.workspace.registerTextDocumentContentProvider(OUTDATED, {
            provideTextDocumentContent(uri) {
                const id = Number(new URLSearchParams(uri.query).get('thread'));
                const thread = app.state().session?.threads.find((/** @type {any} */ thread) => thread.id === id);
                return thread ? review.outdatedText(thread.anchor) : '';
            },
        }),
        vscode.commands.registerCommand('localReviews.markViewed', app.guard(async (/** @type {vscode.Uri} */ uri) => app.markViewed(pathOf(uri), true))),
        vscode.commands.registerCommand('localReviews.unmarkViewed', app.guard(async (/** @type {vscode.Uri} */ uri) => app.markViewed(pathOf(uri), false))),
    );
}

module.exports = { register, open, openOutdated, baseUri, outdatedUri, where };
