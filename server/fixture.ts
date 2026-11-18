import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repos: string[] = [];

export function git(dir: string, ...args: string[]): string {
    // Neither the developer's global config (commit signing, hooks…) nor inherited GIT_DIR and the like may leak into fixtures.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const env = { ...inherited, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, env, encoding: 'utf8' });
}

export function write(dir: string, files: Record<string, string | Buffer>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
}

/** A git repository in a temporary directory, with `files` committed on HEAD; without files, a repository with no commit. */
export function repo(files: Record<string, string | Buffer>): string {
    const dir = mkdtempSync(join(tmpdir(), 'claude-reviews-'));
    repos.push(dir);
    git(dir, 'init', '-q');
    if (Object.keys(files).length === 0) return dir;
    write(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial');
    return dir;
}

/** A worktree of the repository `dir`, on a branch of its own, removed with the repositories. */
export function worktree(dir: string): string {
    const parent = mkdtempSync(join(tmpdir(), 'claude-reviews-'));
    repos.push(parent);
    git(dir, 'worktree', 'add', '-q', '-b', `wt-${repos.length}`, join(parent, 'wt'));
    return join(parent, 'wt');
}

/** Makes the worktree at `dir` disappear, as `git worktree remove` would, by moving it next to itself, removed with the repositories. */
export function vanish(dir: string): void {
    renameSync(dir, `${dir}-gone`);
    repos.push(`${dir}-gone`);
}

/** Points XDG_DATA_HOME at a temporary directory, removed with the repositories, so tests never touch the real sessions. */
export function dataHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claude-reviews-data-'));
    repos.push(dir);
    process.env.XDG_DATA_HOME = dir;
    return dir;
}

export function removeRepos(): void {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
}
