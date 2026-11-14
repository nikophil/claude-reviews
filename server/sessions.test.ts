import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, watch } from 'node:fs';
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
