import assert from 'node:assert/strict';
import { existsSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { diff, writeTree } from './diff.ts';
import { git, removeRepos, repo, write } from './fixture.ts';

after(removeRepos);

test('a modified tracked file shows its added, deleted and context lines with numbers on both sides', async () => {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\n' });
    write(dir, { 'a.txt': 'one\n2\nthree\nfour\n' });

    const { files } = await diff(dir);

    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'a.txt');
    assert.equal(files[0].status, 'modified');
    assert.deepEqual(files[0].hunks[0].lines, [
        { type: 'context', oldNo: 1, newNo: 1, text: 'one' },
        { type: 'del', oldNo: 2, newNo: null, text: 'two' },
        { type: 'add', oldNo: null, newNo: 2, text: '2' },
        { type: 'context', oldNo: 3, newNo: 3, text: 'three' },
        { type: 'add', oldNo: null, newNo: 4, text: 'four' },
    ]);
});

test('an untracked file shows as added and an ignored file does not show', async () => {
    const dir = repo({ '.gitignore': 'ignored.log\n' });
    write(dir, { 'new file.txt': 'hello\n', 'ignored.log': 'noise\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => [f.path, f.status]), [['new file.txt', 'added']]);
    assert.deepEqual(files[0].hunks[0].lines, [{ type: 'add', oldNo: null, newNo: 1, text: 'hello' }]);
});

test('a tracked file removed from the working tree shows as deleted', async () => {
    const dir = repo({ 'gone.txt': 'bye\n' });
    rmSync(join(dir, 'gone.txt'));

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => [f.path, f.status, f.deletions]), [['gone.txt', 'deleted', 1]]);
});

test('computing the diff leaves the worktree index untouched', async () => {
    const dir = repo({ 'staged.txt': 'a\n', 'unstaged.txt': 'a\n' });
    write(dir, { 'staged.txt': 'b\n', 'unstaged.txt': 'b\n', 'untracked.txt': 'c\n' });
    git(dir, 'add', 'staged.txt');
    const before = git(dir, 'status', '--porcelain');

    await diff(dir);

    assert.equal(git(dir, 'status', '--porcelain'), before);
    assert.match(before, /^M {2}staged\.txt$/m);
    assert.match(before, /^ M unstaged\.txt$/m);
});

test('an unchanged working tree writes the same tree id, a modified one a different id', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'b.txt': 'b\n' });

    const first = await writeTree(dir);
    assert.equal(await writeTree(dir), first);

    write(dir, { 'b.txt': 'changed\n' });
    assert.notEqual(await writeTree(dir), first);
});

test('a binary shows as not shown, a lockfile and a diff over 1 MB arrive collapsed', async () => {
    const dir = repo({ 'package-lock.json': '{}\n', 'small.txt': 'a\n' });
    write(dir, {
        'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
        'package-lock.json': '{ "lockfileVersion": 3 }\n',
        'big.txt': `${'x'.repeat(99)}\n`.repeat(11_000),
    });

    const byPath = Object.fromEntries((await diff(dir)).files.map(f => [f.path, f]));

    assert.deepEqual(Object.keys(byPath).sort(), ['big.txt', 'image.png', 'package-lock.json']);
    assert.equal(byPath['image.png'].binary, true);
    assert.equal(byPath['image.png'].collapsed, false);
    assert.equal(byPath['package-lock.json'].collapsed, true);
    assert.equal(byPath['big.txt'].collapsed, true);
});

test('paths git quotes (quote, backslash, tab, control character) come back verbatim', async () => {
    const dir = repo({ 'keep.txt': 'a\n' });
    const names = ['say "hi".txt', 'back\\slash.txt', 'tab\there.txt', 'bell\x07.txt', 'café.txt'];
    write(dir, Object.fromEntries(names.map(name => [name, 'x\n'])));

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => f.path).sort(), [...names].sort());
});

test('an empty context line keeps the numbering when diff.suppressBlankEmpty is set', async () => {
    const dir = repo({ 'a.txt': 'one\n\ntwo\n' });
    git(dir, 'config', 'diff.suppressBlankEmpty', 'true');
    write(dir, { 'a.txt': 'one\n\n2\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files[0].hunks[0].lines, [
        { type: 'context', oldNo: 1, newNo: 1, text: 'one' },
        { type: 'context', oldNo: 2, newNo: 2, text: '' },
        { type: 'del', oldNo: 3, newNo: null, text: 'two' },
        { type: 'add', oldNo: null, newNo: 3, text: '2' },
    ]);
});

test('the diff shows the file content, not its textconv', async () => {
    const dir = repo({ '.gitattributes': '*.txt diff=shout\n', 'a.txt': 'a\n' });
    git(dir, 'config', 'diff.shout.textconv', 'sed s/^/SHOUT/');
    write(dir, { 'a.txt': 'b\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files[0].hunks[0].lines.map(l => l.text), ['a', 'b']);
});

test('files flagged assume-unchanged or skip-worktree still show their changes, and keep their flags', async () => {
    const dir = repo({ 'assumed.txt': 'a\n', 'skipped.txt': 'a\n' });
    git(dir, 'update-index', '--assume-unchanged', 'assumed.txt');
    git(dir, 'update-index', '--skip-worktree', 'skipped.txt');
    write(dir, { 'assumed.txt': 'b\n', 'skipped.txt': 'b\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => f.path), ['assumed.txt', 'skipped.txt']);
    assert.equal(git(dir, 'ls-files', '-v'), 'h assumed.txt\nS skipped.txt\n');
});

test('a skip-worktree file missing from the working tree, as in a sparse checkout, does not show as deleted', async () => {
    const dir = repo({ 'in.txt': 'a\n', 'out.txt': 'a\n' });
    git(dir, 'update-index', '--skip-worktree', 'out.txt');
    rmSync(join(dir, 'out.txt'));
    write(dir, { 'in.txt': 'b\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => f.path), ['in.txt']);
});

test('a repository without any commit diffs against the empty tree', async () => {
    const dir = repo({});
    write(dir, { 'first.txt': 'hello\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => [f.path, f.status]), [['first.txt', 'added']]);
});

test('the 1 MB threshold counts bytes, not characters', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'accents.txt': `${'é'.repeat(99)}\n`.repeat(6_000) });

    const { files } = await diff(dir);

    assert.equal(files.find(f => f.path === 'accents.txt')!.collapsed, true);
});

test('a file turned into a symlink shows as deleted then added, without shifting the next files', async () => {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    rmSync(join(dir, 'a.txt'));
    symlinkSync('b.txt', join(dir, 'a.txt'));
    write(dir, { 'b.txt': 'changed\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => [f.path, f.status]), [['a.txt', 'deleted'], ['a.txt', 'added'], ['b.txt', 'modified']]);
});

test('an assume-unchanged file removed from disk shows as deleted', async () => {
    const dir = repo({ 'x.txt': 'x\n' });
    git(dir, 'update-index', '--assume-unchanged', 'x.txt');
    rmSync(join(dir, 'x.txt'));

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => [f.path, f.status]), [['x.txt', 'deleted']]);
});

test('an untracked CRLF file does not break the diff under core.safecrlf', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    git(dir, 'config', 'core.autocrlf', 'input');
    git(dir, 'config', 'core.safecrlf', 'true');
    write(dir, { 'dos.txt': 'one\r\ntwo\r\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => f.path), ['dos.txt']);
});

test('an untracked nested repository without commit does not break the diff', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    git(dir, 'init', '-q', 'nested');
    write(dir, { 'nested/x.txt': 'x\n', 'b.txt': 'b\n' });

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => f.path), ['b.txt']);
});

test('GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE inherited from the environment do not redirect git', async () => {
    const other = repo({ 'other.txt': 'o\n' });
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index') });
    try {
        const dir = repo({ 'a.txt': 'a\n' });
        write(dir, { 'a.txt': 'b\n' });

        const { files } = await diff(dir);

        assert.deepEqual(files.map(f => f.path), ['a.txt']);
    } finally {
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[name];
        Object.assign(process.env, saved);
    }
});

test('a same-size change that keeps the file mtime still shows, as git checks racily clean entries', async () => {
    const dir = repo({ 'a.txt': 'one\n' });
    // Leaves git only the whole-second mtime and the size to notice the change.
    git(dir, 'config', 'core.checkStat', 'minimal');
    git(dir, 'config', 'core.trustctime', 'false');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(dir, 'a.txt'), past, past);
    git(dir, 'update-index', '--refresh');
    write(dir, { 'a.txt': 'two\n' });
    utimesSync(join(dir, 'a.txt'), past, past);
    // An index as old as the entry: git rechecks the entry's content instead of trusting its stat.
    utimesSync(join(dir, '.git', 'index'), past, past);

    const { files } = await diff(dir);

    assert.deepEqual(files.map(f => f.path), ['a.txt']);
});

test('a missing newline at end of file shows as a note line', async () => {
    const dir = repo({ 'a.txt': 'a' });
    write(dir, { 'a.txt': 'b' });

    const { files } = await diff(dir);

    assert.deepEqual(files[0].hunks[0].lines, [
        { type: 'del', oldNo: 1, newNo: null, text: 'a' },
        { type: 'note', oldNo: null, newNo: null, text: 'No newline at end of file' },
        { type: 'add', oldNo: null, newNo: 1, text: 'b' },
        { type: 'note', oldNo: null, newNo: null, text: 'No newline at end of file' },
    ]);
    assert.equal(files[0].additions, 1);
    assert.equal(files[0].deletions, 1);
});

test('removeRepos deletes the fixture repositories', () => {
    const dir = repo({});

    removeRepos();

    assert.equal(existsSync(dir), false);
});
