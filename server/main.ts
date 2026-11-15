import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { addMessage, approve, bases, checkPlacement, chooseBase, currentTree, exclusive, file, findSession, getSession, httpError, listSessions, markViewed, openSession, openThread, placed, replies, resolve, send, sessionDiff, show, treeLines } from './sessions.ts';

const UI = join(import.meta.dirname, '..', 'ui');
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
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
export function start(port: number, notify = (argv: string[]) => { execFile(argv[0], argv.slice(1), () => {}); }): Promise<Server> {
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
        try {
            if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { app: 'claude-reviews', version });
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
                return json(res, 200, await placed(answer, url.searchParams).catch(error => { if (req.method === 'GET') throw error; return answer; }));
            }
            // The URL parser already resolves "..", so the joined path stays inside UI.
            // The page of a session, /s/<id>, is the same page as /, which reads the id from its URL.
            const path = join(UI, url.pathname === '/' || /^\/s\/[0-9a-f]{16}$/.test(url.pathname) ? 'index.html' : url.pathname);
            const type = TYPES[extname(path)];
            if (!type) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
            const content = await readFile(path);
            res.writeHead(200, { 'content-type': type }).end(content);
        } catch (error) {
            const { code, status } = error as NodeJS.ErrnoException & { status?: number };
            json(res, status ?? (code === 'ENOENT' ? 404 : 500), { error: (error as Error).message });
        }
    });
    // Past the 30 s the JDK HTTP client of PhpStorm keeps an idle connection: closed by the server first, it would lose the answer of a write sent on it.
    server.keepAliveTimeout = 65_000;
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

/** The session API; its contract is written in CLAUDE.md. */
async function route(method: string, { pathname: path, searchParams }: URL, body: Record<string, unknown>, notify: (argv: string[]) => void): Promise<unknown> {
    // Each takes the queue of the writes itself, only when it writes: the mod's 2 s poll must not wait for a long Send.
    if (path === '/api/sessions' && method === 'GET') return searchParams.has('worktree') ? findSession(searchParams.get('worktree'), searchParams.has('claude')) : listSessions();
    if (path === '/api/sessions' && method === 'POST') return openSession(body.worktree);
    const [, id, action = '', thread, threadAction = ''] = path.match(/^\/api\/sessions\/([0-9a-f]{16})(?:\/(diff|tree|file|lines|bases|base|threads|send|approve|viewed|show|turn-complete))?(?:\/(\d+)\/(messages|resolve|unresolve))?$/) ?? [];
    switch (id && `${method} ${action}/${threadAction}`) {
        case 'GET /': return getSession(id);
        case 'GET diff/': return sessionDiff(id, searchParams);
        case 'GET tree/': return currentTree(id);
        case 'GET lines/': return treeLines(id, searchParams);
        case 'GET file/': return file(id, searchParams.get('object'), searchParams.get('path'));
        case 'GET bases/': return bases(await getSession(id));
        case 'POST base/': return exclusive(() => chooseBase(id, body.base));
        case 'POST threads/': return exclusive(() => openThread(id, body));
        case 'POST threads/messages': return exclusive(() => addMessage(id, Number(thread), body));
        case 'POST threads/resolve': return exclusive(() => resolve(id, Number(thread)));
        case 'POST threads/unresolve': return exclusive(() => resolve(id, Number(thread), false));
        case 'POST send/': return exclusive(() => send(id, body.tree, body.threads));
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
    const server = await start(Number(process.env.CLAUDE_REVIEWS_PORT ?? 7778));
    console.log(`claude-reviews listening on http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
