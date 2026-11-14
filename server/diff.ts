import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export type Line = { type: 'context' | 'add' | 'del' | 'note'; oldNo: number | null; newNo: number | null; text: string };
export type Hunk = { header: string; lines: Line[] };
export type FileDiff = {
    path: string;
    status: 'added' | 'deleted' | 'modified';
    binary: boolean;
    collapsed: boolean;
    additions: number;
    deletions: number;
    hunks: Hunk[];
};

const run = promisify(execFile);

export async function git(worktree: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
    // Inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE… (as in a git hook) would point git at another repository.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const pending = run('git', args, { cwd: worktree, env: { ...inherited, ...env }, maxBuffer: Infinity });
    // Without a listener, an EPIPE on stdin would crash the process; killing git turns it into a rejection.
    pending.child.stdin!.on('error', () => pending.child.kill()).end(input);
    return (await pending.catch(error => {
        // A missing cwd fails the spawn itself, as "spawn git ENOENT".
        if (error.code === 'ENOENT' && !existsSync(worktree)) throw Object.assign(new Error(`No worktree at ${worktree}`), { status: 400 });
        throw error;
    })).stdout;
}

/** Writes the working tree (tracked and untracked files, minus ignored ones) as a git tree, without touching the worktree's index. */
export async function writeTree(worktree: string): Promise<string> {
    const index = resolve(worktree, (await git(worktree, ['rev-parse', '--git-path', 'index'])).trim());
    const tmp = await mkdtemp(join(tmpdir(), 'claude-reviews-index-'));
    try {
        const env = { GIT_INDEX_FILE: join(tmp, 'index') };
        // Starting from the worktree's index lets `git add -A` reuse its stat cache and rehash only modified files.
        const indexStat = await stat(index).catch(() => null);
        if (indexStat) {
            await copyFile(index, env.GIT_INDEX_FILE);
            // git trusts the stat of an entry older than the index file ("racy git"): the copy must not look newer than the original.
            await utimes(env.GIT_INDEX_FILE, indexStat.atime, new Date(indexStat.mtimeMs - 1000));
        }
        // `git add -A` skips files flagged assume-unchanged (lowercase tag) or skip-worktree (S or s), so unflag them;
        // a skip-worktree file missing from disk is out of a sparse checkout, not deleted.
        const entries = (await git(worktree, ['ls-files', '-v', '-z'], env)).split('\0');
        const unflag = {
            '--no-assume-unchanged': entries.filter(entry => /^[a-z] /.test(entry)),
            '--no-skip-worktree': entries.filter(entry => /^[Ss] /.test(entry) && existsSync(join(worktree, entry.slice(2)))),
        };
        for (const [flag, flagged] of Object.entries(unflag)) {
            if (flagged.length) await git(worktree, ['update-index', flag, '-z', '--stdin'], env, flagged.map(entry => entry.slice(2)).join('\0'));
        }
        // --ignore-errors adds what it can around what it cannot (a nested repository without commit), then exits with 1.
        await git(worktree, ['-c', 'core.safecrlf=false', 'add', '-A', '--ignore-errors'], env)
            .catch(error => { if (error.code !== 1) throw error; });
        return (await git(worktree, ['write-tree'], env)).trim();
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

/** HEAD, or the empty tree in a repository without any commit. */
async function head(worktree: string): Promise<string> {
    return (await git(worktree, ['rev-parse', '--verify', '-q', 'HEAD'])
        .catch(() => git(worktree, ['hash-object', '-t', 'tree', '/dev/null']))).trim();
}

/** The diff from `base` to `tree`, by default from HEAD to a tree of the working tree written now. */
export async function diff(worktree: string, shown?: { base: string; tree: string }): Promise<{ base: string; tree: string; files: FileDiff[] }> {
    const base = shown?.base ?? await head(worktree);
    const tree = shown?.tree ?? await writeTree(worktree);
    // Pinned options, so the user's git config cannot change what gets parsed.
    const patch = await git(worktree, [
        '-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=true',
        'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', base, tree,
    ]);
    return { base, tree, files: parseDiff(patch) };
}

/** The path in a `diff --git a/<path> b/<path>` header, where --no-renames makes both sides the same. */
function headerPath(header: string): string {
    const sides = header.slice('diff --git '.length);
    if (sides[0] !== '"') return sides.slice(2, 2 + (sides.length - 5) / 2);
    // git C-quotes a path with a quote, backslash, control or non-ASCII character, escaping bytes in octal.
    const bytes: number[] = [];
    for (let i = 1; sides[i] !== '"'; i++) {
        if (sides[i] !== '\\') bytes.push(sides.charCodeAt(i));
        else if (/[0-7]/.test(sides[++i])) {
            bytes.push(parseInt(sides.slice(i, i + 3), 8));
            i += 2;
        } else bytes.push({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }[sides[i]] ?? sides.charCodeAt(i));
    }
    return Buffer.from(bytes).toString().slice(2);
}

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'go.sum']);
const MAX_DIFF_SIZE = 1024 * 1024;

export function parseDiff(text: string): FileDiff[] {
    const files: FileDiff[] = [];
    for (const chunk of text.split(/^(?=diff --git )/m)) {
        if (!chunk.startsWith('diff --git ')) continue;
        const lines = chunk.split('\n');
        const path = headerPath(lines[0]);
        const file: FileDiff = { path, status: 'modified', binary: false, collapsed: false, additions: 0, deletions: 0, hunks: [] };
        let oldNo = 0;
        let newNo = 0;
        for (const line of lines.slice(1)) {
            if (line.startsWith('@@')) {
                const [, o, n] = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)!;
                oldNo = Number(o);
                newNo = Number(n);
                file.hunks.push({ header: line, lines: [] });
            } else if (file.hunks.length === 0) {
                if (line.startsWith('new file mode')) file.status = 'added';
                else if (line.startsWith('deleted file mode')) file.status = 'deleted';
                else if (line.startsWith('Binary files ')) file.binary = true;
            } else if (line[0] === '+') {
                file.additions++;
                file.hunks.at(-1)!.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
            } else if (line[0] === '-') {
                file.deletions++;
                file.hunks.at(-1)!.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
            } else if (line[0] === ' ') {
                file.hunks.at(-1)!.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
            } else if (line[0] === '\\') {
                file.hunks.at(-1)!.lines.push({ type: 'note', oldNo: null, newNo: null, text: line.slice(2) });
            }
        }
        // ponytail: a collapsed diff still ships whole in the JSON; serve it per file on Load diff if payloads get heavy.
        file.collapsed = LOCKFILES.has(path.split('/').at(-1)!) || Buffer.byteLength(chunk) > MAX_DIFF_SIZE;
        files.push(file);
    }
    return files;
}
