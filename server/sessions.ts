import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
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
/**
 * `base` is the last base chosen: HEAD, last-review, origin/HEAD, refs/heads/<branch> or refs/remotes/<remote>/<branch>.
 * `commonDir` is the repository shared by the worktrees, where the refs stay once the worktree is gone; absent from sessions opened before it was kept.
 * `sentAt` is the date of the last Send.
 * `closedBecause` tells a session closed because its worktree is gone from an approved one.
 * `viewed` maps each file marked Viewed to the id of its content in the tree it was marked on, DELETED for a file absent from it;
 * absent from sessions opened before Viewed.
 */
export type Session = {
    id: string; worktree: string; commonDir?: string; createdAt: string; approvedAt: string | null; closedBecause?: 'worktree-gone';
    base: string; sends: number; sentAt?: string; threads: Thread[]; viewed?: Record<string, string>;
};

const DELETED = 'deleted';

// ponytail: one queue for every session write keeps read-modify-write safe; per-session queues if writes ever wait on each other.
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
}

export function httpError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

export function dataDir(): string {
    return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'claude-reviews');
}

/** Replaces the file atomically: a reader, or a crash, never sees it half written. A session may hold the identity git reads, so 0600. */
async function save(session: Session): Promise<void> {
    const dir = join(dataDir(), 'sessions');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${session.id}.json`);
    // ponytail: no fsync, so a power cut right after the rename may leave an empty file on some filesystems; fsync the temp file if it ever bites.
    await writeFile(`${file}.tmp`, JSON.stringify(session, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
}

/** The session as served: what is stored, plus whose turn it is in each thread. */
/** When a Claude session last read the session of each worktree, by the 2 s poll of the mod, and whether it was Blocked then. */
const claudeReads = new Map<string, { at: number; blocked: boolean }>();
/** When /review-local last asked the IDE clients to show each session; a restart forgets it, as a request is for now. */
const showRequests = new Map<string, string>();

function view(session: Session) {
    const read = claudeReads.get(session.worktree);
    const claudeSession = Date.now() - (read?.at ?? -Infinity) <= 10_000;
    const threads = session.threads.map(thread => ({ ...thread, status: status(thread) }));
    // Blocked matters to the review only while a thread waits for Claude: the clients show it then, and only then.
    const claudeBlocked = claudeSession && read!.blocked && threads.some(thread => thread.status === 'waiting-for-claude');
    return { ...session, claudeSession, claudeBlocked, showRequestedAt: showRequests.get(session.id) ?? null, threads };
}

/** Waiting for Claude when my message is the last published, open when Claude's is; null before any is published. */
function status(thread: Thread): 'resolved' | 'waiting-for-claude' | 'open' | null {
    if (thread.resolved) return 'resolved';
    const last = thread.messages.findLast(message => message.date);
    return !last ? null : last.author === 'me' ? 'waiting-for-claude' : 'open';
}

async function load(id: string): Promise<Session> {
    for (const dir of ['sessions', 'archive']) {
        const content = await readFile(join(dataDir(), dir, `${id}.json`), 'utf8')
            .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (content) return JSON.parse(content);
    }
    throw httpError(404, `No session ${id}`);
}

/** The session, closed first as an Approve when its worktree is gone: a page left open on it learns so at its next poll. */
export async function getSession(id: string) {
    const session = await load(id);
    if (session.approvedAt || !await gone(session)) return view(session);
    await closeGone([id]);
    return view(await load(id));
}

/** Whether `path` surely does not exist: any failure but ENOENT, a permission or an unmounted disk, may hide it. */
function missing(path: string): Promise<boolean> {
    return stat(path).then(() => false, error => error.code === 'ENOENT');
}

/**
 * Whether the worktree of the session is surely gone: its path missing while its parent directory, and its common repository out of it, stay
 * (an unmounted disk takes them, or leaves an empty mount point), or `here`, the worktree now at its path, of another repository.
 */
async function gone(session: Session, here?: { worktree: string; commonDir: string }): Promise<boolean> {
    // ponytail: a main worktree created again at its path, or a linked worktree added again at its path in the same repository, keeps the same commonDir,
    // so it takes the session over unless a read saw it gone in between.
    if (here?.worktree === session.worktree) return !!session.commonDir && session.commonDir !== here.commonDir;
    const exists = (path: string) => stat(path).then(() => true, () => false);
    if (!await missing(session.worktree) || !await exists(dirname(session.worktree))) return false;
    const { commonDir } = session;
    return !commonDir || commonDir.startsWith(`${session.worktree}/`) || await exists(commonDir);
}

/**
 * The open sessions; one whose worktree is gone is first closed as an Approve, so that a new worktree at its path does not inherit it.
 * Only that closing waits for the writes, through `lock`: `exclusive`, or a no-op for a caller already inside it.
 */
async function openSessions(lock: typeof exclusive = exclusive, here?: { worktree: string; commonDir: string }): Promise<Session[]> {
    const dir = join(dataDir(), 'sessions');
    const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'));
    const open = [];
    const closing = [];
    for (const name of names) {
        const file = join(dir, name);
        // An Approve may move a file away between the listing and its reading.
        const content = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        let session: Session | null = null;
        try {
            session = content && JSON.parse(content);
        } catch (error) {
            // A power cut may leave a file truncated (see save()): it must not take every other session down with it.
            console.error(`claude-reviews: ${file} is left out, unreadable: ${(error as Error).message}`);
        }
        if (!session || session.approvedAt) continue;
        if (await gone(session, here)) closing.push(session.id);
        else open.push(session);
    }
    if (closing.length) await closeGone(closing, lock, here);
    return open;
}

/** Closes as an Approve each of these sessions whose worktree is gone, read again under the lock: a write queued since must not be lost. */
async function closeGone(ids: string[], lock: typeof exclusive = exclusive, here?: { worktree: string; commonDir: string }): Promise<void> {
    await lock(async () => {
        for (const id of ids) {
            const session = await load(id).catch(() => null);
            if (session && !session.approvedAt && await gone(session, here)) await close(session, 'worktree-gone');
        }
    });
}

/** The top of the worktree at `path`, its common repository, and its open session if it has one. */
async function lookup(path: unknown, lock: typeof exclusive = exclusive): Promise<{ worktree: string; commonDir: string; session?: Session }> {
    if (typeof path !== 'string' || !isAbsolute(path)) throw httpError(400, 'worktree must be an absolute path');
    const [worktree, commonDir] = (await git(path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']).catch(() => {
        throw httpError(400, `No git worktree at ${path}`);
    })).trim().split('\n');
    return { worktree, commonDir, session: (await openSessions(lock, { worktree, commonDir })).find(session => session.worktree === worktree) };
}

/** The open sessions of all worktrees, for Reviews: Waiting for Claude first, then the rest, the latest active first at a tie. */
export async function listSessions() {
    const list = await Promise.all((await openSessions()).map(async session => {
        const { repo, branch, updatedAt } = await summary(session);
        return {
            id: session.id,
            worktree: session.worktree,
            repo,
            branch,
            waitingForClaude: session.threads.filter(thread => status(thread) === 'waiting-for-claude').length,
            updatedAt,
        };
    }));
    return list.sort((a, b) => Number(b.waitingForClaude > 0) - Number(a.waitingForClaude > 0) || b.updatedAt.localeCompare(a.updatedAt));
}

/** The repository, the branch (empty on a detached HEAD) and the last activity of a session. */
async function summary(session: Session) {
    return {
        repo: repository(session.commonDir ?? join(session.worktree, '.git')),
        branch: (await git(session.worktree, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim(),
        updatedAt: [session.createdAt, ...session.threads.flatMap(thread => thread.messages.map(message => message.date ?? ''))].sort().at(-1)!,
    };
}

/** The open sessions as gh-notif reads them, among its local sources: an entry each, whose URL is on `origin`. */
export async function inbox(origin: string) {
    return Promise.all((await openSessions()).map(async session => {
        const { repo, branch, updatedAt } = await summary(session);
        const statuses = session.threads.map(status);
        const last = session.threads.flatMap(thread => thread.messages.filter(message => message.date)).sort((a, b) => a.date!.localeCompare(b.date!)).at(-1);
        return {
            repo, branch, title: branch || basename(session.worktree), url: `${origin}/s/${session.id}`,
            openThreads: statuses.filter(status => status === 'waiting-for-claude' || status === 'open').length,
            // The threads Claude spoke last in: the BRIEF's contract names them so, though no client shows a status for them.
            awaitingMe: statuses.filter(status => status === 'open').length,
            lastActor: last?.author ?? null,
            updatedAt,
        };
    }));
}

/** The closed sessions, approved or with their worktree gone, the latest closed first; an unreadable file is left out, logged. */
// ponytail: every archived file read at each call; keep an index if the archive grows to thousands.
export async function closedSessions() {
    const dir = join(dataDir(), 'archive');
    const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'));
    const sessions = await Promise.all(names.map(name => readFile(join(dir, name), 'utf8').then(content => JSON.parse(content) as Session).catch(error => {
        console.error(`claude-reviews: ${join(dir, name)} is left out, unreadable: ${(error as Error).message}`);
        return null;
    })));
    return sessions.filter(session => session?.approvedAt)
        .map(session => ({ id: session!.id, worktree: session!.worktree, repo: repository(session!.commonDir ?? join(session!.worktree, '.git')), approvedAt: session!.approvedAt!, closedBecause: session!.closedBecause ?? null }))
        .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
}

/** The name of a repository from its common directory: app for app/.git, a bare app.git, or the submodule app under .git/modules/. */
function repository(commonDir: string): string {
    return basename(commonDir) === '.git' ? basename(dirname(commonDir)) : basename(commonDir).replace(/\.git$/, '');
}

/** The open session of the worktree, never created: the mod looks for it without filling Reviews with empty sessions. */
/** The open session of the worktree; `claude` when the mod reads it, for a Claude session runs there. */
export async function findSession(path: unknown, claude = false, blocked = false) {
    const { worktree, session } = await lookup(path);
    if (claude) claudeReads.set(worktree, { at: Date.now(), blocked });
    if (!session) throw httpError(404, `No open session for ${worktree}`);
    return view(session);
}

/** The open session of the worktree, created on first call: a write, so that two calls never create two sessions. */
export function openSession(path: unknown) {
    return exclusive(async () => {
        const { worktree, commonDir, session: open } = await lookup(path, task => task());
        if (open) return view(open);
        const session = { id: randomBytes(8).toString('hex'), worktree, commonDir, createdAt: new Date().toISOString(), approvedAt: null, base: 'HEAD', sends: 0, threads: [], viewed: {} };
        await save(session);
        return view(session);
    });
}

type Pull = { number: number; title: string; headRefName: string; baseRefName: string; isCrossRepository: boolean; headRepositoryOwner: { login: string } };

/** The open pull requests of the worktree's GitHub repository, by gh, kept 60 s; none when gh fails or takes over 2 s. */
const pulls = new Map<string, { at: number; list: Promise<Pull[]> }>();
function openPulls(worktree: string): Promise<Pull[]> {
    const kept = pulls.get(worktree);
    if (kept && Date.now() - kept.at < 60_000) return kept.list;
    const list = new Promise<Pull[]>(resolve => execFile('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,baseRefName,isCrossRepository,headRepositoryOwner'],
        { cwd: worktree, timeout: 2000 }, (error, stdout) => {
            try {
                resolve(error ? [] : JSON.parse(stdout));
            } catch {
                resolve([]);
            }
        }));
    pulls.set(worktree, { at: Date.now(), list });
    return list;
}

type Base = { ref: string; name: string; disabled?: boolean; group?: string };

/**
 * The bases of the selector, in its order: Uncommitted changes, Since my last review, the default branch, the base branch,
 * then, each in a group, the open pull requests by their head on origin, the local branches and the remote ones, from the nearest merge-base.
 * The base branch is the base of the branch's pull request, else the nearest local branch, none on the default branch;
 * a pull request from a fork is the branch's when a remote of the fork's owner has the branch.
 */
export async function bases(session: Session): Promise<Base[]> {
    const list: Base[] = [{ ref: 'HEAD', name: 'Uncommitted changes' }, { ref: 'last-review', name: 'Since my last review', disabled: session.sends === 0 }];
    const [lines, branch, origin, prs, remotes] = await Promise.all([
        // Each line: "*" on the checked-out branch, the ref, then its commits not in HEAD and HEAD's commits not in it, past their merge-base.
        git(session.worktree, ['for-each-ref', '--format=%(HEAD) %(refname) %(ahead-behind:HEAD)', 'refs/heads/', 'refs/remotes/']).catch(() => ''),
        git(session.worktree, ['symbolic-ref', '--short', '-q', 'HEAD']).then(name => name.trim(), () => ''),
        git(session.worktree, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then(ref => ref.trim(), () => ''),
        openPulls(session.worktree),
        git(session.worktree, ['remote', '-v']).catch(() => ''),
    ]);
    const refs = lines.split('\n').filter(line => line.startsWith('  ')).map(line => line.slice(2).split(' '))
        .filter(([ref]) => !ref.endsWith('/HEAD'))
        .map(([ref, ahead, behind]) => ({ ref, remote: ref.startsWith('refs/remotes/'), ahead: Number(ahead), behind: Number(behind) }));
    // The nearest merge-base is the one fewest commits of HEAD lie after: the parent of a stacked branch comes first.
    refs.sort((a, b) => Number(a.remote) - Number(b.remote) || a.behind - b.behind || a.ahead - b.ahead);
    const has = (ref: string) => refs.some(found => found.ref === ref);
    const name = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');

    const defaultName = origin.replace(/^refs\/remotes\/origin\//, '');
    // Another fork can have a branch of the same name: a remote line, "<name>\t<url> (fetch)", tells them apart by /<login>/ or :<login>/.
    const forked = (pr: Pull) => remotes.split('\n').some(line => has(`refs/remotes/${line.split('\t')[0]}/${branch}`)
        && new RegExp(`[/:]${pr.headRepositoryOwner.login}/`, 'i').test(line));
    const mine = prs.find(pr => pr.headRefName === branch && (!pr.isCrossRepository || forked(pr)));
    // The default branch itself has no base branch.
    const baseRef = mine ? [`refs/remotes/origin/${mine.baseRefName}`, `refs/heads/${mine.baseRefName}`].find(has)
        // A branch that holds HEAD and commits of its own comes after it, as the next branch of a stack: never its base.
        : branch === defaultName ? undefined : refs.find(found => !found.remote && !(found.behind === 0 && found.ahead > 0))?.ref;
    const baseName = mine ? mine.baseRefName : baseRef && name(baseRef);
    const listed = new Set([origin]);
    if (origin) list.push({ ref: 'origin/HEAD', name: `${defaultName} (${baseName === defaultName ? 'default and base branch' : 'default branch'})` });
    if (baseRef && baseName !== defaultName) {
        list.push({ ref: baseRef, name: `${baseName} (base branch)` });
        listed.add(baseRef);
    }
    for (const pr of prs) {
        const ref = `refs/remotes/origin/${pr.headRefName}`;
        if (pr.isCrossRepository || pr === mine || !has(ref) || listed.has(ref)) continue;
        list.push({ ref, name: `#${pr.number} ${pr.title}`, group: 'Pull requests' });
        listed.add(ref);
    }
    // ponytail: every remote branch is listed, hundreds on a big repository; the clients search by typing.
    for (const { ref, remote } of refs) if (!listed.has(ref)) list.push({ ref, name: name(ref), group: remote ? 'Remote branches' : 'Local branches' });
    return list;
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

/** The text of `path` in a commit or tree of the session's repository: the base side of a diff an IDE shows. */
export async function file(id: string, object: unknown, path: unknown) {
    checkPath(path);
    const { worktree } = await load(id);
    const text = await fileText(worktree, await checkObject(worktree, object, 'object', ['commit', 'tree']), path);
    if (text === null) throw httpError(404, `No ${path} in ${object}`);
    return { text };
}

/** The diff of the ids the UI would display now, or, with `?base=&tree=`, of the displayed ones again; whitespace hidden with `w=1`. */
export async function sessionDiff(id: string, query: URLSearchParams) {
    const session = await load(id);
    if (query.has('base') || query.has('tree')) return diff(session.worktree, await displayed(session.worktree, query), query.has('w'));
    const shown = await current(session);
    return { ...shown, ...await diff(session.worktree, shown, query.has('w')) };
}

const MAX_LINES = 1000;

/** Lines `from` to `to` of the file at `path` in the displayed `tree`, for the UI to show the lines its diff hides. */
export async function treeLines(id: string, query: URLSearchParams) {
    const { worktree } = await load(id);
    const path = query.get('path');
    checkPath(path);
    const tree = await checkObject(worktree, query.get('tree'), 'tree', ['tree']);
    const [from, to] = [query.get('from'), query.get('to')].map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from >= MAX_LINES) {
        throw httpError(400, `from and to must be line numbers, from up to to, at most ${MAX_LINES} lines apart`);
    }
    const lines = await fileLines(worktree, tree, path);
    if (!lines) throw httpError(400, `No ${path} in tree ${tree}`);
    return { lines: lines.slice(from - 1, to) };
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

/** Refuses a malformed `base`, `tree` or `w` to place threads on, before a write is recorded. */
export function checkPlacement(query: URLSearchParams): void {
    for (const name of ['base', 'tree']) if (query.has(name)) checkId(query.get(name), name);
    if (query.has('w') && query.get('w') !== '1') throw httpError(400, 'w must be 1, or absent');
}

/** The `base` and `tree` of the query, the code the UI displays, if they name a commit or tree and a tree of the worktree's repository. */
async function displayed(worktree: string, query: URLSearchParams): Promise<{ base: string; tree: string }> {
    return {
        base: await checkObject(worktree, query.get('base'), 'base', ['commit', 'tree']),
        tree: await checkObject(worktree, query.get('tree'), 'tree', ['tree']),
    };
}

/** The id, if it names an object of one of these types in the worktree's repository. */
async function checkObject(worktree: string, id: unknown, name: string, types: string[]): Promise<string> {
    checkId(id, name);
    const type = (await git(worktree, ['cat-file', '-t', id]).catch(() => 'missing')).trim();
    if (!types.includes(type)) throw httpError(400, `${name} ${id} is not a ${types.join(' or ')} of ${worktree}`);
    return id;
}

/** The text of the file at `path` in a commit or tree, null without such a file; any other failure of git throws. */
async function fileText(worktree: string, object: string, path: string): Promise<string | null> {
    // --batch answers "<name> missing" for a path the object lacks, in any locale, and fails only when git does.
    const answer = await git(worktree, ['cat-file', '--batch'], undefined, `${object}:${path}\n`);
    const header = answer.slice(0, answer.indexOf('\n'));
    // A directory is no file either.
    if (!/ blob \d+$/.test(header)) return null;
    // The content follows the header, then one more newline.
    return answer.slice(header.length + 1, -1);
}

/** The lines of the file at `path` in a commit or tree, null without such a file. */
async function fileLines(worktree: string, object: string, path: string): Promise<string[] | null> {
    const content = await fileText(worktree, object, path);
    if (content === null) return null;
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();
    return lines;
}

/**
 * A session answered, with each thread's place `at` in the code the query names, null when Outdated:
 * the displayed `base` and `tree` ids for the UI, with the context of a thread out of the diff, whitespace hidden with `w=1`,
 * or, with `reanchor`, HEAD and the working tree for list_open_threads(), Resolved threads left as they are.
 * Without either, the session as it is.
 */
export async function placed(answer: unknown, query: URLSearchParams): Promise<unknown> {
    const session = answer as ReturnType<typeof view>;
    if (!session?.threads || (!query.has('reanchor') && !query.has('base') && !query.has('tree'))) return answer;
    const { worktree } = session;
    // list_open_threads() leaves Resolved threads out, and shows no context.
    const forClaude = query.has('reanchor');
    // Claude's old side is the base of the session, as mine: a line a commit deleted still stands there.
    const shown = forClaude ? await current(session) : await displayed(worktree, query);
    // A file stays Viewed while its content in the displayed tree keeps the id it was marked on, whatever the base.
    const viewed = Object.entries(session.viewed ?? {});
    const [files, blobsNow] = forClaude ? [[], []] : await Promise.all([
        diff(worktree, shown, query.has('w')).then(shown => shown.files),
        blobs(worktree, shown.tree, viewed.map(([path]) => path)),
    ]);
    // ponytail: one git cat-file per file and side on each 2 s poll; read them all in one `git cat-file --batch` if sessions grow many files.
    const read = new Map<string, Promise<string[] | null>>();
    return {
        ...session,
        viewed: forClaude ? session.viewed : Object.fromEntries(viewed.filter(([, blob], i) => blob === blobsNow[i])),
        ...forClaude && { reanchoredOn: { base: shown.base, tree: shown.tree } },
        threads: await Promise.all(session.threads.map(async thread => {
            if (forClaude && thread.resolved) return thread;
            const { path, side } = thread.anchor;
            if (!read.has(`${side} ${path}`)) read.set(`${side} ${path}`, fileLines(worktree, side === 'new' ? shown.tree : shown.base, path));
            const lines = await read.get(`${side} ${path}`)!;
            // A thread on a whole file stays while its file is there.
            const whole = thread.anchor.end === 0;
            const at = whole ? lines && { start: 0, end: 0 } : reanchor(thread.anchor, lines);
            return { ...thread, at: at && (forClaude ? at : { ...at, context: whole ? [] : context(files.find(file => file.path === path)?.hunks ?? [], side, at, lines!) }) };
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
    if (session.approvedAt) throw httpError(409, 'session approved');
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
        || !Number.isInteger(from) || !Number.isInteger(to) || (from === 0 ? to !== 0 : from < 1 || to < from)) {
        throw httpError(400, 'A thread needs a path, a side ("old" or "new") and a range of lines from start to end, or 0 and 0 for the whole file');
    }
    checkPath(path);
    const shown = first.author === 'me' ? {
        base: await checkObject(session.worktree, input.base, 'base', ['commit', 'tree']),
        tree: await checkObject(session.worktree, input.tree, 'tree', ['tree']),
    } : await current(session);
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
        // A thread deleted with its only message leaves its id unused.
        id: Math.max(0, ...session.threads.map(thread => thread.id)) + 1,
        anchor: to === 0 ? { path, side, start: 0, end: 0, lines: [], before: [], after: [], hunk: null } : {
            path, side, start: from, end: to,
            lines: lines.slice(from - 1, to), before: lines.slice(Math.max(0, from - 4), from - 1), after: lines.slice(to, to + 3), hunk,
        },
        resolved: false,
        messages: [first],
    });
    await save(session);
    return view(session);
}

function checkPath(path: unknown): asserts path is string {
    // No leading or trailing slash, no empty, `.` or `..` segment; a newline would split the path in two for `git cat-file --batch`.
    if (typeof path !== 'string' || path.split('/').some(segment => ['', '.', '..'].includes(segment)) || path.includes('\n')) {
        throw httpError(400, `${path} is not a canonical path from the top of the worktree`);
    }
}

/** The id of the entry at each path in `tree`, of any type (a submodule names a commit not in this repository), DELETED for a path absent from it. */
async function blobs(worktree: string, tree: string, paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    // Literal pathspecs: a path may hold `*` or `?`.
    const answer = await git(worktree, ['ls-tree', '-z', '--format=%(objectname) %(path)', tree, '--', ...paths], { GIT_LITERAL_PATHSPECS: '1' });
    const ids = new Map(answer.split('\0').filter(Boolean).map(entry => [entry.slice(entry.indexOf(' ') + 1), entry.slice(0, entry.indexOf(' '))]));
    return paths.map(path => ids.get(path) ?? DELETED);
}

/** Marks the file at `path` Viewed on the displayed `tree`, or no longer Viewed. */
export async function markViewed(id: string, { path, tree, viewed }: Record<string, unknown>) {
    const session = await writable(id);
    checkPath(path);
    if (typeof viewed !== 'boolean') throw httpError(400, 'viewed must be a boolean');
    const others = Object.entries(session.viewed ?? {}).filter(([other]) => other !== path);
    if (viewed) others.push([path, (await blobs(session.worktree, await checkObject(session.worktree, tree, 'tree', ['tree']), [path]))[0]]);
    // Entries, not an assignment: a file named __proto__ is a key like any other.
    session.viewed = Object.fromEntries(others);
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
    if (added.author === 'me' && thread.resolved) throw httpError(409, `Thread ${threadId} is Resolved: Unresolve it to reply`);
    thread.messages.push(added);
    await save(session);
    return view(session);
}

/** My Pending message at `index` in the thread: the only kind of message that can still change. */
function pending(thread: Thread, index: number): Message {
    const message = thread.messages[index];
    if (!message) throw httpError(404, `No message ${index} in thread ${thread.id}`);
    if (message.author !== 'me' || message.date) throw httpError(409, `Message ${index} of thread ${thread.id} is published: only a Pending message of mine can change`);
    return message;
}

export async function editMessage(id: string, threadId: number, index: number, { body }: Record<string, unknown>) {
    const session = await writable(id);
    pending(findThread(session, threadId), index).body = message('me', body).body;
    await save(session);
    return view(session);
}

/** Deletes a Pending message of mine; a thread left without any message goes with it. */
export async function deleteMessage(id: string, threadId: number, index: number) {
    const session = await writable(id);
    const thread = findThread(session, threadId);
    pending(thread, index);
    thread.messages.splice(index, 1);
    if (!thread.messages.length) session.threads = session.threads.filter(other => other !== thread);
    await save(session);
    return view(session);
}

export async function resolve(id: string, threadId: number, resolved = true) {
    const session = await writable(id);
    findThread(session, threadId).resolved = resolved;
    await save(session);
    return view(session);
}

// The commit only carries the tree, so it must not depend on the user's identity.
const SNAPSHOT_AUTHOR = { GIT_AUTHOR_NAME: 'claude-reviews', GIT_AUTHOR_EMAIL: 'claude-reviews@localhost', GIT_COMMITTER_NAME: 'claude-reviews', GIT_COMMITTER_EMAIL: 'claude-reviews@localhost' };

/** Takes a Snapshot of the displayed `tree`, then publishes the Pending messages of the threads not Resolved, dated now, after the messages already published. */
/** Send: the Snapshot of the displayed tree, then the Pending messages of the session, or of `threads` only when given. */
export async function send(id: string, tree: unknown, threads?: unknown) {
    const session = await writable(id);
    if (threads !== undefined && !(Array.isArray(threads) && threads.every(Number.isInteger))) {
        throw httpError(400, 'threads must be a list of thread ids');
    }
    const sent = threads === undefined ? session.threads : (threads as number[]).map(n => findThread(session, n));
    const shown = await checkObject(session.worktree, tree, 'tree', ['tree']);
    const commit = await git(session.worktree, ['commit-tree', '-m', `claude-reviews session ${id}`, shown], SNAPSHOT_AUTHOR);
    const review = session.sends + 1;
    await git(session.worktree, ['update-ref', `refs/claude-reviews/${id}/${review}`, commit.trim()]);
    const date = new Date().toISOString();
    // A Pending message of a Resolved thread waits for its Unresolve.
    for (const thread of sent.filter(thread => !thread.resolved)) {
        const pending = thread.messages.filter(message => !message.date);
        thread.messages = [...thread.messages.filter(message => message.date), ...pending.map(message => ({ ...message, date, review }))];
    }
    session.sends = review;
    session.sentAt = date;
    await save(session);
    return view(session);
}

/** Asks the IDE clients to show the session: each shows it once it reads a recent request. */
export async function show(id: string) {
    const session = await writable(id);
    showRequests.set(id, new Date().toISOString());
    return view(session);
}

/** The notification of the end of Claude's turn after a Send: the threads he replied in since, and those still waiting for him. */
export function replies(session: Session): string {
    const replied = session.threads.filter(thread => thread.messages.some(message => message.author === 'claude' && message.date! >= (session.sentAt ?? ''))).length;
    const waiting = session.threads.filter(thread => status(thread) === 'waiting-for-claude').length;
    return `Claude replied in ${replied} thread${replied === 1 ? '' : 's'}${waiting ? `, ${waiting} still waiting` : ''}`;
}

export async function approve(id: string) {
    const session = await writable(id);
    // A Pending message of a Resolved thread waits for its Unresolve, which an approved session will never get.
    if (session.threads.some(thread => !thread.resolved && thread.messages.some(message => !message.date))) {
        throw httpError(409, 'Pending messages must be sent before an Approve');
    }
    await close(session);
    return view(session);
}

/** Closes the session, by an Approve or because its worktree is gone: its file moves to archive/, where it stays readable, then its refs go. */
async function close(session: Session, because?: 'worktree-gone'): Promise<void> {
    const { id } = session;
    // Each step leaves a closed session behind: an approved file is never reopened, wherever a crash leaves it.
    session.approvedAt = new Date().toISOString();
    if (because) session.closedBecause = because;
    await save(session);
    await mkdir(join(dataDir(), 'archive'), { recursive: true, mode: 0o700 });
    await rename(join(dataDir(), 'sessions', `${id}.json`), join(dataDir(), 'archive', `${id}.json`));
    // git runs in the common repository, which outlives a linked worktree.
    // ponytail: refs git cannot delete (whole repository gone, or session from before commonDir) stay behind, hidden; sweep refs of archived sessions if they pile up.
    const repository = session.commonDir ?? session.worktree;
    await git(repository, ['for-each-ref', '--format=delete %(refname)', `refs/claude-reviews/${id}/`])
        .then(refs => git(repository, ['update-ref', '--stdin'], undefined, refs))
        .catch(() => {});
}
