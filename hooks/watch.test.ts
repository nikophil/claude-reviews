import assert from 'node:assert/strict';
import { test } from 'node:test';
import { due, forked, forkEnded, forking, forks, idle, listeners, look, notified, resumed, sending, start, status, submitted, touched, turnEnded, turnStarted, type Watch } from './watch.ts';

/** What the glue does once the decision says a prompt is due: submit it, then learn whether it entered. */
function submit(watch: Watch, dropped = false): Watch {
    assert.ok(due(watch), 'a prompt is due');
    return submitted(sending(watch), dropped);
}

test('a Send relaunches once at the end of a turn that leaves threads waiting, never at the end of the relaunch, and Send n+1 allows another', () => {
    let watch = look(start, { id: 's', sends: 0, waiting: 0 });
    watch = look(watch, { id: 's', sends: 1, waiting: 2 });
    watch = submit(watch);

    watch = turnEnded(watch, { id: 's', sends: 1, waiting: 1 });
    assert.equal(watch.owed, 'relaunch');
    watch = submit(watch);

    watch = turnEnded(watch, { id: 's', sends: 1, waiting: 1 });
    assert.equal(due(watch), false, 'the relaunch of Send 1 is spent');

    watch = turnEnded(watch, { id: 's', sends: 2, waiting: 1 });
    watch = submit(watch);
    watch = turnEnded(watch, { id: 's', sends: 2, waiting: 1 });
    assert.equal(watch.owed, 'relaunch', 'Send 2 allows its own relaunch');
});

test('a dropped relaunch is retried at the next prompt or turn start, and does not count as the relaunch of the Send', () => {
    let watch = look(start, { id: 's', sends: 1, waiting: 0 });
    watch = turnEnded(watch, { id: 's', sends: 1, waiting: 1 });

    watch = submit(watch, true);
    assert.equal(due(watch), false, 'no retry at every poll');
    watch = look(watch, { id: 's', sends: 1, waiting: 1 });
    assert.equal(due(watch), false);

    watch = resumed(watch);
    assert.equal(watch.owed, 'relaunch');
    watch = submit(watch);
    assert.equal(watch.sessions.s.relaunched, 1, 'the retry that entered is the relaunch');
    watch = turnEnded(watch, { id: 's', sends: 1, waiting: 1 });
    assert.equal(due(watch), false);
});

test('a Send without waiting thread does not wake Claude, one with waiting threads does', () => {
    const watch = look(start, { id: 's', sends: 0, waiting: 0 });

    assert.equal(due(look(watch, { id: 's', sends: 1, waiting: 0 })), false);
    assert.equal(look(watch, { id: 's', sends: 1, waiting: 3 }).owed, 'wake');
});

test('Sends made before the mod first looked wake nobody, but a session opened later wakes on its first Send', () => {
    assert.equal(due(look(start, { id: 's', sends: 4, waiting: 2 })), false);

    const later = look(look(start, null), { id: 't', sends: 1, waiting: 1 });
    assert.equal(later.owed, 'wake');
});

test('a session gone, approved, stops any wake or relaunch still owed', () => {
    let watch = look(start, { id: 's', sends: 0, waiting: 0 });
    watch = submit(look(watch, { id: 's', sends: 1, waiting: 1 }), true);

    watch = look(watch, null);

    assert.equal(due(resumed(watch)), false);
    assert.equal(due(turnEnded(watch, null)), false);
});

test('a session seen again after a look without it keeps its Sends and its relaunch', () => {
    let watch = look(start, { id: 's', sends: 0, waiting: 0 });
    watch = submit(look(watch, { id: 's', sends: 1, waiting: 1 }));
    watch = submit(turnEnded(watch, { id: 's', sends: 1, waiting: 1 }));

    watch = look(watch, null);
    assert.equal(due(look(watch, { id: 's', sends: 1, waiting: 1 })), false, 'no second wake for Send 1');
    assert.equal(due(turnEnded(watch, { id: 's', sends: 1, waiting: 1 })), false, 'no second relaunch for Send 1');
});

test('a late look that read an older Send makes nothing due again', () => {
    let watch = look(start, { id: 's', sends: 0, waiting: 0 });
    watch = submit(look(watch, { id: 's', sends: 2, waiting: 1 }));
    watch = submit(turnEnded(watch, { id: 's', sends: 2, waiting: 1 }));

    watch = look(watch, { id: 's', sends: 1, waiting: 1 });

    assert.equal(due(look(watch, { id: 's', sends: 2, waiting: 1 })), false, 'no second wake for Send 2');
    assert.equal(due(turnEnded(watch, { id: 's', sends: 2, waiting: 1 })), false, 'no second relaunch for Send 2');
});

test('a relaunch dropped, then made needless by threads resolved in the UI, leaves no notification for an unrelated turn', () => {
    let watch = look(start, { id: 's', sends: 0, waiting: 0 });
    watch = look(watch, { id: 's', sends: 1, waiting: 2 });
    watch = submit(watch);
    watch = turnEnded(watch, { id: 's', sends: 1, waiting: 1 });
    assert.equal(notified(watch).session, null, 'the relaunch is owed');
    watch = notified(watch).watch;
    watch = submit(watch, true);

    watch = look(watch, { id: 's', sends: 1, waiting: 0 });
    watch = turnEnded(watch, { id: 's', sends: 1, waiting: 0 });

    assert.equal(notified(watch).session, null);
});

test('the status line counts the threads waiting for Claude, adds a wake held by a drop, and is undefined when none waits', () => {
    let watch = look(start, { id: 's', sends: 0, waiting: 0 });
    assert.equal(status(watch), undefined);
    assert.equal(status(look(start, null)), undefined);
    assert.equal(status(look(watch, { id: 's', sends: 0, waiting: 1 })), 'claude-reviews · 1 thread waiting for Claude');

    watch = look(watch, { id: 's', sends: 1, waiting: 2 });
    assert.equal(status(watch), 'claude-reviews · 2 threads waiting for Claude');
    watch = submit(watch, true);
    assert.equal(status(watch), 'claude-reviews · 2 threads waiting for Claude · wake held until the next prompt');
    assert.equal(status(look(watch, { id: 's', sends: 1, waiting: 0 })), undefined, 'nothing waiting, nothing held');
    assert.equal(status(submit(resumed(watch))), 'claude-reviews · 2 threads waiting for Claude');
});

/** What the glue does once the decision says a fork is due: spawn it, then learn its agent, or that it was denied. */
function fork(watch: Watch, agent?: string): Watch {
    assert.ok(due(watch) && forks(watch), 'a fork is due');
    return forked(forking(watch), agent);
}

test('a Send while Claude works on a turn of its own goes to a fork, which spends the relaunch of the Send: the end of the turn relaunches nothing', () => {
    let watch = turnStarted(look(start, { id: 's', sends: 0, waiting: 0 }));
    watch = look(watch, { id: 's', sends: 1, waiting: 2 });

    watch = fork(watch, 'f1');
    assert.equal(due(watch), false);
    assert.deepEqual(watch.forking, { owed: 'wake', session: 's', sends: 1, agent: 'f1' });

    watch = turnEnded(idle(watch), { id: 's', sends: 1, waiting: 2 });
    assert.equal(due(watch), false, 'the main loop is not relaunched for the threads the fork answers');
    assert.equal(notified(watch).session, null, 'the end of the main turn notifies nothing');
});

test('Claude idle, or in a turn a wake or relaunch opened, gets the prompt and no fork', () => {
    let watch = look(start, { id: 's', sends: 0, waiting: 0 });
    assert.equal(forks(look(watch, { id: 's', sends: 1, waiting: 1 })), false, 'idle');

    watch = turnStarted(submitted(sending(look(watch, { id: 's', sends: 1, waiting: 1 })), false));
    watch = look(watch, { id: 's', sends: 2, waiting: 2 });
    assert.equal(due(watch), true);
    assert.equal(forks(watch), false, 'the turn of a wake answers threads already: the next Send is queued after it');
    assert.equal(forks(look(idle(watch), { id: 's', sends: 2, waiting: 2 })), false);
});

test('the end of the fork notifies its session when it answered and nothing is owed, and lets a Send held meanwhile through', () => {
    let watch = turnStarted(look(start, { id: 's', sends: 0, waiting: 0 }));
    watch = fork(look(watch, { id: 's', sends: 1, waiting: 1 }), 'f1');
    assert.equal(status(watch), 'claude-reviews · 1 thread waiting for Claude · a fork answers in the background');

    let ended = forkEnded(watch, true);
    assert.equal(ended.session, 's');
    assert.equal(ended.watch.forking, null);
    assert.equal(forkEnded(watch, false).session, null, 'an interrupted fork may not have replied');

    watch = look(watch, { id: 's', sends: 2, waiting: 2 });
    assert.equal(due(watch), false, 'one fork at a time: the Send waits for its end');
    ended = forkEnded(watch, true);
    assert.equal(ended.session, null, 'a prompt is owed after it');
    assert.equal(forks(ended.watch), true, 'Claude still busy: a fork again');
    assert.equal(forks(idle(ended.watch)), false, 'Claude idle: the prompt');
});

test('a fork that ends interrupted or on an error spends no relaunch: Claude still busy, the end of its turn relaunches it; idle, it is relaunched at once', () => {
    let watch = turnStarted(look(start, { id: 's', sends: 0, waiting: 0 }));
    watch = fork(look(watch, { id: 's', sends: 1, waiting: 2 }), 'f1');

    let busy = forkEnded(watch, false).watch;
    assert.equal(due(busy), false);
    busy = turnEnded(idle(busy), { id: 's', sends: 1, waiting: 2 });
    assert.equal(busy.owed, 'relaunch');
    assert.equal(forks(busy), false);

    let ended = turnEnded(idle(watch), { id: 's', sends: 1, waiting: 2 });
    assert.equal(due(ended), false, 'no relaunch while the fork runs');
    ended = forkEnded(ended, false).watch;
    assert.equal(ended.owed, 'relaunch');
    assert.equal(forks(ended), false);
    assert.equal(submitted(sending(ended), false).sessions.s.relaunched, 1);

    assert.equal(due(forkEnded(idle(look(watch, { id: 's', sends: 1, waiting: 0 })), false).watch), false, 'nothing waiting, nothing owed');
});

test('a fork the engine denies leaves the prompt owed, to submit instead', () => {
    let watch = turnStarted(look(start, { id: 's', sends: 0, waiting: 0 }));
    watch = fork(look(watch, { id: 's', sends: 1, waiting: 1 }));

    assert.equal(watch.forking, null);
    assert.equal(watch.owed, 'wake');
    assert.equal(watch.sessions.s.relaunched, 0, 'the fork that did not start spends no relaunch');
    watch = submitted(sending(watch), false);
    assert.equal(watch.notify, 's');
});

/** /proc/net/tcp then /proc/net/tcp6: a listener of uid 1000 on 127.0.0.1:0xA609, a connection of uid 1001 from that port, a listener of 1001 on 0.0.0.0:7778, one of 1002 on [::ffff:127.0.0.1]:0xA609. */
const PROC = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:A609 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 84322 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:A609 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1001        0 0 1 0000000000000000 20 4 30 10 -1',
    '   2: 00000000:1E62 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 7964741 1 0000000000000000 100 0 0 10 0',
    '   0: 0000000000000000FFFF00000100007F:A609 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 10494914 1 0000000000000000 100 0 0 10 0',
].join('\n');

test('the listeners of a port are the sockets listening on it, IPv4 or IPv6, with their uid', () => {
    assert.deepEqual(listeners(PROC, 0xA609), [1000, 1002], 'a connection from the port is no listener');
    assert.deepEqual(listeners(PROC, 7778), [1001], 'any address, 0.0.0.0 included');
    assert.deepEqual(listeners(PROC, 1234), []);
    assert.deepEqual(listeners('', 7778), []);
});

test('a write of the main loop leads to the folder of its file, a relative path read from the shell\'s directory', () => {
    assert.equal(touched({ tool: 'Edit', file_path: '/b/src/a.ts' }, '/a', '/a'), '/b/src');
    assert.equal(touched({ tool: 'Write', file_path: 'src/a.ts' }, '/a', '/a/web'), '/a/web/src');
    assert.equal(touched({ tool: 'NotebookEdit', notebook_path: '/b/n.ipynb' }, '/a', '/a'), '/b');
});

test('a Bash call of the main loop leads to the shell\'s directory only once a cd changed it', () => {
    assert.equal(touched({ tool: 'Bash', command: 'cd /b' }, '/a', '/b'), '/b');
    assert.equal(touched({ tool: 'Bash', command: 'cd /b && make' }, '/a', '/a'), undefined, 'a cd the shell did not keep');
});

test('a call that writes nothing leads nowhere', () => {
    assert.equal(touched({ tool: 'Read', file_path: '/b/a.ts' }, '/a', '/a'), undefined);
});
