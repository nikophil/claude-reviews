import type { EngineInterface, Register } from 'claude-code';
import { due, forked, forkEnded, forking, forkPrompt, forks, idle, listeners, look, notified, prompt, resumed, sending, start, status, submitted, touched, turnEnded, turnStarted, type Seen, type Watch } from './watch.ts';

type Session = { id: string; sends: number; reanchoredOn?: { base: string; tree: string }; threads: { id: number; status: string | null; anchor: any; at?: { start: number; end: number } | null; messages: { author: string; body: string; date: string | null }[] }[] };

const SUGGESTION = 'A message of the user may hold a ```suggestion code block, the code the user proposes in place of the lines start to end of the thread, on side new: '
    + 'apply it to the working tree unless you disagree, then reply in the thread.';

const TOOLS = [
    {
        name: 'list_open_threads',
        description: 'Lists the claude-reviews threads of this worktree that are not resolved: those waiting for your reply (status waiting-for-claude) and those you answered last (status open), with their anchor and published messages. '
            + 'The old side of a thread is the base of the session, the branch or snapshot the user reviews, whose commit is base: read a file there with git show <base>:<file>; the new side is the working tree. '
            + 'start and end are the range reanchored on that base for side old, on the working tree for side new, and lines the lines the thread was opened on. '
            + 'outdated is true when those lines are no longer found: start and end are then the original range, and hunk the original diff excerpt, as unified diff (null if the lines were out of the diff). '
            + 'A thread with start and end at 0 is on the whole file, without lines, and outdated only once the file is gone. '
            + SUGGESTION,
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'reply_to_thread',
        description: `Replies in a claude-reviews thread, published at once. Reply in every thread waiting for you; change the code when a thread asks for it. ${SUGGESTION}`,
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'integer', description: 'The thread id, from list_open_threads' }, body: { type: 'string', description: 'Markdown' } },
            required: ['id', 'body'],
        },
    },
    {
        name: 'open_thread',
        description: 'Opens a claude-reviews thread on lines of a file of this worktree, or on the whole file without lines, only when the user asks you to review your diff or to open threads.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'The path from the top of the worktree' },
                side: { enum: ['old', 'new'], description: 'new for the working tree, old for the base of the session, the one list_open_threads gives' },
                lines: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2, description: '[start, end], 1-based and inclusive; left out for the whole file' },
                body: { type: 'string', description: 'Markdown' },
            },
            required: ['file', 'side', 'body'],
        },
    },
];

let base = '';
/** The token of this account's server, read from the endpoint file: every API call carries it, another account's server rejects it. */
let token = '';
/** The session's root at the last look, undefined while the mod is off: the Claude session did not start in a worktree. */
let root: string | undefined;
/** The worktree the mod follows: the root's, or the one Claude last wrote in or kept a cd to; undefined once the root left every worktree. */
let worktree: string | undefined;
/** The repository of the worktree (its common dir): Claude writing in another repository leaves the review where it is. */
let common: string | undefined;
/** The shell's directory at the last call of the main loop: a Bash call that changes it is a cd the shell kept. */
let shell = '';
/** The session Claude's tools write to: the last one listed or opened. An approved one refuses them. */
let session: string | undefined;
let watch = start;
/** Whether the first prompt of the Claude session entered, with the threads waiting for Claude. */
let greeted = false;
/** The status line on screen, undefined for none. */
let shown: string | undefined;
/** This account's uid, from `id -u`; '' when unknown, undefined before the first look. */
let uid: string | undefined;
/** How many times the module registered: a launch from an earlier registration stops its probes. */
let registered = 0;
/** The loops of the Claude session, '' the main one, else a subagent's id, that wait for my answer: a permission dialog, or a question. */
let blocked = new Set<string>();

const silent = () => `claude-reviews does not answer${base ? ` on ${base}` : ''}`;

/**
 * A call to the server; one that does not answer within 2 s, or not in JSON, comes back as status 0 and an error.
 * None reaches a port another account took since the mod adopted it: a squatter of a dead server's port must not feed Claude its threads.
 */
async function api($: EngineInterface, method: string, path: string, body?: object): Promise<{ status: number; body: any }> {
    const res = await call($, method, path, body);
    if (res.status !== 0) return res;
    // A newer mod of another Claude session restarts the server on another port, and writes it to the endpoint file.
    const ep = await endpoint($);
    if (!ep || `http://127.0.0.1:${ep.port}` === base) return res;
    adopt(ep);
    return call($, method, path, body);
}

async function call($: EngineInterface, method: string, path: string, body?: object): Promise<{ status: number; body: any }> {
    if (!base) return { status: 0, body: { error: silent() } };
    // ponytail: the mod starts a server of its own at session.start only; start one from the poll if squatters ever show mid-session.
    if (await foreign($, Number(new URL(base).port))) return { status: 0, body: { error: `${base} is held by another account: start the Claude session again for a server of your own` } };
    const auth = token ? { authorization: `Bearer ${token}` } : {};
    const init = body === undefined
        ? { method, headers: auth }
        : { method, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) };
    try {
        const res = await within($, 2000, $.http.fetch(`${base}${path}`, init));
        return { status: res.status, body: JSON.parse(res.text) };
    } catch {
        return { status: 0, body: { error: silent() } };
    }
}

// These run from the plugin's root, not the worktree under review: a relative entry of the PATH must not run one of its scripts.

/** The PhpStorm launcher: `phpstorm` on the PATH, else the script of JetBrains Toolbox, on Linux or macOS; '' without one. */
async function phpstorm($: EngineInterface): Promise<string> {
    const found = await $.process.run(['/bin/sh', '-c', 'for l in "$(command -v phpstorm)" "$HOME/.local/share/JetBrains/Toolbox/scripts/phpstorm" "$HOME/Library/Application Support/JetBrains/Toolbox/scripts/phpstorm"; do [ -x "$l" ] && echo "$l" && break; done', 'phpstorm-launcher'], { cwd: $.plugin.root });
    return found.stdout.trim();
}

/** The VS Code launcher: `code` on the PATH; '' without one. */
async function vscode($: EngineInterface): Promise<string> {
    const found = await $.process.run(['/bin/sh', '-c', 'command -v code', 'vscode-launcher'], { cwd: $.plugin.root });
    return found.stdout.trim();
}

/** Runs `argv` detached, its output dropped; it outlives this Claude session, as the server does. */
async function detach($: EngineInterface, argv: string[]): Promise<void> {
    await $.process.run(['/bin/sh', '-c', `trap '' HUP; nohup "$@" >/dev/null 2>&1 </dev/null &`, 'claude-reviews', ...argv], { cwd: $.plugin.root });
}

/** Whether another account listens on `port`, as /proc/net/tcp tells every account; false without /proc (macOS) or uid, a machine of one account. */
async function foreign($: EngineInterface, port: number): Promise<boolean> {
    uid ??= (await $.process.run(['id', '-u'], { cwd: $.plugin.root })).stdout.trim();
    if (!uid) return false;
    // cat rather than $.fs.read: a file of /proc has no size to read up to. tcp6 may be missing, tcp still prints.
    const { stdout } = await $.process.run(['cat', '/proc/net/tcp', '/proc/net/tcp6'], { cwd: $.plugin.root });
    return listeners(stdout, port).some(owner => String(owner) !== uid);
}

/** The top of the worktree `dir` lies in and its repository, undefined outside one, or for a directory gone. */
async function top($: EngineInterface, dir: string): Promise<{ top: string; common: string } | undefined> {
    const found = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: dir }).catch(() => null);
    if (found?.exitCode !== 0) return undefined;
    const [top, common] = found.stdout.trim().split('\n');
    return { top, common };
}

/** Moves to the worktree `next`: another worktree starts afresh, as a Claude session starting there. */
function enter(next: { top: string; common: string } | undefined): void {
    // The turn running goes on in the other worktree: a Send there still goes to a fork.
    if (next?.top !== worktree) [worktree, common, session, watch, greeted] = [next?.top, next?.common, undefined, { ...start, busy: watch.busy }, false];
}

/** Follows the worktree of the repository a call of the main loop wrote in, or kept a cd to, as when the root moves. */
async function moved($: EngineInterface, e: { tool: string; [argument: string]: unknown }, failed: boolean): Promise<void> {
    const cwd = await $.session.cwd();
    // The root, where the shell returns after a cd it does not keep.
    const dir = touched(e, { shell, cwd, home: root!, failed });
    shell = cwd;
    const found = dir && await top($, dir);
    if (found && found.common === common) enter(found);
}

/** Follows the session's root, which /cd and EnterWorktree move. */
async function follow($: EngineInterface): Promise<void> {
    if (root === undefined) return;
    const now = await $.session.root();
    if (now === root) return;
    root = now;
    enter(await top($, now));
}

/** The open session of the worktree, null when the server says it has none or out of a worktree, or why the server did not say. */
async function find($: EngineInterface, query = ''): Promise<{ open: Session | null } | { error: string }> {
    if (!worktree) return { open: null };
    // ponytail: each look makes the server run git rev-parse, every 2 s per Claude session; cache the top of a worktree if it shows.
    // `claude` tells the server a Claude session runs in the worktree, which the clients show instead of waiting for it; `blocked`, that it waits for my answer.
    const res = await api($, 'GET', `/api/sessions?worktree=${encodeURIComponent(worktree)}&claude${blocked.size ? '&blocked' : ''}${query}`);
    if (res.status === 404) return { open: null };
    if (res.status === 200 && Array.isArray(res.body?.threads)) return { open: res.body };
    // A 200 without threads is not claude-reviews answering: it reads as no answer.
    return { error: res.status === 200 ? silent() : res.body?.error ?? silent() };
}

function seen(open: Session | null): Seen {
    return open && { id: open.id, sends: open.sends, waiting: open.threads.filter(thread => thread.status === 'waiting-for-claude').length };
}

// ponytail: two Claude sessions in one worktree both wake and both reply; the brief accepts it, as Orca rarely does it.
function apply($: EngineInterface, next: Watch): void {
    watch = next;
    if (!due(watch)) return;
    if (forks(watch)) fork($);
    else submit($);
}

function submit($: EngineInterface): void {
    watch = sending(watch);
    const sent = watch.submitting;
    // A watch started afresh for another worktree meanwhile is not this prompt's.
    const settled = (dropped: boolean) => { if (watch.submitting === sent) apply($, submitted(watch, dropped)); };
    // Never awaited: it resolves only once the session is idle and the prompt opened its turn.
    $.prompt.submit({ text: prompt(watch.waiting) }).then(result => settled(result.drop !== undefined), () => settled(true));
}

/** Answers in a fork of the Claude session, in the background: a prompt would wait for the end of the turn Claude works on. */
function fork($: EngineInterface): void {
    watch = forking(watch);
    const started = watch.forking;
    const spawned = (result: { agentId?: string; deny?: string }) => {
        // A watch started afresh for another worktree meanwhile is not this fork's.
        if (watch.forking !== started) return;
        watch = forked(watch, result.agentId);
        if (result.agentId) return;
        $.ui.log(`claude-reviews: no fork to answer the threads (${result.deny}), they wait for the end of the turn`);
        if (due(watch)) submit($);
    };
    $.agent.spawn({ subagentType: 'fork', description: 'Answer the claude-reviews threads', prompt: forkPrompt(watch.waiting) })
        .then(spawned, (error: Error) => spawned({ deny: error.message }));
}

/** The call, or a rejection once `ms` passed without an answer: a port may accept and never answer. */
function within<T>($: EngineInterface, ms: number, call: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = $.clock.after(ms, () => reject(new Error(`${base} accepts, but does not answer within ${ms} ms`)));
        call.then(value => (timer.cancel(), resolve(value)), error => (timer.cancel(), reject(error)));
    });
}

/** Whether version `a` comes before `b`, both major.minor.patch. */
function older(a: unknown, b: string): boolean {
    const [x, y] = [String(a), b].map(version => version.split('.').map(Number));
    const i = y.findIndex((n, i) => n !== x[i]);
    return i !== -1 && !(x[i] > y[i]);
}

/** The data directory of this account, where the server writes the endpoint file. */
async function dataDir($: EngineInterface): Promise<string> {
    return `${await $.env.get('XDG_DATA_HOME') || `${await $.env.get('HOME')}/.local/share`}/claude-reviews`;
}

/**
 * The port and token of this account's server, from its endpoint file; null when no server wrote it, when it is corrupt,
 * or when another account listens on its port: a squatter of a dead server's port gets neither a call nor the trust of a prompt.
 */
async function endpoint($: EngineInterface): Promise<{ port: number; token: string } | null> {
    const ep = await $.fs.read(`${await dataDir($)}/endpoint`).then(text => JSON.parse(text)).catch(() => null);
    if (!Number.isInteger(ep?.port) || typeof ep?.token !== 'string') return null;
    return await foreign($, ep.port) ? null : ep;
}

/** Adopts the server the endpoint `ep` names, for every later call. */
function adopt(ep: { port: number; token: string }): void {
    [base, token] = [`http://127.0.0.1:${ep.port}`, ep.token];
}

/**
 * Starts this account's server when its endpoint names no server, or an older one; a newer one is used as it is,
 * or two Claude sessions of different versions would stop each other's server. The server picks its own port and token.
 */
async function serve($: EngineInterface, ep: { port: number; token: string } | null): Promise<void> {
    if (ep) {
        // base and token are already adopted at session.start; snapshot them (a module registered again changes them), and probe health first,
        // synchronously recorded, so a poll running meanwhile does not see this health as its own request.
        const server = base;
        const bearer = token;
        const health = await within($, 2000, $.http.fetch(`${server}/api/health`).catch(() => null));
        if (health) {
            let app;
            try { app = JSON.parse(health.text); } catch {}
            if (app?.app !== 'claude-reviews') throw new Error(`${server} answers, but is not claude-reviews; no server started`);
            const { version } = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`));
            if (!older(app.version, version)) return;
            const stopped = await within($, 2000, $.http.fetch(`${server}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: '{}' }));
            if (stopped.status !== 200) throw new Error(`${server} did not stop its version ${app.version}: ${stopped.status}`);
        }
    }
    const data = await dataDir($);
    // umask 077 keeps the data directory and server.log private; nohup and the redirections let the server outlive this Claude session.
    // ponytail: server.log grows without bound; rotate it if it ever gets big.
    await $.process.run(['/bin/sh', '-c', `umask 077; mkdir -p "$2"; trap '' HUP; nohup node "$1" >> "$2/server.log" 2>&1 </dev/null &`,
        'claude-reviews', `${$.plugin.root}/server/main.ts`, data], { cwd: $.plugin.root });
    // A server that fails at once, on an old node or a port taken, would leave every call unanswered without a word.
    const mine = registered;
    for (let probe = 0; probe < 10; probe++) {
        await $.clock.sleep(500);
        const started = await endpoint($);
        // The module registered again since, and starts its own server: this launch must neither probe nor adopt the endpoint it now reads.
        if (registered !== mine) return;
        if (started && await within($, 2000, $.http.fetch(`http://127.0.0.1:${started.port}/api/health`)).then(res => res.status === 200, () => false)) {
            return adopt(started);
        }
    }
    // ponytail: $.fs.read rejects a log over 4 MiB, which then comes without its last lines.
    const tail = await $.fs.read(`${data}/server.log`).then(text => `:\n${text.trimEnd().split('\n').slice(-10).join('\n')}`, () => '');
    throw new Error(`the server did not start within 5 s; see ${data}/server.log${tail}`);
}

/** Opens a thread in the session Claude writes to, or in the open one; an approved session gives way to a new one, as #5 says. */
async function openThread($: EngineInterface, input: { file: string; side: string; lines?: number[]; body: string }): Promise<{ result: string } | { deny: string }> {
    for (const retry of [false, true]) {
        if (!session) {
            const opened = await api($, 'POST', '/api/sessions', { worktree });
            if (opened.status !== 200) return { deny: opened.body.error };
            session = opened.body.id as string;
        }
        const res = await api($, 'POST', `/api/sessions/${session}/threads`, {
            author: 'claude', path: input.file, side: input.side, start: input.lines?.[0] ?? 0, end: input.lines?.at(-1) ?? 0, body: input.body,
        });
        if (res.status === 200) return { result: `Opened thread ${res.body.threads.at(-1).id}` };
        if (res.body.error !== 'session approved' || retry) return { deny: res.body.error };
        session = undefined;
    }
    return { deny: 'unreachable' };
}

/** A diff hunk as unified diff text, as the model reads diffs; null for an Anchor out of the diff. */
function excerpt(hunk: { header: string; lines: { type: 'context' | 'add' | 'del' | 'note'; text: string }[] } | null): string | null {
    return hunk && [hunk.header, ...hunk.lines.map(line => ({ context: ' ', add: '+', del: '-', note: '\\ ' })[line.type] + line.text)].join('\n');
}

// ponytail: the matchers spell the plugin's name, local-reviews; renaming the plugin means renaming them.
export const register: Register = on => {
    // Each register starts afresh, as a reloaded module does: the node tests register it several times.
    [base, token, root, worktree, common, shell, session, watch, greeted, shown, uid, blocked] = ['', '', undefined, undefined, undefined, '', undefined, start, false, undefined, undefined, new Set()];
    registered++;

    // Registered first, so that it holds every tool call, this mod's own included: a call that waited for my answer ends with it, run or refused.
    // ponytail: any call ending in a loop ends that loop's wait, even one that ran beside the call still asking; key the wait by call if parallel asks show.
    // It also follows the worktree Claude works in, once the call ran: a subagent's leads nowhere, one with a worktree of its own (isolation: worktree) writes where no review looks.
    on('tool.call', async ($, e, next) => {
        const loop = e.agentId ?? '';
        if (e.tool === 'AskUserQuestion') blocked.add(loop);
        let result;
        try {
            result = await next(e);
        } finally {
            blocked.delete(loop);
        }
        if (root !== undefined && e.agentId === undefined && result.deny === undefined) await moved($, e, !!result.isError);
        return result;
    });

    // Fires as the dialog opens; its next resolves once the settings hooks beneath answered, not the person.
    on('classic.PermissionRequest', async ($, e, next) => {
        const loop = e.agent_id ?? '';
        blocked.add(loop);
        const result = await next(e);
        // A settings hook that answers opens no dialog.
        if (result.decision) blocked.delete(loop);
        return result;
    });

    // ponytail: a Claude session that starts out of a worktree leaves the mod off, even once /cd takes it into one.
    on('session.start', async ($, e, next) => {
        enter(await top($, e.cwd));
        if (!worktree) return next(e);
        [root, shell] = [e.cwd, e.cwd];
        // The endpoint file, if a server already wrote it, so the poll and the first prompt have a server to call before serve() returns.
        const ep = await endpoint($);
        if (ep) adopt(ep);
        for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false });
        await $.command.register({ name: 'review-local', description: 'Opens the claude-reviews session of this worktree in PhpStorm, VS Code or the browser: phpstorm, vscode, browser, or a question', immediate: true });
        // Not awaited: a poll before the server is ready fails, and leaves the watch as it is.
        serve($, ep).catch(error => $.ui.log(`claude-reviews: ${(error as Error).message}`));
        // ponytail: an interval the engine ends (a refused period) is not armed again; re-arm at turn.complete if wakes go missing.
        $.clock.every(2000, async () => {
            await follow($);
            const found = await find($);
            if ('open' in found) apply($, look(watch, seen(found.open)));
            if (status(watch) !== shown) $.ui.status(shown = status(watch));
        });
        return next(e);
    });

    // The first prompt carries the threads waiting, as context: prompt.context would reach subagents too,
    // and cc-plugin-sec-default passes it by on Team and Enterprise accounts.
    on('prompt.submit', async ($, e, next) => {
        await follow($);
        if (!worktree) return next(e);
        const ours = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name;
        if (ours) greeted = true;
        else apply($, resumed(watch));
        if (greeted || e.isMeta || e.command) return next(e);
        // ponytail: a /clear starts a conversation that gets no count; reset greeted at session.end if it matters.
        // ponytail: while the server does not answer, each prompt waits for it, up to 2 s; stop asking after a few if it shows.
        const found = await find($);
        const waiting = 'open' in found && seen(found.open)?.waiting;
        const result = await next(waiting ? { ...e, context: [...(e.context ?? []), prompt(waiting)] } : e);
        // A count the server could not give waits for the next prompt.
        if (result.drop === undefined && 'open' in found) greeted = true;
        return result;
    });

    on('turn.start', ($, e, next) => {
        if (worktree && e.agentId === undefined) apply($, turnStarted(watch));
        return next(e);
    });

    on('turn.complete', async ($, e, next) => {
        if (!worktree) return next(e);
        if (e.agentId !== undefined) {
            if (e.agentId === watch.forking?.agent) {
                const done = forkEnded(watch, e.reason === 'answer');
                // A Send held while the fork ran goes to a fork again, or to a prompt once Claude is idle.
                apply($, done.watch);
                if (done.session) void api($, 'POST', `/api/sessions/${done.session}/turn-complete`, {});
            }
            return next(e);
        }
        watch = idle(watch);
        // A turn interrupted (Esc) or ended on an error is not relaunched.
        if (e.reason === 'answer') {
            const found = await find($);
            if ('open' in found) apply($, turnEnded(watch, seen(found.open)));
        }
        // Spent even by a turn interrupted or ended on an error, which notifies nothing: Claude may not have replied.
        const done = notified(watch);
        watch = done.watch;
        // Not awaited: the server notifies on its own time.
        if (done.session && e.reason === 'answer') void api($, 'POST', `/api/sessions/${done.session}/turn-complete`, {});
        return next(e);
    });

    on('tool.call', { tool: 'mcp__local-reviews__list_open_threads' }, async $ => {
        await follow($);
        // Placed on the base of the session and the working tree: an Outdated thread comes with its original diff excerpt instead.
        const found = await find($, '&reanchor');
        if ('error' in found) return { deny: found.error };
        const { open } = found;
        session = open?.id;
        const threads = (open?.threads ?? []).filter(thread => thread.status === 'waiting-for-claude' || thread.status === 'open');
        // A tool of a mod answers text: the model reads the threads as JSON.
        return {
            result: JSON.stringify({
                base: open?.reanchoredOn?.base ?? null,
                threads: threads.map(({ id, status, anchor, at, messages }) => ({
                    id, status, outdated: !at, file: anchor.path, side: anchor.side, start: (at ?? anchor).start, end: (at ?? anchor).end, lines: anchor.lines,
                    ...(!at && { hunk: excerpt(anchor.hunk) }),
                    messages: messages.filter(message => message.date).map(({ author, body, date }) => ({ author, body, date })),
                })),
            }, null, 2),
        };
    });

    on('tool.call', { tool: 'mcp__local-reviews__reply_to_thread' }, async ($, e: any) => {
        if (!Number.isInteger(e.id) || e.id < 1) return { deny: 'id must be a positive integer, the id of a thread from list_open_threads' };
        await follow($);
        if (!session) {
            const found = await find($);
            if ('error' in found) return { deny: found.error };
            session = found.open?.id;
        }
        if (!session) return { deny: 'No open claude-reviews session for this worktree' };
        const replied = session;
        const res = await api($, 'POST', `/api/sessions/${replied}/threads/${e.id}/messages`, { author: 'claude', body: e.body });
        // An approved session will never wait for Claude again; another session the mod watches is left alone.
        if (res.body.error === 'session approved' && watch.session === replied) apply($, look(watch, null));
        return res.status === 200 ? { result: `Replied in thread ${e.id}` } : { deny: res.body.error };
    });

    on('tool.call', { tool: 'mcp__local-reviews__open_thread' }, async ($, e: any) => {
        await follow($);
        return openThread($, e);
    });

    on('command.run', { command: 'review-local' }, async ($, e) => {
        await follow($);
        const opened = await api($, 'POST', '/api/sessions', { worktree });
        if (opened.status !== 200) return { text: `claude-reviews: ${opened.body.error}` };
        session = opened.body.id as string;
        // The token lets the browser authenticate; it rides in the fragment, which no request carries, and the UI drops it from the address bar.
        const url = `${base}/s/${session}#token=${token}`;
        const arg = e.args.trim().toLowerCase();
        const ides = arg === 'browser' ? [] : [{ name: 'PhpStorm', arg: 'phpstorm', launcher: await phpstorm($) }, { name: 'VS Code', arg: 'vscode', launcher: await vscode($) }];
        const found = ides.filter(ide => ide.launcher);
        const asked = !arg && found.length > 0;
        // A label, or the text typed under Other, in any case.
        const where = asked ? (await $.ui.ask('Where to open the review?', { options: [...found.map(ide => ide.name), 'Browser'], header: 'Review' }).catch(() => '')).trim().toLowerCase() : arg;
        const ide = ides.find(ide => where === ide.arg || where === ide.name.toLowerCase());
        if (ide?.launcher) {
            // The request first: the IDE shows the review at its first poll, even in a project the launcher is opening.
            const shown = await api($, 'POST', `/api/sessions/${session}/show`, {});
            if (shown.status !== 200) return { text: `claude-reviews: ${shown.body.error}` };
            await detach($, [ide.launcher, worktree!]);
            return { text: `claude-reviews: opened in ${ide.name}, ${url}` };
        }
        // Over SSH no browser runs on this machine, and a launcher's argv would show the token to every account (/proc/<pid>/cmdline, ps): the URL is only printed.
        const ssh = !!(await $.env.get('SSH_CONNECTION') || await $.env.get('SSH_CLIENT') || await $.env.get('SSH_TTY'));
        // Without a question, the browser, also for an IDE without its launcher; a dismissed question opens nothing.
        if (!ssh && (!asked || where === 'browser' || ide)) await detach($, ['/bin/sh', '-c', 'if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"; else open "$1"; fi', 'claude-reviews', url]);
        return { text: ide ? `claude-reviews: ${ide.name} launcher not found, opened in the browser, ${url}` : `claude-reviews: ${url}` };
    });
};
