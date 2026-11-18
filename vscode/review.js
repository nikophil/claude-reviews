// @ts-check
'use strict';

// What the client shows of a session, from its JSON alone: no vscode here, so node --test runs it.

/** @typedef {{ author: 'me' | 'claude', body: string, date: string | null, review?: number }} Message */
/** @typedef {{ path: string, side: 'old' | 'new', start: number, end: number, lines: string[], hunk: { header: string, lines: { type: string, text: string }[] } | null }} Anchor */
/** @typedef {{ id: number, anchor: Anchor, resolved: boolean, readonly?: boolean, status: string | null, at?: { start: number, end: number } | null, messages: Message[] }} Thread */
/** @typedef {{ path: string, status: string, hunks?: { lines: { type: string, newNo: number | null }[] }[] }} File */

/** « Pending » before any Send, « Waiting for Claude », « Resolved », or '' when Claude spoke last. */
function status(/** @type {Thread} */ thread) {
    if (thread.status === null) return 'Pending';
    return { open: '', resolved: 'Resolved' }[thread.status] ?? 'Waiting for Claude';
}

/** The thread's place, else, Outdated, the lines of its Anchor; « File » for a thread on the whole file. */
function lines(/** @type {Thread} */ thread) {
    const at = thread.at ?? thread.anchor;
    const sign = thread.anchor.side === 'old' ? '-' : '+';
    return at.start === 0 ? 'File' : at.start === at.end ? `Line ${sign}${at.start}` : `Lines ${sign}${at.start} to ${sign}${at.end}`;
}

/** « #12 · Line +5 · Waiting for Claude · old code · Outdated »; without a Claude session, nobody answers. */
function label(/** @type {Thread} */ thread, /** @type {any} */ session) {
    const shown = status(thread) === 'Waiting for Claude' && !claude(session) ? 'No Claude session' : status(thread);
    return [`#${thread.id}`, lines(thread), shown, thread.anchor.side === 'old' && 'old code', !thread.at && 'Outdated', thread.readonly && 'Answer without changing code'].filter(Boolean).join(' · ');
}

function pending(/** @type {Thread} */ thread) {
    return thread.messages.some(message => !message.date);
}

/**
 * The threads of `path`, of the whole session without it: waiting for Claude, the Pending messages a Send publishes (none of a Resolved thread), Resolved.
 * @param {{ threads: Thread[] }} session
 * @param {string} [path]
 */
function counts(session, path) {
    const counts = { waiting: 0, pending: 0, resolved: 0 };
    for (const thread of session.threads) {
        if (path !== undefined && thread.anchor.path !== path) continue;
        if (thread.status === 'waiting-for-claude') counts.waiting++;
        if (thread.resolved) counts.resolved++;
        else counts.pending += thread.messages.filter(message => !message.date).length;
    }
    return counts;
}

function waiting(/** @type {{ threads: Thread[] }} */ session) {
    return counts(session).waiting;
}

/** Whether Claude replied in every thread of the session that waited: a Resolve that empties the waiting threads is not a reply. */
function replied(/** @type {any} */ before, /** @type {any} */ after) {
    const claudes = (/** @type {{ threads: Thread[] }} */ session) => session.threads.flatMap(thread => thread.messages).filter(message => message.author === 'claude').length;
    return !!before && before.id === after.id && waiting(before) > 0 && waiting(after) === 0 && claudes(after) > claudes(before);
}

/** Whether a Claude session reads the session, so that a Send reaches Claude; true from a server without the field. */
function claude(/** @type {any} */ session) {
    return session.claudeSession !== false;
}

/** The shell command that starts a Claude session in the worktree of the session. */
function startClaude(/** @type {{ worktree: string }} */ session) {
    const { worktree } = session;
    return `cd ${/^[\w./-]+$/.test(worktree) ? worktree : `'${worktree.replaceAll("'", "'\\''")}'`} && claude`;
}

/** The unresolved threads of `path`, as the tree shows them. */
function threadsOf(/** @type {Thread[]} */ threads, /** @type {string} */ path) {
    return threads.filter(thread => thread.anchor.path === path && !thread.resolved);
}

/**
 * The files of the diff, then those only unresolved threads name, out of the diff (`unchanged`):
 * a file at the root as `{ file }`, the others under `{ dir, files }`, each directory at its first file.
 * @returns {({ file: File } | { dir: string, files: File[] })[]}
 */
function tree(/** @type {File[]} */ files, /** @type {Thread[]} */ threads) {
    const all = [...files];
    for (const thread of threads) {
        if (!thread.resolved && !all.some(file => file.path === thread.anchor.path)) all.push({ path: thread.anchor.path, status: 'unchanged' });
    }
    /** @type {({ file: File } | { dir: string, files: File[] })[]} */
    const nodes = [];
    /** @type {Map<string, File[]>} */
    const dirs = new Map();
    for (const file of all) {
        const cut = file.path.lastIndexOf('/');
        if (cut < 0) {
            nodes.push({ file });
            continue;
        }
        const dir = file.path.slice(0, cut);
        if (!dirs.has(dir)) {
            dirs.set(dir, []);
            nodes.push({ dir, files: /** @type {File[]} */ (dirs.get(dir)) });
        }
        dirs.get(dir)?.push(file);
    }
    return nodes;
}

/**
 * The id of the unresolved thread after `current` in the order of the view, or before it backward, around at the ends,
 * `current` placed among all the threads, so that a thread just Resolved keeps its place; the first, or the last, without `current`; undefined without any.
 */
function step(/** @type {File[]} */ files, /** @type {Thread[]} */ threads, /** @type {number | undefined} */ current, /** @type {boolean} */ forward) {
    const paths = tree(files, threads).flatMap(node => 'dir' in node ? node.files : [node.file]).map(file => file.path);
    for (const thread of threads) if (!paths.includes(thread.anchor.path)) paths.push(thread.anchor.path);
    const all = paths.flatMap(path => threads.filter(thread => thread.anchor.path === path));
    const at = all.findIndex(thread => thread.id === current);
    const from = at >= 0 ? at : forward ? -1 : all.length;
    for (let i = 1; i <= all.length; i++) {
        const thread = all[(((from + (forward ? i : -i)) % all.length) + all.length) % all.length];
        if (!thread.resolved) return thread.id;
    }
    return undefined;
}

/** The line, from 1, a file opens at: its first thread on the new side, else its first added line, else its top. */
function firstLine(/** @type {File} */ file, /** @type {Thread[]} */ threads) {
    const placed = threads.find(thread => thread.anchor.side === 'new' && thread.at?.start);
    if (placed?.at) return placed.at.start;
    for (const hunk of file.hunks ?? []) {
        const added = hunk.lines.find(line => line.type === 'add');
        if (added?.newNo) return added.newNo;
    }
    return 1;
}

/** The messages the last Send published: the ones it numbered. */
function sent(/** @type {{ sends: number, threads: { messages: Message[] }[] }} */ session) {
    return session.threads.flatMap(thread => thread.messages).filter(message => message.review === session.sends).length;
}

/** Whether `path` is Viewed in the session placed on the code shown: a file whose content changed since is not. */
function viewed(/** @type {any} */ session, /** @type {string} */ path) {
    return Object.hasOwn(session.viewed ?? {}, path);
}

/** The file of the diff after `path` in the order of the tree that is not Viewed; undefined after the last one, without going around. */
function nextNotViewed(/** @type {File[]} */ files, /** @type {any} */ session, /** @type {string} */ path) {
    const order = tree(files, []).flatMap(node => 'dir' in node ? node.files : [node.file]);
    return order.slice(order.findIndex(file => file.path === path) + 1).find(file => !viewed(session, file.path))?.path;
}

/**
 * The items of the base picker: a separator before each group, the base greyed until a Send told so, the chosen one marked.
 * @param {{ ref: string, name: string, disabled?: boolean, group?: string }[]} bases
 * @param {string | undefined} chosen
 */
function baseItems(bases, chosen) {
    /** @type {any[]} */
    const items = [];
    let group;
    for (const base of bases) {
        if (base.group && base.group !== group) items.push({ separator: base.group });
        group = base.group;
        const description = base.disabled ? 'after a Send' : base.ref === chosen ? 'current' : undefined;
        items.push({ label: base.name, ...(description && { description }), ref: base.ref, disabled: !!base.disabled, picked: base.ref === chosen });
    }
    return items;
}

/** The code an Outdated thread was opened on: its diff excerpt as unified diff, else the lines of its Anchor out of the diff. */
function outdatedText(/** @type {Pick<Anchor, 'hunk' | 'lines'>} */ anchor) {
    if (!anchor.hunk) return anchor.lines.join('\n');
    const sign = /** @type {Record<string, string>} */ ({ add: '+', del: '-', note: '\\ ' });
    return [anchor.hunk.header, ...anchor.hunk.lines.map(line => (sign[line.type] ?? ' ') + line.text)].join('\n');
}

/** The markdown of a message, its images replaced by their text: a message loads nothing from the network. */
function noImages(/** @type {string} */ markdown) {
    return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** The uids of the sockets listening on `port`, from the text of /proc/net/tcp and /proc/net/tcp6. */
function listeners(/** @type {string} */ text, /** @type {number} */ port) {
    const local = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    // Each line: sl, local address:port, remote address:port, state (0A when listening), queues, timer, retransmits, uid…
    return text.split('\n').map(line => line.trim().split(/\s+/))
        .filter(fields => fields[1]?.endsWith(local) && fields[3] === '0A')
        .map(fields => Number(fields[7]));
}

module.exports = { status, lines, label, pending, counts, waiting, replied, claude, startClaude, threadsOf, tree, step, firstLine, sent, viewed, nextNotViewed, baseItems, outdatedText, noImages, listeners };
