import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { diff, git, type Hunk } from './diff.ts';

/** A message without date is Pending; `review` is the Send that published one of mine. */
type Message = { author: 'me' | 'claude'; body: string; date: string | null; review?: number };
type Anchor = {
    path: string;
    side: 'old' | 'new';
    start: number;
    end: number;
    lines: string[];
    before: string[];
    after: string[];
    /** The diff hunk up to the end of the range, as GitHub's diff_hunk; null outside the diff. */
    hunk: Hunk | null;
};
type Thread = { id: number; anchor: Anchor; resolved: boolean; messages: Message[] };
export type Session = { id: string; worktree: string; createdAt: string; approvedAt: string | null; sends: number; threads: Thread[] };

export function httpError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

function dataDir(): string {
    return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'claude-reviews');
}

/** Replaces the file atomically: a reader, or a crash, never sees it half written. */
async function save(session: Session): Promise<void> {
    const dir = join(dataDir(), 'sessions');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${session.id}.json`);
    // ponytail: no fsync, so a power cut right after the rename may leave an empty file on some filesystems; fsync the temp file if it ever bites.
    await writeFile(`${file}.tmp`, JSON.stringify(session, null, 2));
    await rename(`${file}.tmp`, file);
}

/** The session as served: what is stored, plus whose turn it is in each thread. */
function view(session: Session) {
    return { ...session, threads: session.threads.map(thread => ({ ...thread, status: status(thread) })) };
}

function status(thread: Thread): 'resolved' | 'waiting-for-claude' | 'awaiting-you' | null {
    if (thread.resolved) return 'resolved';
    const last = thread.messages.findLast(message => message.date);
    return !last ? null : last.author === 'me' ? 'waiting-for-claude' : 'awaiting-you';
}

async function load(id: string): Promise<Session> {
    for (const dir of ['sessions', 'archive']) {
        const content = await readFile(join(dataDir(), dir, `${id}.json`), 'utf8')
            .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (content) return JSON.parse(content);
    }
    throw httpError(404, `No session ${id}`);
}

export async function getSession(id: string) {
    return view(await load(id));
}

/** The open session of the worktree, created on first call. */
export async function openSession(path: unknown) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw httpError(400, 'worktree must be an absolute path');
    const worktree = (await git(path, ['rev-parse', '--show-toplevel']).catch(() => {
        throw httpError(400, `No git worktree at ${path}`);
    })).trim();
    const dir = join(dataDir(), 'sessions');
    const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'));
    for (const name of names) {
        const session: Session = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if (session.worktree === worktree && !session.approvedAt) return view(session);
    }
    const session = { id: randomBytes(8).toString('hex'), worktree, createdAt: new Date().toISOString(), approvedAt: null, sends: 0, threads: [] };
    await save(session);
    return view(session);
}

function message(author: unknown, body: unknown): Message {
    if (author !== 'me' && author !== 'claude') throw httpError(400, 'author must be "me" or "claude"');
    if (typeof body !== 'string' || !body.trim()) throw httpError(400, 'body must be a non-empty string');
    // Claude's messages skip reviews: published as soon as written.
    return { author, body, date: author === 'claude' ? new Date().toISOString() : null };
}

/** The id, if it names an object of one of these types in the worktree's repository. */
async function checkObject(worktree: string, id: unknown, name: string, types: string[]): Promise<string> {
    if (typeof id !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw httpError(400, `${name} must be 40 or 64 hexadecimal characters`);
    const type = (await git(worktree, ['cat-file', '-t', id]).catch(() => 'missing')).trim();
    if (!types.includes(type)) throw httpError(400, `${name} ${id} is not a ${types.join(' or ')} of ${worktree}`);
    return id;
}

/** A session that still takes messages: an approved one refuses them all. */
async function writable(id: string): Promise<Session> {
    const session = await load(id);
    if (session.approvedAt) throw httpError(409, 'session approuvée');
    return session;
}

/**
 * Opens a thread, anchored on the code its author sees:
 * the displayed `base` and `tree` for me, HEAD and the working tree at the time of the call for Claude.
 */
export async function openThread(id: string, input: Record<string, unknown>) {
    const session = await writable(id);
    const first = message(input.author, input.body);
    const { path, side } = input;
    const [from, to] = [input.start, input.end];
    if (typeof path !== 'string' || (side !== 'old' && side !== 'new') || typeof from !== 'number' || typeof to !== 'number'
        || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        throw httpError(400, 'A thread needs a path, a side ("old" or "new") and a range of lines from start to end');
    }
    if (posix.normalize(path) !== path || path.startsWith('/') || path.startsWith('../')) {
        throw httpError(400, `${path} is not a canonical path from the top of the worktree`);
    }
    const shown = first.author === 'me' ? {
        base: await checkObject(session.worktree, input.base, 'base', ['commit', 'tree']),
        tree: await checkObject(session.worktree, input.tree, 'tree', ['tree']),
    } : undefined;
    const { base, tree, files } = await diff(session.worktree, shown);
    const content = await git(session.worktree, ['cat-file', 'blob', `${side === 'new' ? tree : base}:${path}`])
        .catch(() => { throw httpError(400, `No ${path} on the ${side} side`); });
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();
    if (to > lines.length) throw httpError(400, `${path} has ${lines.length} lines on the ${side} side`);
    let hunk: Hunk | null = null;
    for (const file of files.filter(file => file.path === path)) {
        for (const { header, lines } of file.hunks) {
            const last = lines.findIndex(line => (side === 'new' ? line.newNo : line.oldNo) === to);
            if (last !== -1) hunk = { header, lines: lines.slice(0, last + 1) };
        }
    }
    session.threads.push({
        id: session.threads.length + 1,
        anchor: {
            path, side, start: from, end: to,
            lines: lines.slice(from - 1, to), before: lines.slice(Math.max(0, from - 4), from - 1), after: lines.slice(to, to + 3), hunk,
        },
        resolved: false,
        messages: [first],
    });
    await save(session);
    return view(session);
}

function findThread(session: Session, threadId: number): Thread {
    const thread = session.threads.find(thread => thread.id === threadId);
    if (!thread) throw httpError(404, `No thread ${threadId} in session ${session.id}`);
    return thread;
}

export async function addMessage(id: string, threadId: number, input: Record<string, unknown>) {
    const session = await writable(id);
    const thread = findThread(session, threadId);
    thread.messages.push(message(input.author, input.body));
    await save(session);
    return view(session);
}

export async function resolve(id: string, threadId: number) {
    const session = await writable(id);
    findThread(session, threadId).resolved = true;
    await save(session);
    return view(session);
}

// The commit only carries the tree, so it must not depend on the user's identity.
const SNAPSHOT_AUTHOR = { GIT_AUTHOR_NAME: 'claude-reviews', GIT_AUTHOR_EMAIL: 'claude-reviews@localhost', GIT_COMMITTER_NAME: 'claude-reviews', GIT_COMMITTER_EMAIL: 'claude-reviews@localhost' };

/** Takes a Snapshot of the displayed `tree`, then publishes the Pending messages, dated now, after the messages already published. */
export async function send(id: string, tree: unknown) {
    const session = await writable(id);
    const shown = await checkObject(session.worktree, tree, 'tree', ['tree']);
    const commit = await git(session.worktree, ['commit-tree', '-m', `claude-reviews session ${id}`, shown], SNAPSHOT_AUTHOR);
    const review = session.sends + 1;
    await git(session.worktree, ['update-ref', `refs/claude-reviews/${id}/${review}`, commit.trim()]);
    const date = new Date().toISOString();
    for (const thread of session.threads) {
        const pending = thread.messages.filter(message => !message.date);
        // Only a message of mine reopens a Resolved thread, once Claude can read it.
        if (pending.length) thread.resolved = false;
        thread.messages = [...thread.messages.filter(message => message.date), ...pending.map(message => ({ ...message, date, review }))];
    }
    session.sends = review;
    await save(session);
    return view(session);
}

/** Closes the session: its file moves to archive/, where it stays readable, then its refs go. */
export async function approve(id: string) {
    const session = await writable(id);
    if (session.threads.some(thread => thread.messages.some(message => !message.date))) {
        throw httpError(409, 'Pending messages must be sent before an Approve');
    }
    // Each step leaves a closed session behind: an approved file is never reopened, wherever a crash leaves it.
    session.approvedAt = new Date().toISOString();
    await save(session);
    await mkdir(join(dataDir(), 'archive'), { recursive: true });
    await rename(join(dataDir(), 'sessions', `${id}.json`), join(dataDir(), 'archive', `${id}.json`));
    // ponytail: refs git cannot delete (worktree gone) stay behind, hidden; sweep refs of archived sessions if they pile up.
    await git(session.worktree, ['for-each-ref', '--format=delete %(refname)', `refs/claude-reviews/${id}/`])
        .then(refs => git(session.worktree, ['update-ref', '--stdin'], undefined, refs))
        .catch(() => {});
    return view(session);
}
