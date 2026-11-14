import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { diff, git, head, writeTree, type Hunk, type Line } from './diff.ts';
import { reanchor } from './reanchor.ts';

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
/** `base` is the last base chosen: HEAD, last-review, origin/HEAD or refs/heads/<branch>. */
export type Session = { id: string; worktree: string; createdAt: string; approvedAt: string | null; base: string; sends: number; threads: Thread[] };

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

/** The top of the worktree at `path`, and its open session if it has one. */
async function lookup(path: unknown): Promise<{ worktree: string; session?: Session }> {
    if (typeof path !== 'string' || !isAbsolute(path)) throw httpError(400, 'worktree must be an absolute path');
    const worktree = (await git(path, ['rev-parse', '--show-toplevel']).catch(() => {
        throw httpError(400, `No git worktree at ${path}`);
    })).trim();
    const dir = join(dataDir(), 'sessions');
    const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'));
    for (const name of names) {
        // An Approve may move a file away between the listing and its reading.
        const content = await readFile(join(dir, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        const session: Session | null = content && JSON.parse(content);
        if (session?.worktree === worktree && !session.approvedAt) return { worktree, session };
    }
    return { worktree };
}

/** The open session of the worktree, never created: the mod looks for it without filling Reviews with empty sessions. */
export async function findSession(path: unknown) {
    const { worktree, session } = await lookup(path);
    if (!session) throw httpError(404, `No open session for ${worktree}`);
    return view(session);
}

/** The open session of the worktree, created on first call. */
export async function openSession(path: unknown) {
    const { worktree, session: open } = await lookup(path);
    if (open) return view(open);
    const session = { id: randomBytes(8).toString('hex'), worktree, createdAt: new Date().toISOString(), approvedAt: null, base: 'HEAD', sends: 0, threads: [] };
    await save(session);
    return view(session);
}

/** The bases of the selector, in its order. */
export async function bases(session: Session): Promise<{ ref: string; name: string; disabled?: boolean }[]> {
    const list = [{ ref: 'HEAD', name: 'Uncommitted changes' }, { ref: 'last-review', name: 'Since my last review', disabled: session.sends === 0 }];
    if (await git(session.worktree, ['rev-parse', '--verify', '-q', 'origin/HEAD']).then(() => true, () => false)) list.push({ ref: 'origin/HEAD', name: 'origin/HEAD' });
    // Each line: "*" on the checked-out branch, the ref, then its commits not in HEAD and HEAD's commits not in it, past their merge-base.
    const lines = await git(session.worktree, ['for-each-ref', '--format=%(HEAD) %(refname) %(ahead-behind:HEAD)', 'refs/heads/']).catch(() => '');
    const branches = lines.split('\n').filter(line => line.startsWith('  ')).map(line => line.slice(2).split(' '))
        .map(([ref, ahead, behind]) => ({ ref, ahead: Number(ahead), behind: Number(behind) }));
    // The nearest merge-base is the one fewest commits of HEAD lie after: the parent of a stacked branch comes first.
    branches.sort((a, b) => a.behind - b.behind || a.ahead - b.ahead);
    return [...list, ...branches.map(({ ref }) => ({ ref, name: ref.slice('refs/heads/'.length) }))];
}

export async function chooseBase(id: string, base: unknown) {
    const session = await writable(id);
    if (!(await bases(session)).some(choice => choice.ref === base && !choice.disabled)) throw httpError(400, `${base} is not a base of session ${id}`);
    session.base = base as string;
    await save(session);
    return view(session);
}

/**
 * The ids the UI would display now: the commit the session's base names, and a tree of the working tree.
 * A branch or origin/HEAD names its merge-base with HEAD; a base that names nothing anymore (no Snapshot, branch gone) falls back to HEAD.
 */
async function current(session: Session): Promise<{ ref: string; base: string; tree: string }> {
    const ref = session.base ?? 'HEAD';
    // ponytail: the 2 s poll writes no object when nothing changed (0 new loose objects over 10 polls), but rehashes every
    // modified and untracked file (7 ms on this repository); skip writeTree while no file stat moved if big untracked files slow it.
    const tree = await writeTree(session.worktree);
    const base = ref === 'HEAD' ? '' : (await git(session.worktree, ref === 'last-review'
        ? ['rev-parse', '--verify', '-q', `refs/claude-reviews/${session.id}/${session.sends}^{commit}`]
        : ['merge-base', 'HEAD', ref]).catch(() => '')).trim();
    return base ? { ref, base, tree } : { ref: 'HEAD', base: await head(session.worktree), tree };
}

/** What the poll compares with the displayed diff, without computing a diff. */
export async function currentTree(id: string) {
    return current(await load(id));
}

export async function sessionDiff(id: string) {
    const session = await load(id);
    const shown = await current(session);
    return { ...shown, ...await diff(session.worktree, shown) };
}

function message(author: unknown, body: unknown): Message {
    if (author !== 'me' && author !== 'claude') throw httpError(400, 'author must be "me" or "claude"');
    if (typeof body !== 'string' || !body.trim()) throw httpError(400, 'body must be a non-empty string');
    // Claude's messages skip reviews: published as soon as written.
    return { author, body, date: author === 'claude' ? new Date().toISOString() : null };
}

function checkId(id: unknown, name: string): asserts id is string {
    if (typeof id !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw httpError(400, `${name} must be 40 or 64 hexadecimal characters`);
}

/** Refuses a malformed `base` or `tree` to place threads on, before a write is recorded. */
export function checkPlacement(query: URLSearchParams): void {
    for (const name of ['base', 'tree']) if (query.has(name)) checkId(query.get(name), name);
}

/** The id, if it names an object of one of these types in the worktree's repository. */
async function checkObject(worktree: string, id: unknown, name: string, types: string[]): Promise<string> {
    checkId(id, name);
    const type = (await git(worktree, ['cat-file', '-t', id]).catch(() => 'missing')).trim();
    if (!types.includes(type)) throw httpError(400, `${name} ${id} is not a ${types.join(' or ')} of ${worktree}`);
    return id;
}

/** The lines of the file at `path` in a commit or tree, null without such a file; any other failure of git throws. */
async function fileLines(worktree: string, object: string, path: string): Promise<string[] | null> {
    // --batch answers "<name> missing" for a path the object lacks, in any locale, and fails only when git does.
    const answer = await git(worktree, ['cat-file', '--batch'], undefined, `${object}:${path}\n`);
    const header = answer.slice(0, answer.indexOf('\n'));
    // A directory is no file either.
    if (!/ blob \d+$/.test(header)) return null;
    // The content follows the header, then one more newline.
    const content = answer.slice(header.length + 1, -1);
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();
    return lines;
}

/**
 * A session answered, with each thread's place `at` in the code the query names, null when Outdated:
 * the displayed `base` and `tree` ids for the UI, with the context of a thread out of the diff,
 * or, with `reanchor`, HEAD and the working tree for list_open_threads(), Resolved threads left as they are.
 * Without either, the session as it is.
 */
export async function placed(answer: unknown, query: URLSearchParams): Promise<unknown> {
    const session = answer as ReturnType<typeof view>;
    if (!session?.threads || (!query.has('reanchor') && !query.has('base') && !query.has('tree'))) return answer;
    const { worktree } = session;
    // list_open_threads() leaves Resolved threads out, and shows no context.
    const forClaude = query.has('reanchor');
    const shown = forClaude ? { base: await head(worktree), tree: await writeTree(worktree) } : {
        base: await checkObject(worktree, query.get('base'), 'base', ['commit', 'tree']),
        tree: await checkObject(worktree, query.get('tree'), 'tree', ['tree']),
    };
    const files = forClaude ? [] : (await diff(worktree, shown)).files;
    // ponytail: one git cat-file per file and side on each 2 s poll; read them all in one `git cat-file --batch` if sessions grow many files.
    const read = new Map<string, Promise<string[] | null>>();
    return {
        ...session,
        threads: await Promise.all(session.threads.map(async thread => {
            if (forClaude && thread.resolved) return thread;
            const { path, side } = thread.anchor;
            if (!read.has(`${side} ${path}`)) read.set(`${side} ${path}`, fileLines(worktree, side === 'new' ? shown.tree : shown.base, path));
            const lines = await read.get(`${side} ${path}`)!;
            const at = reanchor(thread.anchor, lines);
            return { ...thread, at: at && (forClaude ? at : { ...at, context: context(files.find(file => file.path === path)?.hunks ?? [], side, at, lines!) }) };
        })),
    };
}

/**
 * The lines around a range whose last line no hunk shows, from 3 above to 3 below, minus those the hunks show:
 * unchanged, so numbered on both sides, to show as a hunk of their own. None when a hunk shows the range.
 */
function context(hunks: Hunk[], side: 'old' | 'new', { start, end }: { start: number; end: number }, lines: string[]): Line[] {
    const no = side === 'new' ? 'newNo' : 'oldNo';
    const shown = new Set(hunks.flatMap(hunk => hunk.lines.map(line => line[no])));
    if (shown.has(end)) return [];
    // The first line after each hunk on both sides, from its header: a hunk may number lines of one side only (diff.context=0).
    // A count of 0 places the hunk after its start line.
    const next = hunks.map(({ header }) => {
        const [, a, b = '1', c, d = '1'] = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)!;
        return { old: Number(a) + Math.max(Number(b), 1), new: Number(c) + Math.max(Number(d), 1) };
    });
    const other = side === 'new' ? 'old' : 'new';
    const around: Line[] = [];
    for (let k = Math.max(1, start - 3); k <= Math.min(lines.length, end + 3); k++) {
        if (shown.has(k)) continue;
        // An unchanged line keeps its distance to the end of the last hunk above it, on both sides.
        const last = next.findLast(after => after[side] <= k);
        const moved = last ? k - last[side] + last[other] : k;
        around.push({ type: 'context', oldNo: side === 'old' ? k : moved, newNo: side === 'new' ? k : moved, text: lines[k - 1] });
    }
    return around;
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
    const lines = await fileLines(session.worktree, side === 'new' ? tree : base, path);
    if (!lines) throw httpError(400, `No ${path} on the ${side} side`);
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
    const added = message(input.author, input.body);
    // Published at once, Claude's reply would pass before my Pending message at the Send.
    if (added.author === 'claude' && !thread.messages.some(message => message.date)) {
        throw httpError(409, `Thread ${threadId} has no published message to reply to`);
    }
    thread.messages.push(added);
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
