import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
    const auth = { authorization: `Bearer ${(server as unknown as { token: string }).token}` };
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
}

/**
 * The mod under a stand-in for Claude Code: its hooks, and a `$` that answers from the real server and real git,
 * records what reaches the host (prompts, commands, log lines), and fires the poll only when the test says so.
 */
/**
 * `serverPort`, the port the harness writes into the endpoint file for the mod to find; `launcher` and `code`, the PhpStorm and VS Code launchers the mod finds, none by default;
 * `choice`, the answer to its question, none for a dismissed one; `down`, whether the server fails from the start;
 * `env`, variables the mod reads instead of this process's (SSH_* left out unless given); `uid` and `procNet`, what `id -u` and `cat /proc/net/tcp…` print, empty by default
 * (an unknown owner, trusted); `endpointText`, the endpoint file written instead of the one naming `serverPort`; `sleep`, what $.clock.sleep waits for, nothing by default.
 */
async function mod(cwd: string, { serverPort = port as number | string, launcher = '', code = '', choice = undefined as string | undefined, down = false, env = {} as Record<string, string>, uid = '', procNet = '', endpointText = undefined as string | undefined, sleep = async () => {} } = {}) {
    let proc = procNet;
    const hooks: { event: string; matcher: Record<string, string>; hook: Function }[] = [];
    const on = (event: string, matcher: any, hook?: Function) => {
        hooks.push(hook ? { event, matcher, hook } : { event, matcher: {}, hook: matcher });
        return { catch() {} };
    };
    register(on as any, {} as any);
    const seen = {
        asked: [] as string[], fetched: [] as string[], submitted: [] as string[], appended: 0, run: [] as string[][], cwd: [] as (string | undefined)[], log: [] as string[], polls: [] as Function[], options: [] as string[][],
        status: [] as (string | undefined)[], tools: [] as { name: string; description: string; inputSchema: any }[],
    };
    let answer: object = {};
    let root = cwd;
    const $ = {
        plugin: { name: 'local-reviews', root: ROOT },
        // A run of the tests over SSH must not change what the mod does.
        env: { get: async (name: string) => name in env ? env[name] : name.startsWith('SSH_') ? undefined : process.env[name] },
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
                if (argv[0] === 'id') return { exitCode: 0, stdout: uid && `${uid}\n`, stderr: '' };
                if (argv[0] === 'cat') return { exitCode: 0, stdout: proc, stderr: '' };
                if (argv[3] === 'phpstorm-launcher') return { exitCode: 0, stdout: launcher && `${launcher}\n`, stderr: '' };
                if (argv[3] === 'vscode-launcher') return { exitCode: 0, stdout: code && `${code}\n`, stderr: '' };
                if (argv[0] !== 'git') return { exitCode: 0, stdout: '', stderr: '' };
                const git = spawnSync(argv[0], argv.slice(1), { cwd: init?.cwd ?? cwd, encoding: 'utf8' });
                return { exitCode: git.status, stdout: git.stdout, stderr: git.stderr };
            },
        },
        clock: {
            every: (_: number, poll: Function) => (seen.polls.push(poll), { cancel() {} }),
            after: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) }; },
            sleep: () => sleep(),
        },
        prompt: { submit: async ({ text }: { text: string }) => (seen.submitted.push(text), { text, ...await answer }) },
        session: { append: async () => { seen.appended++; }, root: async () => root },
        tool: { register: async (tool: { name: string; description: string; inputSchema: any }) => (seen.tools.push(tool), { tool: `mcp__local-reviews__${tool.name}` }) },
        command: { register: async ({ name }: { name: string }) => ({ command: name }) },
        ui: {
            log: (text: string) => seen.log.push(text),
            status: (text: string | undefined) => seen.status.push(text),
            ask: async (question: string, { options }: { options: string[] }) => {
                seen.asked.push(question);
                seen.options.push(options);
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
    // The server writes this file; here the harness stands in for it, pointing the mod at the test server (or the port under test).
    mkdirSync(DATA, { recursive: true });
    writeFileSync(join(DATA, 'endpoint'), endpointText ?? JSON.stringify({ port: serverPort, token: (server as unknown as { token: string }).token }));
    await fire('session.start', { cwd, surface: null, isInteractive: false });
    return {
        seen, fire, settle,
        /** How the engine answers the next prompts: entered, or `{ drop }`, or once a promise settles. */
        answer: (value: object) => { answer = value; },
        /** Whether every request to the server fails with a 500. */
        down: (value: boolean) => { down = value; },
        /** Moves the session's root, as /cd or EnterWorktree do. */
        move: (dir: string) => { root = dir; },
        /** What `cat /proc/net/tcp…` prints from now on: another account may take a port. */
        hold: (text: string) => { proc = text; },
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
    assert.equal(prompt(1), 'claude-reviews: 1 thread is waiting for you. Read them with list_open_threads, reply in each with reply_to_thread, and change the code when a thread asks for it.');
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

    assert.equal(result.base, (await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}&reanchor`)).reanchoredOn.base);
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

test('on an approved session, reply_to_thread answers "session approved", and the mod stops relaunching for the worktree', async () => {
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

    assert.deepEqual(replied, { deny: 'session approved' });
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

test('a Claude session starting in a worktree where threads wait adds "N threads are waiting for you" to its first prompt, and to no subagent\'s first message', async () => {
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

    assert.match(replied.deny, /does not answer/);
    assert.match(opened.deny, /does not answer/);
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
    assert.ok(claude.seen.run.some(argv => argv.some(a => a.startsWith(`http://127.0.0.1:${port}/s/${id}#`))));
    assert.match(command.text, new RegExp(`/s/${id}`));
});

test('/review-local opens the browser without a question when no PhpStorm launcher is found, and opens nothing when the question is dismissed', async () => {
    const { dir, id } = await session([]);
    const alone = await mod(dir);
    const dismissed = await mod(dir, { launcher: '/opt/bin/phpstorm' });

    await alone.fire('command.run', { command: 'review-local', args: '' });
    const nothing = await dismissed.fire('command.run', { command: 'review-local', args: '' });

    assert.deepEqual(alone.seen.asked, []);
    assert.ok(alone.seen.run.some(argv => argv.some(a => a.startsWith(`http://127.0.0.1:${port}/s/${id}#`))));
    assert.ok(!dismissed.seen.run.some(argv => argv.some(a => a.startsWith(`http://127.0.0.1:${port}/s/${id}#`)) || argv.includes('/opt/bin/phpstorm')));
    assert.match(nothing.text, new RegExp(`/s/${id}`));
});

test('/review-local vscode asks the IDE to show the session, then runs code on the worktree, without a question', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir, { launcher: '/opt/bin/phpstorm', code: '/usr/bin/code' });

    const command = await claude.fire('command.run', { command: 'review-local', args: 'vscode' });

    assert.deepEqual(claude.seen.asked, []);
    assert.ok((await api('GET', `/api/sessions/${id}`)).showRequestedAt);
    assert.ok(claude.seen.run.some(argv => argv.includes('/usr/bin/code') && argv.includes(dir)), JSON.stringify(claude.seen.run));
    assert.ok(!claude.seen.run.some(argv => argv.includes('/opt/bin/phpstorm') && argv.includes(dir)));
    assert.match(command.text, /VS Code/);
});

test('/review-local asks between the IDEs it finds and the browser, and opens VS Code on VS Code', async () => {
    const { dir } = await session([]);
    const both = await mod(dir, { launcher: '/opt/bin/phpstorm', code: '/usr/bin/code', choice: 'VS Code' });
    const code = await mod(dir, { code: '/usr/bin/code', choice: 'Browser' });

    await both.fire('command.run', { command: 'review-local', args: '' });
    await code.fire('command.run', { command: 'review-local', args: '' });

    assert.deepEqual(both.seen.options, [['PhpStorm', 'VS Code', 'Browser']]);
    assert.ok(both.seen.run.some(argv => argv.includes('/usr/bin/code') && argv.includes(dir)));
    assert.deepEqual(code.seen.options, [['VS Code', 'Browser']]);
    assert.ok(!code.seen.run.some(argv => argv.includes('/usr/bin/code') && argv.includes(dir)));
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

const DATA = join(process.env.XDG_DATA_HOME!, 'claude-reviews');
const LAUNCH = ['/bin/sh', '-c',
    `umask 077; mkdir -p "$2"; trap '' HUP; nohup node "$1" >> "$2/server.log" 2>&1 </dev/null &`,
    'claude-reviews', `${ROOT}/server/main.ts`, DATA];

const launches = (claude: { seen: { run: string[][] } }) => claude.seen.run.filter(argv => argv.at(-2) === `${ROOT}/server/main.ts`);

/** A line of /proc/net/tcp: a socket of `uid` listening on 127.0.0.1:`port`. */
const listening = (port: number, uid: number) =>
    `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 84322 1 0000000000000000 100 0 0 10 0`;

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
    await until(() => other.paths.length > 2);
    await claude.settle();
    assert.deepEqual(claude.seen.log, [], 'the server answers after its launch');
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

test('a server that does not answer a few seconds after its launch is reported, with the path of its log and its last lines', async () => {
    mkdirSync(DATA, { recursive: true });
    appendFileSync(join(DATA, 'server.log'), 'Error: listen EADDRINUSE\n');

    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: await nobody() });
    await until(() => claude.seen.log.length);

    const log = claude.seen.log.join('\n');
    assert.match(log, /did not start/);
    assert.ok(log.includes(join(DATA, 'server.log')), log);
    assert.match(log, /EADDRINUSE/);
});

test('after /cd or EnterWorktree into another worktree, the mod polls it and its tools write there, from a fresh state', async () => {
    const first = await session(['First']);
    const second = await session(['Second']);
    const claude = await mod(first.dir);
    const tops = () => claude.seen.run.filter(argv => argv.join(' ') === 'git rev-parse --show-toplevel').length;
    const typed = (text: string) => claude.fire('prompt.submit', { text, wait: false, origin: { kind: 'composer' } });
    await claude.tool('list_open_threads');
    await typed('Hello');
    await claude.poll();
    assert.equal(tops(), 1, 'no git rev-parse while the root stays');

    claude.move(second.dir);
    await claude.poll();
    await claude.poll();
    const prompted = await typed('Again');
    const replied = await claude.tool('reply_to_thread', { id: 1, body: 'Here' });

    assert.equal(tops(), 2);
    assert.deepEqual(replied, { result: 'Replied in thread 1' });
    assert.equal((await api('GET', `/api/sessions/${second.id}`)).threads[0].messages.at(-1).body, 'Here');
    assert.equal((await api('GET', `/api/sessions/${first.id}`)).threads[0].messages.length, 1);
    assert.deepEqual(claude.seen.submitted, [], 'a Send made before the move wakes nobody, as at the start of a Claude session');
    assert.deepEqual(prompted.context, [prompt(1)], 'the next prompt counts the threads of the new worktree');
});

test('a wake still in flight when the worktree changes settles without touching the watch of the new worktree', async () => {
    const first = await session([]);
    const second = await session([]);
    const claude = await mod(first.dir);
    let enter!: (value: object) => void;
    claude.answer(new Promise(resolve => { enter = resolve; }));
    await claude.poll();
    await send(first.id, 'And this?');
    await claude.poll();
    assert.equal(claude.seen.submitted.length, 1);

    claude.move(second.dir);
    await claude.poll();
    enter({});
    await claude.settle();
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't1' });
    await claude.settle();

    assert.equal(claude.seen.fetched.filter(call => call.endsWith('/turn-complete')).length, 0);
});

test('a server error reaches the tools as its message', async () => {
    const { dir } = await session();
    const claude = await mod(dir);
    claude.down(true);

    const listed = await claude.tool('list_open_threads');
    const replied = await claude.tool('reply_to_thread', { id: 1, body: 'Hi' });

    assert.deepEqual([listed, replied], [{ deny: 'down' }, { deny: 'down' }]);
});

test('a 200 without threads reads as no answer: neither the poll nor the end of a turn fails, and the tools say the server does not answer', async () => {
    const other = await impostor((path, res) => res.end(path === '/api/health' ? JSON.stringify({ app: 'claude-reviews', version: '0.10.0' }) : '{}'));
    const claude = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: other.port });

    await claude.poll();
    await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't1' });
    const listed = await claude.tool('list_open_threads');

    assert.match(listed.deny, /does not answer/);
});

test('a first prompt the server does not answer leaves the count of waiting threads to the next prompt', async () => {
    const { dir } = await session(['One']);
    const claude = await mod(dir);
    const typed = (text: string) => claude.fire('prompt.submit', { text, wait: false, origin: { kind: 'composer' } });

    claude.down(true);
    const first = await typed('Hello');
    claude.down(false);
    const second = await typed('Again');
    const third = await typed('More');

    assert.deepEqual([first.context, second.context, third.context], [undefined, [prompt(1)], undefined]);
});

test('a turn opened by a wake and interrupted, or ended on an error, calls no turn-complete, nor does the next turn in its place', async () => {
    for (const reason of ['aborted', 'error']) {
        const { dir, id } = await session([]);
        const claude = await mod(dir);
        const calls = () => claude.seen.fetched.filter(call => call === `POST /api/sessions/${id}/turn-complete`).length;
        await claude.poll();
        await send(id, 'And this?');
        await claude.poll();

        await claude.fire('turn.complete', { reason, answer: '', turnId: 't1', isAborted: reason === 'aborted' });
        await claude.tool('reply_to_thread', { id: 1, body: 'Because' });
        await claude.fire('turn.complete', { reason: 'answer', answer: '', turnId: 't2' });
        await claude.settle();

        assert.equal(calls(), 0, reason);
    }
});

test('the mod reads the port and token from the endpoint file, and authenticates its calls', async () => {
    const { dir } = await session([]);
    const claude = await mod(dir);

    // The server answers 401 without the token, so a result proves the mod read it from the endpoint file and sent it.
    const listed = await claude.tool('list_open_threads');

    assert.ok('result' in listed, JSON.stringify(listed));
});

test('/review-local phpstorm without a PhpStorm launcher says so, and opens the browser', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir);

    const command = await claude.fire('command.run', { command: 'review-local', args: 'phpstorm' });

    assert.match(command.text, /PhpStorm launcher not found/);
    assert.ok(claude.seen.run.some(argv => argv.some(a => a.startsWith(`http://127.0.0.1:${port}/s/${id}#`))));
});

test('/review-local compares an answer typed under Other without case', async () => {
    const { dir } = await session([]);
    const claude = await mod(dir, { launcher: '/opt/bin/phpstorm', choice: 'phpstorm' });

    const command = await claude.fire('command.run', { command: 'review-local', args: '' });

    assert.match(command.text, /opened in PhpStorm/);
});

test('/review-local looks the launcher up and runs it from the plugin\'s root, by nohup and immune to SIGHUP, so that PhpStorm outlives the Claude session', async () => {
    const { dir } = await session([]);
    const claude = await mod(dir, { launcher: '/opt/bin/phpstorm' });

    await claude.fire('command.run', { command: 'review-local', args: 'phpstorm' });

    const lookup = claude.seen.run.findIndex(argv => argv[3] === 'phpstorm-launcher');
    const detached = claude.seen.run.findIndex(argv => argv.includes('/opt/bin/phpstorm'));
    assert.deepEqual([claude.seen.cwd[lookup], claude.seen.cwd[detached]], [ROOT, ROOT]);
    assert.match(claude.seen.run[detached][2], /trap '' HUP; nohup "\$@"/);
});

test('the poll pins "claude-reviews · N threads waiting for Claude" by $.ui.status, without a request of its own, and only when the text changes', async () => {
    const { dir } = await session(['One', 'Two']);
    const claude = await mod(dir);
    const before = claude.seen.fetched.length;

    await claude.poll();
    assert.deepEqual(claude.seen.fetched.slice(before), ['GET /api/sessions']);
    await claude.poll();
    await claude.tool('reply_to_thread', { id: 1, body: 'Done' });
    await claude.poll();
    await claude.tool('reply_to_thread', { id: 2, body: 'Done' });
    await claude.poll();
    await claude.poll();

    assert.deepEqual(claude.seen.status, ['claude-reviews · 2 threads waiting for Claude', 'claude-reviews · 1 thread waiting for Claude', undefined]);
});

test('the status line says nothing without a session, and says that a dropped wake waits for the next prompt', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir);
    await claude.poll();
    assert.deepEqual(claude.seen.status, []);

    claude.answer({ drop: 'busy' });
    await send(id, 'And this?');
    await claude.poll();
    await claude.poll();
    claude.answer({});
    await claude.fire('prompt.submit', { text: 'Hello', wait: false, origin: { kind: 'composer' } });
    await claude.poll();

    assert.deepEqual(claude.seen.status, [
        'claude-reviews · 1 thread waiting for Claude',
        'claude-reviews · 1 thread waiting for Claude · wake held until the next prompt',
        'claude-reviews · 1 thread waiting for Claude',
    ]);
});

test('list_open_threads and reply_to_thread tell Claude that a suggestion block replaces the lines of the thread on side new, to apply unless he disagrees, then reply', async () => {
    const claude = await mod(repo({ 'a.txt': 'a\n' }));

    for (const name of ['list_open_threads', 'reply_to_thread']) {
        const { description } = claude.seen.tools.find(tool => tool.name === name)!;
        assert.match(description, /```suggestion/, name);
        assert.match(description, /apply it to the working tree unless you disagree, then reply in the thread/, name);
    }
});

test('list_open_threads gives a thread on a whole file with start and end at 0 and no lines, and says so', async () => {
    const { dir, id } = await session([]);
    const shown = await api('GET', `/api/sessions/${id}/diff`);
    await api('POST', `/api/sessions/${id}/threads`, { author: 'me', base: shown.base, tree: shown.tree, path: 'a.txt', side: 'new', start: 0, end: 0, body: 'The whole file' });
    await api('POST', `/api/sessions/${id}/send`, { tree: shown.tree });
    const claude = await mod(dir);

    const [thread] = JSON.parse((await claude.tool('list_open_threads')).result).threads;

    assert.deepEqual([thread.outdated, thread.start, thread.end, thread.lines], [false, 0, 0, []]);
    assert.match(claude.seen.tools.find(tool => tool.name === 'list_open_threads')!.description, /start and end at 0 is on the whole file/);
});

test('open_thread without lines opens a thread on the whole file, start and end at 0, and says so', async () => {
    const dir = repo({ 'a.txt': 'one\ntwo\n' });
    const claude = await mod(dir);

    const opened = await claude.tool('open_thread', { file: 'a.txt', side: 'new', body: 'The whole file' });

    const { anchor } = (await api('GET', `/api/sessions?worktree=${encodeURIComponent(dir)}`)).threads[0];
    assert.deepEqual(opened, { result: 'Opened thread 1' });
    assert.deepEqual([anchor.start, anchor.end, anchor.lines], [0, 0, []]);
    const tool = claude.seen.tools.find(tool => tool.name === 'open_thread')!;
    assert.deepEqual(tool.inputSchema.required, ['file', 'side', 'body']);
    assert.match(tool.description, /whole file/);
    assert.match(tool.inputSchema.properties.lines.description, /whole file/);
});

test('the mod neither adopts nor calls the server its endpoint names once another account listens on that port, and starts one of its own', async () => {
    // A squatter of the port of a dead server: the endpoint still names it, /proc/net/tcp says another uid listens there.
    const claude = await mod(repo({ 'a.txt': 'a\n' }), { uid: '1000', procNet: listening(port, 4242) });
    await until(() => launches(claude).length);

    const listed = await claude.tool('list_open_threads');

    assert.deepEqual(launches(claude), [LAUNCH]);
    assert.deepEqual(claude.seen.fetched, [], 'no request reached the port of another account');
    assert.match(listed.deny, /does not answer/);
});

test('a server whose port another account took since the mod adopted it is no longer called: the tools say so', async () => {
    const { dir } = await session();
    const claude = await mod(dir, { uid: '1000' });
    claude.hold(listening(port, 4242));
    const before = claude.seen.fetched.length;

    const listed = await claude.tool('list_open_threads');

    assert.match(listed.deny, /another account/);
    assert.equal(claude.seen.fetched.length, before);
});

test('over SSH, /review-local launches no browser, whose argv would show the token to every account, and prints the URL', async () => {
    const { dir, id } = await session([]);
    const claude = await mod(dir, { env: { SSH_CONNECTION: '10.0.0.1 51000 10.0.0.2 22' } });

    const command = await claude.fire('command.run', { command: 'review-local', args: 'browser' });

    assert.ok(!claude.seen.run.some(argv => argv.some(arg => arg.includes(`/s/${id}`))), JSON.stringify(claude.seen.run));
    assert.match(command.text, new RegExp(`/s/${id}#token=`));
});

test('a corrupt endpoint file is no server: the mod still registers its tools, and starts a server', async () => {
    const claude = await mod(repo({ 'a.txt': 'a\n' }), { endpointText: '{"port":' });
    await until(() => launches(claude).length);

    assert.deepEqual(launches(claude), [LAUNCH]);
    assert.equal(claude.seen.tools.length, 3);
});

test('a launch of an earlier registration of the module neither probes nor adopts the endpoint it reads once the module registered again', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    // The first registration launches a server that never shows, and waits between its probes.
    const first = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: await nobody(), sleep: () => held });
    await until(() => launches(first).length);
    const { version } = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    const other = await impostor((_, res) => res.end(JSON.stringify({ app: 'claude-reviews', version })));
    // The second registration writes an endpoint that names another server: the probes of the first must leave it alone.
    const second = await mod(repo({ 'a.txt': 'a\n' }), { serverPort: other.port });
    await second.settle();

    release();
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.deepEqual(other.paths, ['GET /api/health'], 'only the second registration probed it');
});
