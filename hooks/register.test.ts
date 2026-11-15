import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { dataHome, removeRepos, repo, write } from '../server/fixture.ts';
import { notification, start } from '../server/main.ts';
import { register } from './register.ts';
import { prompt } from './watch.ts';

dataHome();
const ROOT = join(import.meta.dirname, '..');
let server: Server;
let port: number;
/** The notifications the server ran, instead of showing them. */
const notified: string[][] = [];
before(async () => {
    server = await start(0, argv => notified.push(argv));
    port = (server.address() as AddressInfo).port;
});
after(() => {
    server.close();
    removeRepos();
});

async function api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
}

/**
 * The mod under a stand-in for Claude Code: its hooks, and a `$` that answers from the real server and real git,
 * records what reaches the host (prompts, commands, log lines), and fires the poll only when the test says so.
 */
/** `launcher`, the PhpStorm launcher the mod finds, none by default; `choice`, the answer to its question, none for a dismissed one. */
async function mod(cwd: string, { serverPort = port, launcher = '', choice = undefined as string | undefined } = {}) {
    const hooks: { event: string; matcher: Record<string, string>; hook: Function }[] = [];
    const on = (event: string, matcher: any, hook?: Function) => {
        hooks.push(hook ? { event, matcher, hook } : { event, matcher: {}, hook: matcher });
        return { catch() {} };
    };
    register(on as any, {} as any);
    const seen = { asked: [] as string[], fetched: [] as string[], submitted: [] as string[], appended: 0, run: [] as string[][], cwd: [] as (string | undefined)[], log: [] as string[], polls: [] as Function[] };
    let answer: object = {};
    let down = false;
    const $ = {
        plugin: { name: 'local-reviews', root: ROOT },
        env: { get: async (name: string) => name === 'CLAUDE_REVIEWS_PORT' ? String(serverPort) : undefined },
        fs: { read: (path: string) => readFile(path, 'utf8') },
        http: {
            fetch: async (url: string, init?: any) => {
                seen.fetched.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
                if (down) return { status: 500, ok: false, headers: {}, text: '{"error":"down"}' };
                const res = await fetch(url, init);
                return { status: res.status, ok: res.ok, headers: {}, text: await res.text() };
            },
        },
        process: {
            run: async (argv: string[], init?: { cwd?: string }) => {
                seen.run.push(argv);
                seen.cwd.push(init?.cwd);
                if (argv[3] === 'phpstorm-launcher') return { exitCode: 0, stdout: launcher && `${launcher}\n`, stderr: '' };
                if (argv[0] !== 'git') return { exitCode: 0, stdout: '', stderr: '' };
                const git = spawnSync(argv[0], argv.slice(1), { cwd: init?.cwd ?? cwd, encoding: 'utf8' });
                return { exitCode: git.status, stdout: git.stdout, stderr: git.stderr };
            },
        },
        clock: {
            every: (_: number, poll: Function) => (seen.polls.push(poll), { cancel() {} }),
            after: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) }; },
        },
        prompt: { submit: async ({ text }: { text: string }) => (seen.submitted.push(text), { text, ...answer }) },
        session: { append: async () => { seen.appended++; } },
        tool: { register: async ({ name }: { name: string }) => ({ tool: `mcp__local-reviews__${name}` }) },
        command: { register: async ({ name }: { name: string }) => ({ command: name }) },
        ui: {
            log: (text: string) => seen.log.push(text),
            ask: async (question: string) => {
                seen.asked.push(question);
                if (choice === undefined) throw new Error('dismissed');
                return choice;
            },
        },
    };
    const engine: Record<string, (e: any) => unknown> = {
        'session.start': e => ({ cwd: e.cwd }),
        'prompt.context': e => ({ blocks: e.blocks }),
        'prompt.submit': e => ({ text: e.text, context: e.context }),
        'turn.start': e => ({ turnId: e.turnId }),
        'turn.complete': () => ({ text: '' }),
    };
    async function fire(event: string, e: any): Promise<any> {
        const found = hooks.find(h => h.event === event && Object.entries(h.matcher).every(([key, value]) => e[key] === value));
        const next = async (input: any) => engine[event](input);
        return found ? found.hook($, e, next) : next(e);
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    await fire('session.start', { cwd, surface: null, isInteractive: false });
    return {
        seen, fire, settle,
        /** How the engine answers the next prompts: entered, or `{ drop }`. */
        answer: (value: object) => { answer = value; },
        /** Whether every request to the server fails with a 500. */
        down: (value: boolean) => { down = value; },
        poll: async () => { for (const poll of seen.polls) await poll(); await settle(); },
        tool: (name: string, input: object = {}) => fire('tool.call', { tool: `mcp__local-reviews__${name}`, ...input }),
    };
}

/** A worktree with an open session, and a thread Waiting for Claude per message of mine in `waiting`. */
async function session(waiting: string[] = ['Why?']): Promise<{ dir: string; id: string }> {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\n' });
    write(dir, { 'a.txt': 'one\n2\nthree\n' });
    const { id } = await api('POST', '/api/sessions', { worktree: dir });
    const shown = await api('GET', `/api/sessions/${id}/diff`);
    for (const body of waiting) await api('POST', `/api/sessions/${id}/threads`, { author: 'me', base: shown.base, tree: shown.tree, path: 'a.txt', side: 'new', start: 2, end: 2, body });
    if (waiting.length) await api('POST', `/api/sessions/${id}/send`, { tree: shown.tree });
    return { dir, id };
}

async function send(id: string, body: string): Promise<void> {
    const shown = await api('GET', `/api/sessions/${id}/diff`);
    await api('POST', `/api/sessions/${id}/threads`, { author: 'me', base: shown.base, tree: shown.tree, path: 'a.txt', side: 'new', start: 1, end: 1, body });
    await api('POST', `/api/sessions/${id}/send`, { tree: shown.tree });
}

test('a Send seen during a turn calls $.prompt.submit with the text of #12, without $.session.append', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir);
    await claude.poll();
    await claude.fire('turn.start', { text: 'work', turnId: 't1' });

    await send(id, 'And this?');
    await claude.poll();

    assert.deepEqual(claude.seen.submitted, [prompt(1)]);
    assert.equal(prompt(1), "claude-reviews : 1 thread t'attend. Lis-les avec list_open_threads, réponds dans chacun avec reply_to_thread, et modifie le code quand un thread le demande.");
    assert.equal(claude.seen.appended, 0);
});

test('the poll of the mod tells the server that a Claude session runs in the worktree', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir);

    await claude.poll();

    assert.equal((await api('GET', `/api/sessions/${id}`)).claudeSession, true);
});

test('list_open_threads gives, but for Resolved threads and threads without published message, the id, file, side, range, lines and published messages', async () => {
    const { dir, id } = await session(['Waiting', 'To resolve']);
    await api('POST', `/api/sessions/${id}/threads`, { author: 'claude', path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Look here' });
    await api('POST', `/api/sessions/${id}/threads/2/resolve`, {});
    const shown = await api('GET', `/api/sessions/${id}/diff`);
    await api('POST', `/api/sessions/${id}/threads`, { author: 'me', base: shown.base, tree: shown.tree, path: 'a.txt', side: 'old', start: 2, end: 2, body: 'Still Pending' });
    await api('POST', `/api/sessions/${id}/threads/1/messages`, { author: 'me', body: 'Pending, so not given' });
    const claude = await mod(dir);

    const result = JSON.parse((await claude.tool('list_open_threads')).result);

    assert.deepEqual(result.threads.map((thread: any) => [thread.id, thread.status]), [[1, 'waiting-for-claude'], [3, 'open']]);
    const { date } = result.threads[0].messages[0];
    assert.match(date, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(result.threads[0], {
        id: 1, status: 'waiting-for-claude', outdated: false, file: 'a.txt', side: 'new', start: 2, end: 2, lines: ['2'],
        messages: [{ author: 'me', body: 'Waiting', date }],
    });
});

test('list_open_threads gives a thread whose line went down 5 lines in the working tree at its new range, with the current lines', async () => {
    const { dir } = await session();
    write(dir, { 'a.txt': 'a\nb\nc\nd\ne\none\n2\nthree\n' });
    const claude = await mod(dir);

    const [thread] = JSON.parse((await claude.tool('list_open_threads')).result).threads;

    assert.deepEqual([thread.outdated, thread.start, thread.end, thread.lines], [false, 7, 7, ['2']]);
});

test('list_open_threads gives a thread whose line changed in the working tree as Outdated, with its original diff excerpt', async () => {
    const { dir } = await session();
    write(dir, { 'a.txt': 'one\ndeux\nthree\n' });
    const claude = await mod(dir);

    const [thread] = JSON.parse((await claude.tool('list_open_threads')).result).threads;

    assert.deepEqual([thread.outdated, thread.start, thread.end, thread.hunk], [true, 2, 2, '@@ -1,3 +1,3 @@\n one\n-two\n+2']);
});

test('on an approved session, reply_to_thread answers "session approuvée", and the mod stops relaunching for the worktree', async () => {
    const { dir, id } = await session();
    const claude = await mod(dir);
    await claude.tool('list_open_threads');
    claude.answer({ drop: 'stopped' });
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't1' });
    assert.equal(claude.seen.submitted.length, 1, 'a relaunch was dropped, and waits for the next turn');
    claude.answer({});
    await api('POST', `/api/sessions/${id}/approve`, {});

    const replied = await claude.tool('reply_to_thread', { id: 1, body: 'Too late' });
    await claude.fire('turn.start', { text: 'next', turnId: 't2' });
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't2' });
    await claude.settle();

    assert.deepEqual(replied, { deny: 'session approuvée' });
    assert.equal(claude.seen.submitted.length, 1);
});

test('reply_to_thread publishes the reply of Claude in the thread', async () => {
    const { dir, id } = await session();
    const claude = await mod(dir);

    await claude.tool('reply_to_thread', { id: 1, body: 'Because' });

    const thread = (await api('GET', `/api/sessions/${id}`)).threads[0];
    assert.deepEqual([thread.status, thread.messages.at(-1).author, thread.messages.at(-1).body], ['open', 'claude', 'Because']);
});

test('open_thread opens the session of a worktree that has none, with a thread open', async () => {
    const dir = repo({ 'a.txt': 'one\ntwo\n' });
    const claude = await mod(dir);

    const opened = await claude.tool('open_thread', { file: 'a.txt', side: 'new', lines: [1, 2], body: 'Is this right?' });

    const session = await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}`);
    assert.deepEqual(opened, { result: 'Opened thread 1' });
    assert.deepEqual([session.threads[0].status, session.threads[0].anchor.lines], ['open', ['one', 'two']]);
});

test('a Claude session starting in a worktree where threads wait adds "N threads t\'attendent" to its first prompt, and to no subagent\'s first message', async () => {
    const { dir } = await session(['One', 'Two']);
    const claude = await mod(dir);
    const typed = (text: string) => claude.fire('prompt.submit', { text, wait: false, origin: { kind: 'composer' } });

    const subagent = await claude.fire('prompt.context', { blocks: [{ name: 'currentDate', text: 'today' }] });
    const first = await typed('Hello');
    const second = await typed('Again');

    assert.deepEqual(subagent.blocks, [{ name: 'currentDate', text: 'today' }]);
    assert.deepEqual(first.context, [prompt(2)]);
    assert.equal(second.context, undefined);
});

test('a poll that fails does not make the mod wake Claude again for the same Send', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir);
    await claude.poll();
    await send(id, 'And this?');
    await claude.poll();

    claude.down(true);
    await claude.poll();
    claude.down(false);
    await claude.poll();

    assert.equal(claude.seen.submitted.length, 1);
});

test('after an Approve, open_thread opens a new session of the worktree', async () => {
    const { dir, id } = await session();
    const claude = await mod(dir);
    await claude.tool('list_open_threads');
    await api('POST', `/api/sessions/${id}/approve`, {});

    const opened = await claude.tool('open_thread', { file: 'a.txt', side: 'new', lines: [1, 1], body: 'A new look' });

    const open = await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}`);
    assert.deepEqual(opened, { result: 'Opened thread 1' });
    assert.notEqual(open.id, id);
    assert.equal(open.threads[0].messages[0].body, 'A new look');
});

test('when the server does not answer, the tools and /review-local say so instead of failing', async () => {
    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: await nobody() });

    const replied = await claude.tool('reply_to_thread', { id: 1, body: 'Hi' });
    const opened = await claude.tool('open_thread', { file: 'a.txt', side: 'new', lines: [1], body: 'Hi' });
    const command = await claude.fire('command.run', { command: 'review-local', args: '' });

    assert.ok(replied.deny && opened.deny, 'both tools deny');
    assert.match(command.text, /does not answer/);
});

test('/review-local phpstorm asks the IDE to show the session, then runs the PhpStorm launcher on the worktree, without a question', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir, { launcher: '/opt/bin/phpstorm' });

    const command = await claude.fire('command.run', { command: 'review-local', args: 'phpstorm' });

    assert.deepEqual(claude.seen.asked, []);
    assert.ok((await api('GET', `/api/sessions/${id}`)).showRequestedAt);
    assert.ok(claude.seen.run.some(argv => argv.includes('/opt/bin/phpstorm') && argv.includes(dir)), JSON.stringify(claude.seen.run));
    assert.match(command.text, /PhpStorm/);
});

test('/review-local asks where to open the review when PhpStorm is there, and opens the browser on Browser', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir, { launcher: '/opt/bin/phpstorm', choice: 'Browser' });

    const command = await claude.fire('command.run', { command: 'review-local', args: '' });

    assert.deepEqual(claude.seen.asked, ['Where to open the review?']);
    assert.equal((await api('GET', `/api/sessions/${id}`)).showRequestedAt, null);
    assert.ok(claude.seen.run.some(argv => argv.includes(`http://127.0.0.1:${port}/s/${id}`)));
    assert.match(command.text, new RegExp(`/s/${id}`));
});

test('/review-local opens the browser without a question when no PhpStorm launcher is found, and opens nothing when the question is dismissed', async () => {
    const { dir, id } = await session([]);
    const alone = await mod(dir);
    const dismissed = await mod(dir, { launcher: '/opt/bin/phpstorm' });

    await alone.fire('command.run', { command: 'review-local', args: '' });
    const nothing = await dismissed.fire('command.run', { command: 'review-local', args: '' });

    assert.deepEqual(alone.seen.asked, []);
    assert.ok(alone.seen.run.some(argv => argv.includes(`http://127.0.0.1:${port}/s/${id}`)));
    assert.ok(!dismissed.seen.run.some(argv => argv.includes(`http://127.0.0.1:${port}/s/${id}`) || argv.includes('/opt/bin/phpstorm')));
    assert.match(nothing.text, new RegExp(`/s/${id}`));
});

test('reply_to_thread refuses a thread id that is not a positive integer', async () => {
    const { dir, id } = await session();
    const claude = await mod(dir);

    const replied = await claude.tool('reply_to_thread', { id: '1/resolve', body: 'Hi' });

    assert.match(replied.deny, /positive integer/);
    assert.equal((await api('GET', `/api/sessions/${id}`)).threads[0].resolved, false);
});

/** A port where something else answers, as `answer` says. */
async function impostor(answer: (path: string, res: any) => void): Promise<{ port: number; paths: string[] }> {
    const paths: string[] = [];
    const other = createServer((req, res) => { paths.push(`${req.method} ${req.url}`); answer(req.url!, res); });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    after(() => { other.closeAllConnections(); other.close(); });
    return { port: (other.address() as AddressInfo).port, paths };
}

const LAUNCH = ['/bin/sh', '-c',
    `d="\${XDG_DATA_HOME:-$HOME/.local/share}/claude-reviews"; mkdir -p "$d"; trap '' HUP; nohup node "$1" >> "$d/server.log" 2>&1 </dev/null &`,
    'claude-reviews', `${ROOT}/server/main.ts`];

const launches = (claude: { seen: { run: string[][] } }) => claude.seen.run.filter(argv => argv[0] !== 'git');

/** Waits for what the mod does in the background, the start of the server, up to 3 s. */
async function until(done: () => unknown): Promise<void> {
    for (let waited = 0; !done() && waited < 3000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
}

/** The call, or a failure if it has not returned within 5 s. */
function returns<T>(call: Promise<T>): Promise<T> {
    return Promise.race([call, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('the hook never returned')), 5000).unref())]);
}

/** A port where nothing listens. */
async function nobody(): Promise<number> {
    const free = createServer();
    await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve));
    const { port } = free.address() as AddressInfo;
    await new Promise(resolve => free.close(resolve));
    return port;
}

test('with no server on the port, the mod starts one from its own root, detached, logging under the data folder', async () => {
    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: await nobody() });
    await until(() => launches(claude).length);

    assert.deepEqual(launches(claude), [LAUNCH]);
    assert.equal(claude.seen.cwd[claude.seen.run.indexOf(launches(claude)[0])], ROOT, 'the server runs from the plugin, not from the worktree');
});

test('a claude-reviews server of an older version is shut down, then started again from the mod\'s root', async () => {
    const other = await impostor((path, res) => res.end(path === '/api/health' ? JSON.stringify({ app: 'claude-reviews', version: '0.0.9' }) : '{}'));

    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: other.port });
    await until(() => launches(claude).length);

    assert.deepEqual(other.paths.slice(0, 2), ['GET /api/health', 'POST /api/shutdown']);
    assert.deepEqual(launches(claude), [LAUNCH]);
});

test('a port answered by something other than claude-reviews is reported, and no server is started', async () => {
    const other = await impostor((_, res) => res.end('<html>another app</html>'));

    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: other.port });
    await until(() => claude.seen.log.length);

    assert.deepEqual(launches(claude), []);
    assert.match(claude.seen.log.join('\n'), new RegExp(`127\\.0\\.0\\.1:${other.port}.*not claude-reviews`));
});

test('a server of the same version is used as it is', async () => {
    const claude = await mod(repo({ 'a.txt': 'a\n' }));
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.deepEqual(launches(claude), []);
});

test('a server of a newer version is used as it is, so that two mods never shut each other\'s server down', async () => {
    const other = await impostor((_, res) => res.end(JSON.stringify({ app: 'claude-reviews', version: '0.10.0' })));

    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: other.port });
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.deepEqual(other.paths, ['GET /api/health']);
    assert.deepEqual(launches(claude), []);
});

test('a port that accepts without answering is reported, and the mod starts its poll without waiting for the server', async () => {
    const other = await impostor(() => {});
    const started = Date.now();

    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: other.port });

    assert.ok(Date.now() - started < 1000, 'session.start does not wait for the server');
    assert.equal(claude.seen.polls.length, 1);
    await until(() => claude.seen.log.length);
    assert.match(claude.seen.log.join('\n'), /claude-reviews/);
    assert.deepEqual(launches(claude), []);
});

test('a port that accepts without answering holds neither a prompt, nor the end of a turn, nor a tool', async () => {
    const other = await impostor(() => {});
    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: other.port });

    const submitted = await returns(claude.fire('prompt.submit', { text: 'Hello', wait: false, origin: { kind: 'composer' } }));
    await returns(claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't1' }));
    const listed = await returns(claude.tool('list_open_threads'));

    assert.equal(submitted.text, 'Hello');
    assert.match(listed.deny, /does not answer/);
});

test('a turn interrupted or ended on an error is not relaunched', async () => {
    const { dir } = await session();
    const claude = await mod(dir);

    await claude.fire('turn.complete', { reason: 'aborted', answer: '', turnId: 't1', isAborted: true });
    await claude.fire('turn.complete', { reason: 'error', answer: '', turnId: 't2' });
    await claude.settle();
    assert.equal(claude.seen.submitted.length, 0);

    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't3' });
    assert.equal(claude.seen.submitted.length, 1);
});

test('the end of a turn that follows neither a Send nor its relaunch calls no turn-complete; the end of the turn that follows a Send calls it once', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir);
    const calls = () => claude.seen.fetched.filter(call => call === `POST /api/sessions/${id}/turn-complete`).length;
    await claude.poll();
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't1' });
    await claude.settle();
    assert.equal(calls(), 0);

    await send(id, 'And this?');
    await claude.poll();
    await claude.tool('reply_to_thread', { id: 1, body: 'Because' });
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't2' });
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't3' });
    await claude.settle();

    assert.equal(calls(), 1);
    assert.deepEqual(notified.at(-1), notification('Claude replied in 1 thread'));
});

test('when a Send is relaunched, turn-complete is called at the end of the relaunch, not before', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir);
    const calls = () => claude.seen.fetched.filter(call => call === `POST /api/sessions/${id}/turn-complete`).length;
    await claude.poll();
    await send(id, 'And this?');
    await claude.poll();

    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't1' });
    await claude.settle();
    assert.equal(claude.seen.submitted.length, 2, 'the Send was relaunched');
    assert.equal(calls(), 0);
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't2' });
    await claude.settle();

    assert.equal(calls(), 1);
});
