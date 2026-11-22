import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { addMessage, approve, bases, checkPlacement, chooseBase, closedSessions, currentTree, dataDir, deleteMessage, editMessage, exclusive, file, findSession, getSession, httpError, inbox, listSessions, markViewed, openSession, openThread, placed, replies, resolve, send, sessionDiff, setReadonly, show, treeLines } from './sessions.ts';

const UI = join(import.meta.dirname, '..', 'ui');
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
};

const MAX_BODY = 1024 * 1024;

// The mod compares it with its own, and replaces a server of another version.
const { version } = JSON.parse(await readFile(join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** The command that shows a desktop notification: the only code proper to a platform. */
export function notification(text: string, platform = process.platform): string[] {
    return platform === 'darwin'
        ? ['osascript', '-e', `display notification ${JSON.stringify(text)} with title "claude-reviews"`]
        : ['notify-send', 'claude-reviews', text];
}

/** The output of a command, trimmed, or null when it fails, prints nothing, or takes more than 2 s. */
function output(file: string, args: string[]): Promise<string | null> {
    return new Promise(resolve => execFile(file, args, { timeout: 2000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null)));
}

/** `output` of a command, kept once it answers; a failure is kept 60 s, then the next call runs the command again. */
function remembered(file: string, args: string[]): () => Promise<string | null> {
    let answer: Promise<string | null> | undefined;
    let until = Infinity;
    return () => {
        if (!answer || Date.now() >= until) {
            until = Infinity;
            answer = output(file, args).then(value => {
                if (value === null) until = Date.now() + 60_000;
                return value;
            });
        }
        return answer;
    };
}

/** `notify` runs a notification command; the tests record it instead. */
export type ServerWithToken = Server & { token: string };

/** Whether the request carries the server's token, in `Authorization: Bearer`; the clients read it from the endpoint file, the UI from `#token=`. */
function authorized(req: IncomingMessage, token: string): boolean {
    const header = req.headers.authorization;
    const bearer = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(token);
    // timingSafeEqual needs equal lengths; it is only reached for a request that already passed the Host guard.
    return bearer.length === expected.length && timingSafeEqual(bearer, expected);
}

export function start(port: number, notify = (argv: string[]) => { execFile(argv[0], argv.slice(1), () => {}); }): Promise<ServerWithToken> {
    // One secret per server, per account: another account cannot read /diff, inject in a thread or shut it down without it.
    const token = randomBytes(32).toString('hex');
    // Kept: gh can take a second, and the login does not change while the server runs.
    // ponytail: a login or name changed while the server runs shows after its restart only.
    // The avatar is on github.com, so the login is that of github.com, whichever host gh has active.
    const githubLogin = remembered('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
    const userName = remembered('git', ['config', '--global', '--includes', 'user.name']);
    const server = createServer(async (req, res) => {
        const { port } = server.address() as AddressInfo;
        // Against DNS rebinding: a page on another name resolving to 127.0.0.1 must not read the diffs.
        if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
            return json(res, 403, { error: `Host ${req.headers.host} is not this server` });
        }
        const url = new URL(req.url!, 'http://127.0.0.1');
        // Another site cannot read the answer, but could still make git run on a path of its choice;
        // the page itself runs no git, so a link from another site still opens it.
        const site = req.headers['sec-fetch-site'];
        if (url.pathname.startsWith('/api/') && site !== undefined && site !== 'same-origin' && site !== 'none') {
            return json(res, 403, { error: `Sec-Fetch-Site ${site} is refused` });
        }
        // Against CSRF: a form cannot send JSON, and another page cannot either without a preflight, which no CORS header answers.
        // The mod sends no Origin, the page its own.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
            if (type !== 'application/json') return json(res, 415, { error: 'A write needs Content-Type: application/json' });
            const origin = req.headers.origin;
            if (origin !== undefined && origin !== `http://${req.headers.host}`) return json(res, 403, { error: `Origin ${origin} is refused` });
        }
        // The token guards every API route but health: another local account reaches the loopback port, but gets nothing without it.
        if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health' && !authorized(req, token)) {
            return json(res, 401, { error: 'unauthorized' });
        }
        try {
            if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { app: 'claude-reviews', version });
            if (url.pathname === '/api/inbox' && req.method === 'GET') return json(res, 200, await inbox(`http://${req.headers.host}`));
            if (url.pathname === '/api/me' && req.method === 'GET') {
                const [login, name] = await Promise.all([githubLogin(), userName()]);
                return json(res, 200, { login, name });
            }
            if (url.pathname === '/api/shutdown' && req.method === 'POST') {
                // Stops listening first, so a server started right after the answer gets the port.
                server.close();
                res.setHeader('connection', 'close');
                return json(res, 200, {});
            }
            if (url.pathname.startsWith('/api/sessions')) {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of req) if ((size += chunk.length) <= MAX_BODY) chunks.push(chunk);
                if (size > MAX_BODY) return json(res, 413, { error: `The body exceeds ${MAX_BODY} bytes` });
                let body;
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                } catch {}
                if (typeof body !== 'object' || body === null) return json(res, 400, { error: 'The body must be a JSON object' });
                checkPlacement(url.searchParams);
                const answer = await route(req.method!, url, body, notify);
                // A write recorded answers its success, even unplaced: a retry would record it twice, and the next poll places the threads.
                // A session closed because its worktree is gone has no code left to place its threads on.
                return json(res, 200, await placed(answer, url.searchParams).catch(error => {
                    if (req.method === 'GET' && !(answer as { approvedAt?: string | null }).approvedAt) throw error;
                    return answer;
                }));
            }
            // A link from another site may open a page, but not the session of a worktree of its choice, which runs git there.
            if (url.searchParams.has('worktree') && site !== undefined && site !== 'same-origin' && site !== 'none') {
                return json(res, 403, { error: `Sec-Fetch-Site ${site} cannot open the session of a worktree` });
            }
            // The URL parser already resolves "..", so the joined path stays inside UI.
            // The page of a session, /s/<id>, is the same page as /, which reads the id from its URL.
            const path = join(UI, url.pathname === '/' || /^\/s\/[0-9a-f]{16}$/.test(url.pathname) ? 'index.html' : url.pathname);
            const type = TYPES[extname(path)];
            if (!type) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
            const content = await readFile(path);
            // No other site may frame the page and click its buttons, and no script but the page's own runs in it.
            res.writeHead(200, { 'content-type': type, 'content-security-policy': "script-src 'self'; object-src 'none'; frame-ancestors 'none'" }).end(content);
        } catch (error) {
            const { code, status } = error as NodeJS.ErrnoException & { status?: number };
            json(res, status ?? (code === 'ENOENT' ? 404 : 500), { error: (error as Error).message });
        }
    });
    // Past the 30 s the JDK HTTP client of PhpStorm keeps an idle connection: closed by the server first, it would lose the answer of a write sent on it.
    server.keepAliveTimeout = 65_000;
    const withToken = Object.assign(server, { token });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(withToken));
    });
}

/** The file the clients read for the port and token of this account's server, in its data directory, 0600. */
function endpointPath(): string {
    return join(dataDir(), 'endpoint');
}

/** Whether a claude-reviews server still answers on `port`: the singleton check of listen(). */
async function alive(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok && (await res.json() as { app?: string }).app === 'claude-reviews';
    } catch {
        return false;
    }
}

/** The uids of the sockets listening on `port`, from the text of /proc/net/tcp and /proc/net/tcp6. */
export function listeners(text: string, port: number): number[] {
    const local = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    // Each line: sl, local address:port, remote address:port, state (0A when listening), queues, timer, retransmits, uid…
    return text.split('\n').map(line => line.trim().split(/\s+/))
        .filter(fields => fields[1]?.endsWith(local) && fields[3] === '0A')
        .map(fields => Number(fields[7]));
}

/** Whether another account than `uid` listens on `port`, as /proc/net/tcp tells every account; false without /proc (macOS), a machine of one account. */
async function foreign(port: number, uid: number | undefined): Promise<boolean> {
    if (uid === undefined) return false;
    const text = (await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(file => readFile(file, 'utf8').catch(() => '')))).join('\n');
    return listeners(text, port).some(owner => owner !== uid);
}

/**
 * Stops a server from before the token (0.6 and older) that an upgrade left on the legacy port: it serves the data directory to every account.
 * A server of this version answers an unknown session 401 without the token, and stays.
 */
async function stopLegacy(port: number, uid: number | undefined): Promise<void> {
    if (await foreign(port, uid) || !await alive(port)) return;
    const url = `http://127.0.0.1:${port}`;
    const unknown = await fetch(`${url}/api/sessions/0000000000000000`, { signal: AbortSignal.timeout(2000) }).then(res => res.status, () => 0);
    if (unknown !== 404) return;
    await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) }).catch(() => {});
}

/**
 * Starts the account's single server on an ephemeral port (or CLAUDE_REVIEWS_PORT), and writes its port and token to the endpoint file.
 * Defers to a server of this account already serving the data directory, so two Claude sessions do not run two servers on the same files.
 * `uid` is this account's, `legacy` the port where a server from before the token may still run.
 */
export async function listen({ notify, uid = process.getuid?.(), legacy = Number(process.env.CLAUDE_REVIEWS_PORT) || 7778 }: {
    notify?: (argv: string[]) => void; uid?: number; legacy?: number;
} = {}): Promise<ServerWithToken | null> {
    await mkdir(dataDir(), { recursive: true, mode: 0o700 });
    // An older version left the directory world-readable; tighten it.
    await chmod(dataDir(), 0o700).catch(() => {});
    // A corrupt file names no server.
    const named = await readFile(endpointPath(), 'utf8').then(text => (JSON.parse(text) as { port?: unknown }).port).catch(() => undefined);
    // Another account may take the port of a dead server, and answer as claude-reviews: only a listener of this account counts.
    // ponytail: two listen() within the same instant may both start; atomic session writes make this a rare lost-update, not corruption; add an O_EXCL lock if it bites.
    if (typeof named === 'number' && Number.isInteger(named) && !await foreign(named, uid) && await alive(named)) {
        console.log(`claude-reviews already serving on http://127.0.0.1:${named}`);
        return null;
    }
    await stopLegacy(legacy, uid);
    const server = await start(Number(process.env.CLAUDE_REVIEWS_PORT) || 0, notify);
    const port = (server.address() as AddressInfo).port;
    const file = endpointPath();
    await writeFile(`${file}.tmp`, JSON.stringify({ port, token: server.token }), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return server;
}

/** The session API; its contract is written in CLAUDE.md. */
async function route(method: string, { pathname: path, searchParams }: URL, body: Record<string, unknown>, notify: (argv: string[]) => void): Promise<unknown> {
    // Each takes the queue of the writes itself, only when it writes: the mod's 2 s poll must not wait for a long Send.
    if (path === '/api/sessions' && method === 'GET') {
        return searchParams.has('worktree') ? findSession(searchParams.get('worktree'), searchParams.has('claude'), searchParams.has('blocked')) : searchParams.has('closed') ? closedSessions() : listSessions();
    }
    if (path === '/api/sessions' && method === 'POST') return openSession(body.worktree);
    const [, id, action = '', thread, threadAction = '', index, messageAction = 'edit'] = path.match(
        /^\/api\/sessions\/([0-9a-f]{16})(?:\/(diff|tree|file|lines|bases|base|threads|send|approve|viewed|show|turn-complete))?(?:\/(\d+)\/(messages|resolve|unresolve|readonly)(?:\/(\d+)(?:\/(delete))?)?)?$/) ?? [];
    switch (id && `${method} ${action}/${threadAction}${index === undefined ? '' : `/${messageAction}`}`) {
        case 'GET /': return getSession(id);
        case 'GET diff/': return sessionDiff(id, searchParams);
        case 'GET tree/': return currentTree(id);
        case 'GET lines/': return treeLines(id, searchParams);
        case 'GET file/': return file(id, searchParams.get('object'), searchParams.get('path'));
        case 'GET bases/': return bases(await getSession(id));
        case 'POST base/': return exclusive(() => chooseBase(id, body.base));
        case 'POST threads/': return exclusive(() => openThread(id, body));
        case 'POST threads/messages': return exclusive(() => addMessage(id, Number(thread), body));
        case 'POST threads/messages/edit': return exclusive(() => editMessage(id, Number(thread), Number(index), body));
        case 'POST threads/messages/delete': return exclusive(() => deleteMessage(id, Number(thread), Number(index)));
        case 'POST threads/resolve': return exclusive(() => resolve(id, Number(thread)));
        case 'POST threads/unresolve': return exclusive(() => resolve(id, Number(thread), false));
        case 'POST threads/readonly': return exclusive(() => setReadonly(id, Number(thread), body.readonly));
        case 'POST send/': return exclusive(() => send(id, body));
        case 'POST viewed/': return exclusive(() => markViewed(id, body));
        case 'POST approve/': return exclusive(() => approve(id));
        case 'POST show/': return show(id);
        case 'POST turn-complete/': {
            const session = await getSession(id);
            notify(notification(replies(session)));
            return session;
        }
    }
    throw httpError(404, `No route for ${method} ${path}`);
}

if (import.meta.main) {
    const server = await listen();
    if (!server) process.exit(0);
    console.log(`claude-reviews listening on http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
