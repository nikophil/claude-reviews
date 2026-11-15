import type { EngineInterface, Register } from 'claude-code';
import { due, look, notified, prompt, resumed, sending, start, submitted, turnEnded, type Seen, type Watch } from './watch.ts';

type Session = { id: string; sends: number; threads: { id: number; status: string | null; anchor: any; at?: { start: number; end: number } | null; messages: { author: string; body: string; date: string | null }[] }[] };

const TOOLS = [
    {
        name: 'list_open_threads',
        description: 'Lists the claude-reviews threads of this worktree that are not resolved: those waiting for your reply and those awaiting the user, with their anchor and published messages. '
            + 'start and end are the range reanchored on HEAD and the working tree, and lines the lines the thread was opened on. '
            + 'outdated is true when those lines are no longer found: start and end are then the original range, and hunk the original diff excerpt, as unified diff (null if the lines were out of the diff).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'reply_to_thread',
        description: 'Replies in a claude-reviews thread, published at once. Reply in every thread waiting for you; change the code when a thread asks for it.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'integer', description: 'The thread id, from list_open_threads' }, body: { type: 'string', description: 'Markdown' } },
            required: ['id', 'body'],
        },
    },
    {
        name: 'open_thread',
        description: 'Opens a claude-reviews thread on lines of a file of this worktree, only when the user asks you to review your diff or to open threads.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'The path from the top of the worktree' },
                side: { enum: ['old', 'new'], description: 'new for the working tree, old for HEAD' },
                lines: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2, description: '[start, end], 1-based and inclusive' },
                body: { type: 'string', description: 'Markdown' },
            },
            required: ['file', 'side', 'lines', 'body'],
        },
    },
];

let base = 'http://127.0.0.1:7778';
let worktree: string | undefined;
/** The session Claude's tools write to: the last one listed or opened. An approved one refuses them. */
let session: string | undefined;
let watch = start;
/** Whether the first prompt of the Claude session entered, with the threads waiting for Claude. */
let greeted = false;

const silent = () => `claude-reviews does not answer on ${base}`;

/** A call to the server; one that does not answer within 2 s, or not in JSON, comes back as status 0 and an error. */
async function api($: EngineInterface, method: string, path: string, body?: object): Promise<{ status: number; body: any }> {
    const init = body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    try {
        const res = await within($, 2000, $.http.fetch(`${base}${path}`, init));
        return { status: res.status, body: JSON.parse(res.text) };
    } catch {
        return { status: 0, body: { error: silent() } };
    }
}

/** The open session of the worktree, null when the server says it has none, undefined when the server fails to say. */
async function find($: EngineInterface, query = ''): Promise<Session | null | undefined> {
    // ponytail: each look makes the server run git rev-parse, every 2 s per Claude session; cache the top of a worktree if it shows.
    // `claude` tells the server a Claude session runs in the worktree, which the clients show instead of waiting for it.
    const res = await api($, 'GET', `/api/sessions?worktree=${encodeURIComponent(worktree!)}&claude${query}`);
    return res.status === 200 ? res.body : res.status === 404 ? null : undefined;
}

function seen(open: Session | null): Seen {
    return open && { id: open.id, sends: open.sends, waiting: open.threads.filter(thread => thread.status === 'waiting-for-claude').length };
}

// ponytail: two Claude sessions in one worktree both wake and both reply; the brief accepts it, as Orca rarely does it.
function apply($: EngineInterface, next: Watch): void {
    watch = next;
    if (!due(watch)) return;
    watch = sending(watch);
    // Never awaited: it resolves only once the session is idle and the prompt opened its turn.
    $.prompt.submit({ text: prompt(watch.waiting) }).then(
        result => apply($, submitted(watch, result.drop !== undefined)),
        () => apply($, submitted(watch, true)),
    );
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

/**
 * Starts the server of this plugin when the port does not answer, or answers with an older version.
 * A newer one is used as it is, or two Claude sessions of different versions would stop each other's server.
 */
async function serve($: EngineInterface): Promise<void> {
    const health = await within($, 2000, $.http.fetch(`${base}/api/health`).catch(() => null));
    if (health) {
        let app;
        try { app = JSON.parse(health.text); } catch {}
        if (app?.app !== 'claude-reviews') throw new Error(`${base} answers, but is not claude-reviews; no server started`);
        const { version } = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`));
        if (!older(app.version, version)) return;
        const stopped = await within($, 2000, $.http.fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
        if (stopped.status !== 200) throw new Error(`${base} did not stop its version ${app.version}: ${stopped.status}`);
    }
    // nohup and the redirections let the server outlive this Claude session, and the call return at once.
    // ponytail: server.log grows without bound; rotate it if it ever gets big.
    await $.process.run(['/bin/sh', '-c',
        `d="\${XDG_DATA_HOME:-$HOME/.local/share}/claude-reviews"; mkdir -p "$d"; trap '' HUP; nohup node "$1" >> "$d/server.log" 2>&1 </dev/null &`,
        'claude-reviews', `${$.plugin.root}/server/main.ts`], { cwd: $.plugin.root });
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
            author: 'claude', path: input.file, side: input.side, start: input.lines?.[0], end: input.lines?.at(-1), body: input.body,
        });
        if (res.status === 200) return { result: `Opened thread ${res.body.threads.at(-1).id}` };
        if (res.body.error !== 'session approuvée' || retry) return { deny: res.body.error };
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
    [base, worktree, session, watch, greeted] = ['http://127.0.0.1:7778', undefined, undefined, start, false];

    on('session.start', async ($, e, next) => {
        const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: e.cwd });
        if (top.exitCode !== 0) return next(e);
        worktree = top.stdout.trim();
        base = `http://127.0.0.1:${await $.env.get('CLAUDE_REVIEWS_PORT') ?? 7778}`;
        for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false });
        await $.command.register({ name: 'review-local', description: 'Opens the claude-reviews session of this worktree in the browser', immediate: true });
        // Not awaited: a poll before the server is ready fails, and leaves the watch as it is.
        serve($).catch(error => $.ui.log(`claude-reviews: ${(error as Error).message}`));
        // ponytail: an interval the engine ends (a refused period) is not armed again; re-arm at turn.complete if wakes go missing.
        $.clock.every(2000, async () => {
            const open = await find($);
            if (open !== undefined) apply($, look(watch, seen(open)));
        });
        return next(e);
    });

    // The first prompt carries the threads waiting, as context: prompt.context would reach subagents too,
    // and cc-plugin-sec-default passes it by on Team and Enterprise accounts.
    on('prompt.submit', async ($, e, next) => {
        if (!worktree) return next(e);
        const ours = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name;
        if (ours) greeted = true;
        else apply($, resumed(watch));
        if (greeted || e.isMeta || e.command) return next(e);
        // ponytail: a /clear starts a conversation that gets no count; reset greeted at session.end if it matters.
        const waiting = seen((await find($)) ?? null)?.waiting;
        const result = await next(waiting ? { ...e, context: [...(e.context ?? []), prompt(waiting)] } : e);
        if (result.drop === undefined) greeted = true;
        return result;
    });

    on('turn.start', ($, e, next) => {
        if (worktree && e.agentId === undefined) apply($, resumed(watch));
        return next(e);
    });

    on('turn.complete', async ($, e, next) => {
        if (!worktree || e.agentId !== undefined) return next(e);
        // A turn interrupted (Esc) or ended on an error is not relaunched.
        if (e.reason === 'answer') {
            const open = await find($);
            if (open !== undefined) apply($, turnEnded(watch, seen(open)));
        }
        const done = notified(watch);
        watch = done.watch;
        // Not awaited: the server notifies on its own time.
        if (done.session) void api($, 'POST', `/api/sessions/${done.session}/turn-complete`, {});
        return next(e);
    });

    on('tool.call', { tool: 'mcp__local-reviews__list_open_threads' }, async $ => {
        // Placed on HEAD and the working tree: an Outdated thread comes with its original diff excerpt instead.
        const open = await find($, '&reanchor');
        if (open === undefined) return { deny: silent() };
        session = open?.id;
        const threads = (open?.threads ?? []).filter(thread => thread.status === 'waiting-for-claude' || thread.status === 'awaiting-you');
        // A tool of a mod answers text: the model reads the threads as JSON.
        return {
            result: JSON.stringify({
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
        if (!session) {
            const open = await find($);
            if (open === undefined) return { deny: silent() };
            session = open?.id;
        }
        if (!session) return { deny: 'No open claude-reviews session for this worktree' };
        const replied = session;
        const res = await api($, 'POST', `/api/sessions/${replied}/threads/${e.id}/messages`, { author: 'claude', body: e.body });
        // An approved session will never wait for Claude again; another session the mod watches is left alone.
        if (res.body.error === 'session approuvée' && watch.session === replied) apply($, look(watch, null));
        return res.status === 200 ? { result: `Replied in thread ${e.id}` } : { deny: res.body.error };
    });

    on('tool.call', { tool: 'mcp__local-reviews__open_thread' }, ($, e: any) => openThread($, e));

    on('command.run', { command: 'review-local' }, async $ => {
        const opened = await api($, 'POST', '/api/sessions', { worktree });
        if (opened.status !== 200) return { text: `claude-reviews: ${opened.body.error}` };
        session = opened.body.id as string;
        const url = `${base}/s/${session}`;
        await $.process.run(['/bin/sh', '-c', 'if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"; else open "$1"; fi >/dev/null 2>&1 &', 'claude-reviews', url]);
        return { text: `claude-reviews: ${url}` };
    });
};
