import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, watch } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { dataHome, git, removeRepos, repo, write } from './fixture.ts';
import { start } from './main.ts';

const data = join(dataHome(), 'claude-reviews');
let server: Server;
let base: string;
before(async () => {
    server = await start(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
    server.close();
    removeRepos();
});

/** A git on the PATH that logs its arguments, runs `prelude`, then runs the real one; `restore` puts the PATH back. */
function shim(dir: string, prelude = ''): { log: string; restore: () => void } {
    const bin = join(dir, '.git', 'shim');
    const log = join(bin, 'log');
    write(bin, { git: `#!/bin/sh\necho "$*" >> '${log}'\n${prelude}\nexec '${execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()}' "$@"\n` });
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    return { log, restore: () => { process.env.PATH = path; } };
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

test('opening the session of a worktree twice creates one file under sessions/, with an id distinct from the path', async () => {
    const dir = repo({ 'a.txt': 'a\n' });

    const first = await api('POST', '/api/sessions', { worktree: dir });
    const second = await api('POST', '/api/sessions', { worktree: dir });

    assert.equal(first.status, 200);
    assert.match(first.body.id, /^[0-9a-f]{16}$/);
    assert.equal(second.body.id, first.body.id);
    assert.deepEqual(readdirSync(join(data, 'sessions')), [`${first.body.id}.json`]);
});

test('saving a session replaces its file by renaming a temporary file of the same directory, and leaves no temporary file', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const file = join(data, 'sessions', `${id}.json`);
    const inode = statSync(file).ino;
    const seen = new Set<string>();
    const watcher = watch(join(data, 'sessions'), (_, name) => seen.add(String(name)));

    await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Hi' });
    await new Promise(resolve => setTimeout(resolve, 100));
    watcher.close();

    assert.notEqual(statSync(file).ino, inode, 'a new file took the place of the old one');
    assert.ok([...seen].some(name => name !== `${id}.json`), 'a temporary file was written next to it');
    assert.deepEqual(readdirSync(join(data, 'sessions')).filter(name => !name.endsWith('.json')), []);
});

test('a thread on a range of the new side anchors on its file, side, range, lines, up to 3 neighbors each way and diff excerpt, without any SHA', async () => {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n' });
    write(dir, { 'a.txt': 'one\n2\n3\nfour\nfive\nsix\nseven\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const shown = (await api('GET', `/api/sessions/${id}/diff`)).body;

    const opened = await api('POST', `/api/sessions/${id}/threads`, { author: 'me', base: shown.base, tree: shown.tree, path: 'a.txt', side: 'new', start: 2, end: 3, body: 'Why?' });

    assert.equal(opened.status, 200);
    const file = readFileSync(join(data, 'sessions', `${id}.json`), 'utf8');
    assert.deepEqual(JSON.parse(file).threads[0].anchor, {
        path: 'a.txt',
        side: 'new',
        start: 2,
        end: 3,
        lines: ['2', '3'],
        before: ['one'],
        after: ['four', 'five', 'six'],
        hunk: {
            header: '@@ -1,6 +1,6 @@',
            lines: [
                { type: 'context', oldNo: 1, newNo: 1, text: 'one' },
                { type: 'del', oldNo: 2, newNo: null, text: 'two' },
                { type: 'del', oldNo: 3, newNo: null, text: 'three' },
                { type: 'add', oldNo: null, newNo: 2, text: '2' },
                { type: 'add', oldNo: null, newNo: 3, text: '3' },
            ],
        },
    });
    assert.doesNotMatch(file, /[0-9a-f]{40}/);
});

test('a thread of mine anchors on the displayed base, even after HEAD moved', async () => {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\n' });
    write(dir, { 'a.txt': 'one\nTWO\nthree\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const shown = (await api('GET', `/api/sessions/${id}/diff`)).body;
    git(dir, 'commit', '-qam', 'Claude commits');

    const opened = await api('POST', `/api/sessions/${id}/threads`, { author: 'me', base: shown.base, tree: shown.tree, path: 'a.txt', side: 'old', start: 2, end: 2, body: 'Why?' });

    assert.equal(opened.status, 200);
    const { anchor } = opened.body.threads[0];
    assert.deepEqual(anchor.lines, ['two']);
    assert.deepEqual(anchor.hunk.lines.map((line: any) => line.text), ['one', 'two']);
});

test('the diff of a session whose worktree is gone is a 400 naming its path', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    renameSync(dir, `${dir}-gone`);

    const res = await api('GET', `/api/sessions/${id}/diff`).finally(() => renameSync(`${dir}-gone`, dir));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, `No worktree at ${dir}`);
});

test('a thread path must be canonical, relative to the top of the worktree', async () => {
    const dir = repo({ 'd/a.txt': 'a\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;

    for (const path of ['./d/a.txt', 'd//a.txt', 'd/./a.txt', '/d/a.txt']) {
        const refused = await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path, side: 'new', start: 1, end: 1, body: 'Hi' });
        assert.equal(refused.status, 400, path);
    }
});

/** A session on a fresh worktree, with a thread Claude opened on line 1 of a.txt. */
async function sessionWithThread(): Promise<{ dir: string; id: string; path: string }> {
    const dir = repo({ 'a.txt': 'a\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Look here' });
    return { dir, id, path: `/api/sessions/${id}/threads/1` };
}

async function displayedTree(id: string): Promise<string> {
    return (await api('GET', `/api/sessions/${id}/diff`)).body.tree;
}

test('a Pending message sent after a reply of Claude takes its date at the Send and its place after the reply', async () => {
    const { id, path } = await sessionWithThread();
    await api('POST', `${path}/messages`, { author: 'me', body: 'Mine' });
    await api('POST', `${path}/messages`, { author: 'claude', body: 'Meanwhile' });
    const pending = (await api('GET', `/api/sessions/${id}`)).body.threads[0];
    assert.deepEqual(pending.messages.map((m: any) => [m.body, m.date === null]), [['Look here', false], ['Mine', true], ['Meanwhile', false]]);
    const sentAfter = new Date().toISOString();

    const sent = await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });

    assert.equal(sent.status, 200);
    const [thread] = sent.body.threads;
    assert.deepEqual(thread.messages.map((m: any) => [m.author, m.body]), [['claude', 'Look here'], ['claude', 'Meanwhile'], ['me', 'Mine']]);
    assert.ok(thread.messages[2].date >= sentAfter);
    assert.equal(thread.messages[2].review, 1);
    assert.equal(thread.status, 'waiting-for-claude');
});

test('a Send commits the displayed tree under refs/claude-reviews/<session>/1, not the working tree changed since', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'a.txt': 'displayed\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const tree = await displayedTree(id);
    write(dir, { 'a.txt': 'changed after\n' });

    await api('POST', `/api/sessions/${id}/send`, { tree });

    assert.equal(git(dir, 'rev-parse', `refs/claude-reviews/${id}/1^{tree}`).trim(), tree);
    assert.equal(git(dir, 'show', `refs/claude-reviews/${id}/1:a.txt`), 'displayed\n');
});

test('a Send takes its Snapshot without any user identity', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    git(dir, 'config', 'user.name', '');
    git(dir, 'config', 'user.email', '');
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;

    const sent = await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.sends, 1);
});

test('a Send refuses a tree id of the wrong length, or an id that is not a tree, with a clear message', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const blob = git(dir, 'rev-parse', 'HEAD:a.txt').trim();

    const short = await api('POST', `/api/sessions/${id}/send`, { tree: `${blob}0` });
    const notTree = await api('POST', `/api/sessions/${id}/send`, { tree: blob });

    assert.equal(short.status, 400);
    assert.match(short.body.error, /40 or 64 hexadecimal/);
    assert.equal(notTree.status, 400);
    assert.match(notTree.body.error, new RegExp(`${blob} is not a tree`));
});

test('a Send without Pending message creates the next ref and publishes no message', async () => {
    const { dir, id } = await sessionWithThread();
    const before = (await api('GET', `/api/sessions/${id}`)).body.threads;
    await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });

    const sent = await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.sends, 2);
    assert.deepEqual(sent.body.threads, before);
    assert.equal(git(dir, 'for-each-ref', '--format=%(refname)', `refs/claude-reviews/${id}/`), `refs/claude-reviews/${id}/1\nrefs/claude-reviews/${id}/2\n`);
});

test('a Resolved thread no longer waits for Claude, a reply of Claude does not reopen it, a message of mine does at its Send', async () => {
    const { id, path } = await sessionWithThread();
    await api('POST', `${path}/messages`, { author: 'me', body: 'Thanks' });
    await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });

    const resolved = await api('POST', `${path}/resolve`, {});
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.threads[0].status, 'resolved');

    const replied = await api('POST', `${path}/messages`, { author: 'claude', body: 'You are welcome' });
    assert.equal(replied.body.threads[0].status, 'resolved');

    const written = await api('POST', `${path}/messages`, { author: 'me', body: 'One more thing' });
    assert.equal(written.body.threads[0].status, 'resolved', 'Claude cannot read it before the Send');
    const sent = await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });
    assert.equal(sent.body.threads[0].resolved, false);
    assert.equal(sent.body.threads[0].status, 'waiting-for-claude');
});

test('an Approve with a Pending message is refused', async () => {
    const { id, path } = await sessionWithThread();
    await api('POST', `${path}/messages`, { author: 'me', body: 'Not sent yet' });

    const approved = await api('POST', `/api/sessions/${id}/approve`, {});

    assert.equal(approved.status, 409);
    assert.match(approved.body.error, /Pending/);
    assert.equal((await api('GET', `/api/sessions/${id}`)).body.approvedAt, null);
});

test('an Approve archives the session under archive/<id>, deletes its refs, keeps its URL readable, and the worktree opens a new session', async () => {
    const { dir, id } = await sessionWithThread();
    await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });

    const approved = await api('POST', `/api/sessions/${id}/approve`, {});

    assert.equal(approved.status, 200);
    assert.ok(approved.body.approvedAt);
    assert.equal(existsSync(join(data, 'sessions', `${id}.json`)), false);
    assert.ok(JSON.parse(readFileSync(join(data, 'archive', `${id}.json`), 'utf8')).approvedAt);
    assert.equal(git(dir, 'for-each-ref', `refs/claude-reviews/${id}/`), '');
    const read = await api('GET', `/api/sessions/${id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.threads[0].messages[0].body, 'Look here');
    assert.notEqual((await api('POST', '/api/sessions', { worktree: dir })).body.id, id);
});

test('an Approve whose refs cannot be deleted still archives the session', async () => {
    const { dir, id } = await sessionWithThread();
    rmSync(dir, { recursive: true, force: true });

    const approved = await api('POST', `/api/sessions/${id}/approve`, {});

    assert.equal(approved.status, 200);
    assert.equal(existsSync(join(data, 'sessions', `${id}.json`)), false);
    assert.ok(existsSync(join(data, 'archive', `${id}.json`)));
});

test('a session file that cannot be read is a server error, not a missing session', async () => {
    const id = '0123456789abcdef';
    mkdirSync(join(data, 'archive', `${id}.json`), { recursive: true });

    const read = await api('GET', `/api/sessions/${id}`);

    assert.equal(read.status, 500);
    assert.match(read.body.error, /EISDIR/);
});

test('a body over 1 MB is refused with 413', async () => {
    const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktree: `/${'x'.repeat(1024 * 1024)}` }),
    });

    assert.equal(res.status, 413);
});

test('an approved session refuses the reply_to_thread and open_thread of Claude with "session approuvée", and writes nothing', async () => {
    const { id, path } = await sessionWithThread();
    await api('POST', `/api/sessions/${id}/approve`, {});
    const archived = readFileSync(join(data, 'archive', `${id}.json`), 'utf8');

    const replied = await api('POST', `${path}/messages`, { author: 'claude', body: 'Late reply' });
    const opened = await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Late thread' });

    for (const refused of [replied, opened]) {
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error, 'session approuvée');
    }
    assert.equal(readFileSync(join(data, 'archive', `${id}.json`), 'utf8'), archived);
    assert.equal(existsSync(join(data, 'sessions', `${id}.json`)), false);
});

test('on a worktree without open session, the open_thread of Claude opens one, with a thread Awaiting you without Send', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'b.txt': 'not displayed anywhere yet\n' });

    // The mod's open_thread: the open session of the worktree, created if needed, then the thread.
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const opened = await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'b.txt', side: 'new', start: 1, end: 1, body: 'New file' });

    assert.equal(opened.status, 200);
    assert.equal(opened.body.sends, 0);
    assert.equal(opened.body.threads[0].status, 'awaiting-you');
    assert.deepEqual(opened.body.threads[0].anchor.lines, ['not displayed anywhere yet']);
    assert.ok(existsSync(join(data, 'sessions', `${id}.json`)));
});

test('a reply of Claude in a thread whose only message is a Pending one of mine is refused, so it cannot pass before mine at the Send', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'a.txt': 'b\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const shown = (await api('GET', `/api/sessions/${id}/diff`)).body;
    await api('POST', `/api/sessions/${id}/threads`, { author: 'me', base: shown.base, tree: shown.tree, path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Why?' });

    const refused = await api('POST', `/api/sessions/${id}/threads/1/messages`, { author: 'claude', body: 'Too early' });

    assert.equal(refused.status, 409);
    assert.deepEqual((await api('GET', `/api/sessions/${id}`)).body.threads[0].messages.map((m: any) => m.body), ['Why?']);
});

test('GET /api/sessions?worktree= finds the open session of a worktree without creating one', async () => {
    const dir = repo({ 'a.txt': 'a\n', 'sub/b.txt': 'b\n' });
    const files = () => readdirSync(join(data, 'sessions')).length;
    const before = files();

    assert.equal((await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}`)).status, 404);
    assert.equal(files(), before);

    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const found = await api('GET', `/api/sessions?worktree=${encodeURIComponent(join(dir, 'sub'))}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.id, id);

    await api('POST', `/api/sessions/${id}/approve`, {});
    assert.equal((await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}`)).status, 404);
});

test('a session file gone between the listing and its reading, approved meanwhile, does not hide the session of another worktree', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    // A link to nothing is listed, then cannot be read: what an Approve does between the two.
    const gone = join(data, 'sessions', '0000000000000000.json');
    symlinkSync(join(data, 'nowhere.json'), gone);
    try {
        const found = await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}`);

        assert.equal(found.status, 200);
        assert.equal(found.body.id, id);
    } finally {
        unlinkSync(gone);
    }
});

function commit(dir: string, files: Record<string, string>): void {
    write(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', Object.keys(files).join(' '));
}

/** A worktree on branch mine, started from origin/HEAD (branch upstream), which then got a commit of its own; without any remote. */
function forkedFromOrigin(): string {
    const dir = repo({ 'a.txt': 'a\n' });
    git(dir, 'checkout', '-qb', 'upstream');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(dir, 'checkout', '-qb', 'mine');
    commit(dir, { 'mine.txt': 'mine\n' });
    git(dir, 'checkout', '-q', 'upstream');
    commit(dir, { 'theirs.txt': 'theirs\n' });
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'mine');
    return dir;
}

test('the diff against origin/HEAD starts from the merge-base: a commit added on origin/HEAD since does not show', async () => {
    const dir = forkedFromOrigin();
    write(dir, { 'uncommitted.txt': 'u\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;

    const chosen = await api('POST', `/api/sessions/${id}/base`, { base: 'origin/HEAD' });
    const shown = await api('GET', `/api/sessions/${id}/diff`);

    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.base, 'origin/HEAD');
    assert.equal(shown.body.ref, 'origin/HEAD');
    assert.deepEqual(shown.body.files.map((file: any) => file.path), ['mine.txt', 'uncommitted.txt']);
});

test('the bases are Uncommitted changes, Since my last review, origin/HEAD, then the other branches from the nearest merge-base to the farthest', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    git(dir, 'branch', '-m', 'far');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(dir, 'checkout', '-qb', 'mine');
    commit(dir, { 'b.txt': 'b\n' });
    git(dir, 'branch', 'mid');
    commit(dir, { 'c.txt': 'c\n' });
    git(dir, 'branch', 'near');
    commit(dir, { 'd.txt': 'd\n' });
    for (const branch of ['far', 'mid']) {
        git(dir, 'checkout', '-q', branch);
        commit(dir, { [`${branch}.txt`]: `${branch}\n` });
    }
    git(dir, 'checkout', '-q', 'mine');
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;

    const listed = await api('GET', `/api/sessions/${id}/bases`);

    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [
        { ref: 'HEAD', name: 'Uncommitted changes' },
        { ref: 'last-review', name: 'Since my last review', disabled: true },
        { ref: 'origin/HEAD', name: 'origin/HEAD' },
        { ref: 'refs/heads/near', name: 'near' },
        { ref: 'refs/heads/mid', name: 'mid' },
        { ref: 'refs/heads/far', name: 'far' },
    ]);
});

test('the diff Since my last review shows only what changed after the Send', async () => {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(dir, { 'a.txt': 'sent\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    await api('POST', `/api/sessions/${id}/send`, { tree: await displayedTree(id) });
    write(dir, { 'b.txt': 'after the Send\n' });

    const chosen = await api('POST', `/api/sessions/${id}/base`, { base: 'last-review' });
    const shown = await api('GET', `/api/sessions/${id}/diff`);

    assert.equal(chosen.status, 200);
    assert.equal(shown.body.ref, 'last-review');
    assert.deepEqual(shown.body.files.map((file: any) => file.path), ['b.txt']);
    assert.deepEqual(shown.body.files[0].hunks[0].lines.map((line: any) => [line.type, line.text]), [['del', 'b'], ['add', 'after the Send']]);
});

test('a diff asked again for the same base and tree does not run git diff again', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    // Content of its own: another test of the same second could have diffed the same pair already.
    write(dir, { 'a.txt': `${dir}\n` });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    const { log, restore } = shim(dir);
    const diffs = () => readFileSync(log, 'utf8').split('\n').filter(args => / diff --no-color /.test(args)).length;
    try {
        const first = await api('GET', `/api/sessions/${id}/diff`);
        const second = await api('GET', `/api/sessions/${id}/diff`);

        assert.deepEqual(second.body, first.body);
        assert.equal(diffs(), 1);
        write(dir, { 'a.txt': `${dir} changed\n` });
        await api('GET', `/api/sessions/${id}/diff`);
        assert.equal(diffs(), 2);
    } finally {
        restore();
    }
});

test('Since my last review cannot be chosen before the first Send, nor a base the worktree does not have', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;

    for (const base of ['last-review', 'origin/HEAD', 'refs/heads/nowhere', 'HEAD~1']) {
        const refused = await api('POST', `/api/sessions/${id}/base`, { base });
        assert.equal(refused.status, 400, base);
    }
    assert.equal((await api('GET', `/api/sessions/${id}`)).body.base, 'HEAD');
});

test('the lines around a thread out of the diff are numbered on the other side past hunks that only delete or only add lines', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    const dir = repo({ 'a.txt': `${lines.join('\n')}\n` });
    // Without context lines, a hunk numbers lines of one side only.
    git(dir, 'config', 'diff.context', '0');
    write(dir, { 'a.txt': `${[...lines.slice(0, 4), ...lines.slice(6, 10), 'x', 'y', 'z', ...lines.slice(10)].join('\n')}\n` });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'a.txt', side: 'new', start: 18, end: 18, body: 'Here' });
    const { base, tree } = (await api('GET', `/api/sessions/${id}/diff`)).body;

    const placed = await api('GET', `/api/sessions/${id}?base=${base}&tree=${tree}`);

    assert.deepEqual(placed.body.threads[0].at.context.map((line: any) => [line.oldNo, line.newNo, line.text]), [
        [14, 15, 'l14'], [15, 16, 'l15'], [16, 17, 'l16'], [17, 18, 'l17'], [18, 19, 'l18'], [19, 20, 'l19'], [20, 21, 'l20'],
    ]);
});

test('a thread on a file gone is Outdated, but a git that fails to read a file is a server error', async () => {
    const dir = repo({ 'a.txt': 'one\ntwo\n', 'b.txt': 'three\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Here' });
    await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'b.txt', side: 'new', start: 1, end: 1, body: 'There' });
    unlinkSync(join(dir, 'b.txt'));
    const { base, tree } = (await api('GET', `/api/sessions/${id}/diff`)).body;
    assert.deepEqual((await api('GET', `/api/sessions/${id}?base=${base}&tree=${tree}`)).body.threads.map((thread: any) => thread.at), [
        { start: 1, end: 1, context: [{ type: 'context', oldNo: 1, newNo: 1, text: 'one' }, { type: 'context', oldNo: 2, newNo: 2, text: 'two' }] },
        null,
    ]);
    // Any read of an object's content fails, as with too many open files.
    const { restore } = shim(dir, 'case "$1 $2" in "cat-file -t") ;; cat-file*) echo "error: too many open files" >&2; exit 128;; esac');
    try {
        const placed = await api('GET', `/api/sessions/${id}?base=${base}&tree=${tree}`);

        assert.equal(placed.status, 500);
    } finally {
        restore();
    }
});

test('?reanchor places the threads not Resolved on HEAD and the working tree, without a diff, reading each file once', async () => {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\n' });
    const { id } = (await api('POST', '/api/sessions', { worktree: dir })).body;
    for (const line of [1, 2, 3]) await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'a.txt', side: 'new', start: line, end: line, body: 'Here' });
    await api('POST', `/api/sessions/${id}/threads/3/resolve`, {});
    // A working tree never diffed yet, so no cached diff hides one.
    write(dir, { 'a.txt': 'zero\none\ntwo\nthree\n' });
    const { log, restore } = shim(dir);
    try {
        const listed = await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}&reanchor`);

        assert.deepEqual(listed.body.threads.map((thread: any) => thread.at), [{ start: 2, end: 2 }, { start: 3, end: 3 }, undefined]);
        const calls = readFileSync(log, 'utf8').split('\n');
        assert.deepEqual(calls.filter(args => / diff /.test(args)), []);
        assert.equal(calls.filter(args => args.startsWith('cat-file') && !args.startsWith('cat-file -t')).length, 1);
    } finally {
        restore();
    }
});

test('a write refuses a malformed base or tree to place threads on before it is recorded, and answers its success once recorded', async () => {
    const { id, path } = await sessionWithThread();
    const tree = await displayedTree(id);

    const refused = await api('POST', `${path}/messages?base=HEAD&tree=${tree}`, { author: 'me', body: 'Twice?' });
    assert.equal(refused.status, 400);
    assert.equal((await api('GET', `/api/sessions/${id}`)).body.threads[0].messages.length, 1);

    // Well formed, but no object of the worktree: the threads cannot be placed, the Send is recorded all the same.
    const sent = await api('POST', `/api/sessions/${id}/send?base=${'0'.repeat(40)}&tree=${tree}`, { tree });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.sends, 1);
});
