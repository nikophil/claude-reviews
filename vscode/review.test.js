// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('./review.js');

/** A thread of `path` on `side`, its messages `[author, date]`, placed at `at`, null when Outdated. */
function thread(id, { path = 'a.txt', side = 'new', status = 'waiting-for-claude', resolved = false, at = { start: 2, end: 2 }, messages = [['me', '2026-11-14T10:00:00.000Z']] } = {}) {
    return {
        id, status, resolved, at,
        anchor: { path, side, start: 2, end: 2, lines: ['two'], hunk: null },
        messages: messages.map(([author, date], i) => ({ author, body: `m${i}`, date, ...(author === 'me' && date ? { review: 1 } : {}) })),
    };
}

test('a thread shows Pending before any Send, Waiting for Claude when my message is the last sent, nothing when Claude spoke last', () => {
    assert.equal(review.status(thread(1, { status: null })), 'Pending');
    assert.equal(review.status(thread(1)), 'Waiting for Claude');
    assert.equal(review.status(thread(1, { status: 'open' })), '');
    assert.equal(review.status(thread(1, { status: 'resolved' })), 'Resolved');
});

test('the lines of a thread are those of its place, else of its Anchor, signed by their side', () => {
    assert.equal(review.lines(thread(1, { at: { start: 4, end: 4 } })), 'Line +4');
    assert.equal(review.lines(thread(1, { side: 'old', at: { start: 4, end: 6 } })), 'Lines -4 to -6');
    assert.equal(review.lines(thread(1, { at: null })), 'Line +2');
    assert.equal(review.lines(thread(1, { at: { start: 0, end: 0 } })), 'File');
});

test('the label of a thread names it, its lines, its status, the old code and Outdated', () => {
    const session = { claudeSession: true };
    assert.equal(review.label(thread(12, { side: 'old', at: null }), session), '#12 · Line -2 · Waiting for Claude · old code · Outdated');
    assert.equal(review.label(thread(3, { status: 'open' }), session), '#3 · Line +2');
    assert.equal(review.label(thread(3), { claudeSession: false }), '#3 · Line +2 · No Claude session');
    assert.equal(review.label({ ...thread(3, { status: 'open' }), readonly: true }, session), '#3 · Line +2 · Answer without changing code');
});

test('the counts of a file are its threads waiting for Claude, the Pending messages a Send would publish, and its Resolved threads', () => {
    const session = { threads: [
        thread(1, { messages: [['me', '2026-11-14T10:00:00.000Z'], ['me', null]] }),
        thread(2, { status: 'resolved', resolved: true, messages: [['me', null]] }),
        thread(3, { path: 'b.txt', status: null, messages: [['me', null]] }),
    ] };
    assert.deepEqual(review.counts(session, 'a.txt'), { waiting: 1, pending: 1, resolved: 1 });
    assert.deepEqual(review.counts(session), { waiting: 1, pending: 2, resolved: 1 });
});

test('a session without claudeSession, from an older server, counts as read by Claude', () => {
    assert.equal(review.claude({}), true);
    assert.equal(review.claude({ claudeSession: false }), false);
});

test('the command that starts a Claude session quotes a worktree with spaces or quotes', () => {
    assert.equal(review.startClaude({ worktree: '/home/me/src/app' }), 'cd /home/me/src/app && claude');
    assert.equal(review.startClaude({ worktree: "/home/me/it's here" }), "cd '/home/me/it'\\''s here' && claude");
});

test('the tree lists the files of the diff, then those only unresolved threads name, each directory once, at its first file', () => {
    const files = [{ path: 'src/a.ts', status: 'modified' }, { path: 'README.md', status: 'added' }, { path: 'src/b.ts', status: 'deleted' }];
    const threads = [thread(1, { path: 'lib/c.ts' }), thread(2, { path: 'lib/d.ts', resolved: true, status: 'resolved' }), thread(3, { path: 'src/a.ts' })];
    assert.deepEqual(review.tree(files, threads), [
        { dir: 'src', files: [{ path: 'src/a.ts', status: 'modified' }, { path: 'src/b.ts', status: 'deleted' }] },
        { file: { path: 'README.md', status: 'added' } },
        { dir: 'lib', files: [{ path: 'lib/c.ts', status: 'unchanged' }] },
    ]);
});

test('the threads of a file in the tree leave out the Resolved ones', () => {
    const threads = [thread(1), thread(2, { resolved: true, status: 'resolved' }), thread(3, { path: 'b.txt' })];
    assert.deepEqual(review.threadsOf(threads, 'a.txt').map(t => t.id), [1]);
});

test('a file opens at its first thread on the new side, else at its first added line, else at its top', () => {
    const file = { path: 'a.txt', hunks: [{ lines: [{ type: 'context', newNo: 3 }, { type: 'add', newNo: 4 }] }] };
    assert.equal(review.firstLine(file, [thread(1, { side: 'old', at: { start: 9, end: 9 } }), thread(2, { at: { start: 7, end: 8 } })]), 7);
    assert.equal(review.firstLine(file, []), 4);
    assert.equal(review.firstLine({ path: 'a.txt', hunks: [] }, [thread(1, { at: { start: 0, end: 0 } })]), 1);
});

test('the messages the last Send published are those it numbered', () => {
    const session = { sends: 2, threads: [{ messages: [{ author: 'me', review: 1 }, { author: 'claude' }, { author: 'me', review: 2 }, { author: 'me', review: 2 }] }] };
    assert.equal(review.sent(session), 2);
});

test('the threads waiting for Claude count across the session', () => {
    assert.equal(review.waiting({ threads: [thread(1), thread(2, { status: 'open' }), thread(3)] }), 2);
});

test('Claude replied in every thread once Claude wrote and no thread waits any more, not when I resolve the last one', () => {
    const waitingOne = { id: 's', threads: [thread(1)] };
    const answered = { id: 's', threads: [{ ...thread(1, { status: 'open', messages: [['me', '2026-11-14T10:00:00.000Z'], ['claude', '2026-11-14T10:01:00.000Z']] }) }] };
    const resolved = { id: 's', threads: [thread(1, { status: 'resolved', resolved: true })] };
    assert.equal(review.replied(waitingOne, answered), true);
    assert.equal(review.replied(waitingOne, resolved), false);
    assert.equal(review.replied(waitingOne, { ...answered, id: 'other' }), false);
    assert.equal(review.replied(null, answered), false);
});

test('a file is Viewed when the session placed on the code shown keeps it in viewed', () => {
    assert.equal(review.viewed({ viewed: { 'a.txt': 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' } }, 'a.txt'), true);
    assert.equal(review.viewed({ viewed: {} }, 'a.txt'), false);
    assert.equal(review.viewed({}, 'a.txt'), false);
});

test('the bases come with a separator before each group, the one greyed until a Send says so, the chosen one marked', () => {
    const bases = [
        { ref: 'HEAD', name: 'Uncommitted changes' },
        { ref: 'last-review', name: 'Since my last review', disabled: true },
        { ref: 'refs/heads/a', name: 'a', group: 'Local branches' },
        { ref: 'refs/heads/b', name: 'b', group: 'Local branches' },
        { ref: 'refs/remotes/origin/c', name: 'origin/c', group: 'Remote branches' },
    ];
    assert.deepEqual(review.baseItems(bases, 'refs/heads/a'), [
        { label: 'Uncommitted changes', ref: 'HEAD', disabled: false, picked: false },
        { label: 'Since my last review', description: 'after a Send', ref: 'last-review', disabled: true, picked: false },
        { separator: 'Local branches' },
        { label: 'a', description: 'current', ref: 'refs/heads/a', disabled: false, picked: true },
        { label: 'b', ref: 'refs/heads/b', disabled: false, picked: false },
        { separator: 'Remote branches' },
        { label: 'origin/c', ref: 'refs/remotes/origin/c', disabled: false, picked: false },
    ]);
});

test('the code of an Outdated thread is its diff excerpt as unified diff, else the lines of its Anchor', () => {
    const hunk = { header: '@@ -1,2 +1,2 @@', lines: [{ type: 'context', text: 'one' }, { type: 'del', text: 'two' }, { type: 'add', text: '2' }, { type: 'note', text: 'No newline at end of file' }] };
    assert.equal(review.outdatedText({ hunk, lines: ['2'] }), '@@ -1,2 +1,2 @@\n one\n-two\n+2\n\\ No newline at end of file');
    assert.equal(review.outdatedText({ hunk: null, lines: ['a', 'b'] }), 'a\nb');
});

test('a message keeps its markdown, its images replaced by their text', () => {
    assert.equal(review.noImages('See ![the graph](https://example.com/x.png) and [a link](https://example.com).'), 'See the graph and [a link](https://example.com).');
});

test('the listeners of a port are the sockets listening on it, IPv4 or IPv6, with their uid', () => {
    // /proc/net/tcp then /proc/net/tcp6: a listener of uid 1000 on 127.0.0.1:0xA609, a connection of uid 1001 from that port, a listener of 1001 on 0.0.0.0:7778, one of 1002 on [::ffff:127.0.0.1]:0xA609.
    const proc = [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 0100007F:A609 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 84322 1 0000000000000000 100 0 0 10 0',
        '   1: 0100007F:A609 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1001        0 0 1 0000000000000000 20 4 30 10 -1',
        '   2: 00000000:1E62 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 7964741 1 0000000000000000 100 0 0 10 0',
        '   0: 0000000000000000FFFF00000100007F:A609 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 10494914 1 0000000000000000 100 0 0 10 0',
    ].join('\n');
    assert.deepEqual(review.listeners(proc, 0xA609), [1000, 1002], 'a connection from the port is no listener');
    assert.deepEqual(review.listeners(proc, 7778), [1001], 'any address, 0.0.0.0 included');
    assert.deepEqual(review.listeners(proc, 1234), []);
});

test('Next Thread and Previous Thread go through the unresolved threads in the order of the view, around at the ends', () => {
    const files = [{ path: 'src/b.ts', status: 'modified' }, { path: 'a.txt', status: 'modified' }, { path: 'src/c.ts', status: 'modified' }];
    const threads = [thread(1, { path: 'a.txt' }), thread(2, { path: 'src/c.ts' }), thread(3, { path: 'src/b.ts' }), thread(4, { path: 'a.txt', resolved: true }), thread(5, { path: 'src/b.ts', resolved: true })];
    assert.equal(review.step(files, threads, undefined, true), 3, 'the first, without a current thread');
    assert.equal(review.step(files, threads, undefined, false), 1, 'the last, backward');
    assert.equal(review.step(files, threads, 3, true), 2, 'src/c.ts under src, with src/b.ts');
    assert.equal(review.step(files, threads, 1, true), 3, 'around at the end');
    assert.equal(review.step(files, threads, 3, false), 1, 'around at the start');
    assert.equal(review.step(files, threads, 5, true), 2, 'from a thread just Resolved, the next one after it');
    assert.equal(review.step(files, threads, 5, false), 3, 'from a thread just Resolved, the one before it');
    assert.equal(review.step(files, [], undefined, true), undefined);
});
