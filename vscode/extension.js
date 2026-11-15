// @ts-check
'use strict';
const vscode = require('vscode');
const review = require('./review.js');
const diff = require('./diff.js');
const threads = require('./threads.js');

const URL = `http://127.0.0.1:${process.env.CLAUDE_REVIEWS_PORT || 7778}`;
const SILENT = `The claude-reviews server does not answer on ${URL}: start a Claude session with the local-reviews mod, or npm start.`;
/** The scheme of the files of the view: their own decorations, not those of git against HEAD. */
const FILE = 'local-reviews-file';

/** An answer other than 200, with the server's error message; status 0 when the server did not answer. */
const failure = (/** @type {number} */ status, /** @type {string} */ message) => Object.assign(new Error(message), { status });

/** The server, through its HTTP API only, as the mod calls it: no Origin, 2 s at most per read, 10 s per write, which may wait for the others. */
async function call(/** @type {string} */ path, /** @type {object=} */ body) {
    let res;
    try {
        res = await fetch(URL + path, body === undefined ? { signal: AbortSignal.timeout(2000) }
            : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    } catch {
        throw failure(0, SILENT);
    }
    const json = await res.json().catch(() => ({}));
    if (res.status !== 200) throw failure(res.status, json.error ?? `HTTP ${res.status}`);
    return json;
}

/**
 * @typedef {{ error?: string, root?: string, ref?: string, base?: string, tree?: string, files: any[], session: any }} State
 * What a poll read: no session yet (`session` null), or the session placed on the code its diff shows; `error` when the server failed.
 */

/** @type {State} */
// Undefined until the first poll, which tells the view what it shows even when there is no session.
let state = { files: [], session: undefined };
/** @type {{ login: string | null, name: string | null }} */
let me = { login: null, name: null };
const changed = new vscode.EventEmitter();

/** @type {Promise<void> | undefined} */
let running;
let again = false;

/** Polls now, and once more after a poll in flight, which may have read the session before a write. */
function refresh() {
    if (running) {
        again = true;
        return running;
    }
    running = (async () => {
        do {
            again = false;
            await poll();
        } while (again);
    })().finally(() => (running = undefined));
    return running;
}

function worktree() {
    // ponytail: the first folder of the workspace only; a multi-root workspace reviews its first worktree.
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

async function poll() {
    const root = worktree();
    if (!root) return;
    /** @type {State} */
    let read;
    try {
        read = await readState(root);
        if (!me.login) me = await call('/api/me').catch(() => me);
    } catch (error) {
        // The threads stay as they are, the view says why.
        read = { ...state, error: /** @type {Error} */ (error).message };
    }
    if (JSON.stringify(read) === JSON.stringify(state)) return;
    const before = state.session;
    state = read;
    // Once, however many threads Claude answered: the end of a turn that leaves threads waiting is told by the desktop notification of the mod.
    if (read.session && review.replied(before, read.session)) vscode.window.showInformationMessage('Claude replied in every thread');
    changed.fire(state);
}

/** @returns {Promise<State>} */
async function readState(/** @type {string} */ root) {
    let found;
    try {
        found = await call(`/api/sessions?worktree=${encodeURIComponent(root)}`);
    } catch (error) {
        if (/** @type {any} */ (error).status === 404) return { files: [], session: null };
        throw error;
    }
    const route = `/api/sessions/${found.id}`;
    const { ref, base, tree } = await call(`${route}/tree`);
    // The server keeps the diff of a base and a tree: ask again only when they changed.
    const same = state.session?.id === found.id && base === state.base && tree === state.tree;
    const files = same ? state.files : (await call(`${route}/diff?base=${base}&tree=${tree}`)).files;
    const session = await call(`${route}?base=${base}&tree=${tree}`);
    return { root: session.worktree, ref, base, tree, files, session };
}

/** Runs a command, its failure in an error message: a 409 says why the server refused. */
function guard(/** @type {(...args: any[]) => Promise<unknown>} */ run) {
    return async (/** @type {any[]} */ ...args) => {
        try {
            await run(...args);
        } catch (error) {
            vscode.window.showErrorMessage(/** @type {Error} */ (error).message);
        }
    };
}

/** The tree of the working tree, once the documents are saved: what I see is the code of the files as they are now. */
async function shownTree() {
    await vscode.workspace.saveAll(false);
    return (await call(`/api/sessions/${state.session.id}/tree`)).tree;
}

/**
 * Send of the whole session, or of the thread `thread` only; without a Claude session, how to start one instead.
 * @param {number} [thread]
 */
async function send(thread) {
    const session = state.session;
    if (!session) return;
    if (!review.claude(session)) {
        const copy = await vscode.window.showWarningMessage(`Start a Claude session in this worktree to send to Claude: ${review.startClaude(session)}`, 'Copy Command');
        if (copy) await vscode.env.clipboard.writeText(review.startClaude(session));
        return;
    }
    const tree = await shownTree();
    const sent = await call(`/api/sessions/${session.id}/send`, thread === undefined ? { tree } : { tree, threads: [thread] });
    const count = review.sent(sent);
    vscode.window.showInformationMessage(`${count} ${count === 1 ? 'message' : 'messages'} sent to Claude`);
    await refresh();
}

async function approve() {
    const session = state.session;
    if (!session) return;
    const open = session.threads.filter((/** @type {any} */ thread) => !thread.resolved).length;
    const question = open === 0 ? 'Approve this session?' : `Approve this session with ${open} open threads?`;
    if (await vscode.window.showWarningMessage(question, { modal: true }, 'Approve') !== 'Approve') return;
    await call(`/api/sessions/${session.id}/approve`, {});
    vscode.window.showInformationMessage('Session approved');
    await refresh();
}

async function chooseBase() {
    const session = state.session;
    if (!session) return;
    const items = review.baseItems(await call(`/api/sessions/${session.id}/bases`), state.ref)
        .map(item => item.separator ? { label: item.separator, kind: vscode.QuickPickItemKind.Separator } : item);
    const chosen = /** @type {any} */ (await vscode.window.showQuickPick(items, { title: 'Base', placeHolder: 'Compare the working tree with' }));
    if (!chosen || chosen.ref === state.ref) return;
    if (chosen.disabled) {
        vscode.window.showInformationMessage(`${chosen.label} is there after a Send`);
        return;
    }
    await call(`/api/sessions/${session.id}/base`, { base: chosen.ref });
    await refresh();
}

/** Marks `path` Viewed, or no longer, on the tree of the working tree. */
async function markViewed(/** @type {string} */ path, /** @type {boolean} */ viewed) {
    const tree = await shownTree();
    await call(`/api/sessions/${state.session.id}/viewed`, { path, tree, viewed });
    await refresh();
}

/**
 * Opens `path` in the editor, at line `line` from 1, else at its first thread or added line.
 * @param {string} path
 * @param {number} [line]
 */
async function openFile(path, line) {
    const file = state.files.find(file => file.path === path) ?? { path };
    const at = (line ?? review.firstLine(file, review.threadsOf(state.session.threads, path))) - 1;
    await vscode.window.showTextDocument(vscode.Uri.file(`${state.root}/${path}`), { preview: true, selection: new vscode.Range(at, 0, at, 0) });
}

/** A thread opens where its code is: the editor for the new code, the diff for the old one, its excerpt when Outdated. */
async function openThread(/** @type {number} */ id) {
    const thread = state.session?.threads.find((/** @type {any} */ thread) => thread.id === id);
    if (!thread) return;
    if (!thread.at) return diff.openOutdated(thread);
    if (thread.anchor.side === 'old') return diff.open(thread.anchor.path, 'old', thread.at.start);
    return openFile(thread.anchor.path, thread.at.start || 1);
}

/** The files of the diff, then those only threads name, each with its unresolved threads. */
class Files {
    constructor() {
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
    }

    getChildren(/** @type {any} */ node) {
        const session = state.session;
        if (!session) return [];
        if (!node) return review.tree(state.files, session.threads);
        if (node.dir) return node.files.map((/** @type {any} */ file) => ({ file }));
        if (node.file) return review.threadsOf(session.threads, node.file.path).map(thread => ({ thread }));
        return [];
    }

    getTreeItem(/** @type {any} */ node) {
        const session = state.session;
        if (node.dir) {
            const item = new vscode.TreeItem(node.dir, vscode.TreeItemCollapsibleState.Expanded);
            item.id = `dir:${node.dir}`;
            item.iconPath = vscode.ThemeIcon.Folder;
            return item;
        }
        if (node.thread) {
            const item = new vscode.TreeItem(review.label(node.thread, session));
            item.id = `thread:${node.thread.id}`;
            item.iconPath = new vscode.ThemeIcon(node.thread.at ? 'comment-discussion' : 'warning');
            item.tooltip = node.thread.messages[0]?.body;
            item.accessibilityInformation = { label: review.label(node.thread, session) };
            item.command = { command: 'localReviews.openThread', title: 'Open Thread', arguments: [node.thread.id] };
            return item;
        }
        const { path, status } = node.file;
        const threads = review.threadsOf(session.threads, path);
        const item = new vscode.TreeItem(path.slice(path.lastIndexOf('/') + 1), threads.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.id = `file:${path}`;
        item.resourceUri = vscode.Uri.from({ scheme: FILE, path: `/${path}` });
        item.iconPath = vscode.ThemeIcon.File;
        item.tooltip = path;
        const counts = review.counts(session, path);
        item.description = [counts.waiting && `${counts.waiting} waiting for Claude`, counts.pending && `${counts.pending} pending`].filter(Boolean).join(' · ');
        item.accessibilityInformation = { label: [path, item.description].filter(Boolean).join(', ') };
        // As in a pull request: a Viewed checkbox before each file of the diff; a file that only threads name has nothing to view.
        if (status !== 'unchanged') {
            const viewed = review.viewed(session, path);
            item.checkboxState = { state: viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked, tooltip: 'Viewed' };
        }
        item.contextValue = status === 'deleted' ? 'file-deleted' : status === 'unchanged' ? 'unchanged' : 'file';
        item.command = status === 'unchanged'
            ? { command: 'localReviews.openFile', title: 'Open File', arguments: [path] }
            : { command: 'localReviews.openDiff', title: 'Open Changes', arguments: [path] };
        return item;
    }
}

function activate(/** @type {vscode.ExtensionContext} */ context) {
    const files = new Files();
    const view = vscode.window.createTreeView('localReviews.files', { treeDataProvider: files, showCollapseAll: true, manageCheckboxStateManually: true });
    const decorations = new vscode.EventEmitter();
    const app = { state: () => state, me: () => me, onChange: changed.event, call, refresh, guard, send, shownTree, markViewed };
    /** @type {any[]} */
    let bases = [];
    let basesOf = '';
    let shown = '';

    context.subscriptions.push(view, changed, decorations,
        vscode.window.registerFileDecorationProvider({
            onDidChangeFileDecorations: decorations.event,
            provideFileDecoration(uri) {
                if (uri.scheme !== FILE || !state.session) return;
                const path = uri.path.slice(1);
                const file = state.files.find(file => file.path === path);
                if (!file) return;
                const badge = { added: 'A', deleted: 'D', modified: 'M' }[/** @type {string} */ (file.status)];
                // A viewed file in grey, as in a pull request.
                const color = review.viewed(state.session, path) ? 'disabledForeground' : `gitDecoration.${file.status}ResourceForeground`;
                return { badge, color: new vscode.ThemeColor(color), tooltip: file.status };
            },
        }),
        view.onDidChangeCheckboxState(guard(async event => {
            for (const [node, checked] of event.items) await markViewed(node.file.path, checked === vscode.TreeItemCheckboxState.Checked);
        })),
        vscode.commands.registerCommand('localReviews.start', guard(async () => {
            await call('/api/sessions', { worktree: worktree() });
            await refresh();
        })),
        vscode.commands.registerCommand('localReviews.refresh', refresh),
        vscode.commands.registerCommand('localReviews.send', guard(() => send())),
        vscode.commands.registerCommand('localReviews.approve', guard(approve)),
        vscode.commands.registerCommand('localReviews.chooseBase', guard(chooseBase)),
        vscode.commands.registerCommand('localReviews.openFile', guard(async node => openFile(typeof node === 'string' ? node : node.file.path))),
        vscode.commands.registerCommand('localReviews.openDiff', guard(async node => diff.open(typeof node === 'string' ? node : node.file.path))),
        vscode.commands.registerCommand('localReviews.openThread', guard(openThread)),
        vscode.commands.registerCommand('localReviews.copyStartClaude', guard(async () => {
            if (state.session) await vscode.env.clipboard.writeText(review.startClaude(state.session));
        })),
    );
    diff.register(context, app);
    threads.register(context, app);

    changed.event(async () => {
        const session = state.session;
        const counts = session ? review.counts(session) : { waiting: 0, pending: 0, resolved: 0 };
        const changedFiles = state.files.filter(file => file.status !== 'deleted').map(file => `${state.root}/${file.path}`);
        const viewed = session ? state.files.filter(file => review.viewed(session, file.path)).map(file => `${state.root}/${file.path}`) : [];
        await vscode.commands.executeCommand('setContext', 'localReviews.state', session ? 'session' : state.error ? 'error' : 'none');
        await vscode.commands.executeCommand('setContext', 'localReviews.pending', counts.pending > 0);
        await vscode.commands.executeCommand('setContext', 'localReviews.changed', changedFiles);
        await vscode.commands.executeCommand('setContext', 'localReviews.viewed', viewed);
        await vscode.commands.executeCommand('setContext', 'localReviews.unviewed', changedFiles.filter(path => !viewed.includes(path)));
        view.badge = counts.pending ? { value: counts.pending, tooltip: `${counts.pending} pending` } : undefined;
        view.message = state.error ?? (!session ? undefined : !review.claude(session)
            ? `Start a Claude session in this worktree to send to Claude: ${review.startClaude(session)}`
            : `${state.files.length} files · ${viewed.length} viewed · ${counts.waiting} waiting for Claude`);
        files.emitter.fire(undefined);
        decorations.fire(undefined);
        if (!session) return;
        // /review-local asked to show the review: once per request, and only a recent one, which a window the launcher opens still finds.
        if (session.showRequestedAt && session.showRequestedAt !== shown) {
            shown = session.showRequestedAt;
            if (Date.now() - Date.parse(shown) < 30_000) {
                await vscode.commands.executeCommand('workbench.view.extension.localReviews');
                vscode.window.showInformationMessage(`The review of ${state.root} is open in VS Code`);
            }
        }
        // The bases change with a Send, which gives Since my last review.
        if (basesOf !== `${session.id}#${session.sends}`) {
            basesOf = `${session.id}#${session.sends}`;
            bases = await call(`/api/sessions/${session.id}/bases`).catch(() => []);
        }
        view.description = bases.find(base => base.ref === state.ref)?.name;
    });

    refresh();
    const timer = setInterval(refresh, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

module.exports = { activate };
