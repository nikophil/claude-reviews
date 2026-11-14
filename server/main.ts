import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { diff } from './diff.ts';
import { addMessage, approve, getSession, httpError, openSession, openThread, resolve, send } from './sessions.ts';

const UI = join(import.meta.dirname, '..', 'ui');
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

const MAX_BODY = 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// ponytail: one queue for every session write keeps read-modify-write safe; per-session queues if writes ever wait on each other.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
}

export function start(port: number): Promise<Server> {
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
            if (url.pathname === '/api/diff') {
                // ponytail: the worktree comes from the URL until the UI moves to /api/sessions/<id>/diff.
                const worktree = url.searchParams.get('worktree');
                if (!worktree || !existsSync(worktree)) return json(res, 400, { error: `No worktree at ${worktree}` });
                return json(res, 200, await diff(worktree));
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
                return json(res, 200, await route(req.method!, url.pathname, body));
            }
            // The URL parser already resolves "..", so the joined path stays inside UI.
            const path = join(UI, url.pathname === '/' ? 'index.html' : url.pathname);
            const type = TYPES[extname(path)];
            if (!type) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
            const content = await readFile(path);
            res.writeHead(200, { 'content-type': type }).end(content);
        } catch (error) {
            const { code, status } = error as NodeJS.ErrnoException & { status?: number };
            json(res, status ?? (code === 'ENOENT' ? 404 : 500), { error: (error as Error).message });
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

/** The session API; its contract is written in CLAUDE.md. */
async function route(method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    if (path === '/api/sessions' && method === 'POST') return exclusive(() => openSession(body.worktree));
    const [, id, action = '', thread, threadAction = ''] = path.match(/^\/api\/sessions\/([0-9a-f]{16})(?:\/(diff|threads|send|approve))?(?:\/(\d+)\/(messages|resolve))?$/) ?? [];
    switch (id && `${method} ${action}/${threadAction}`) {
        case 'GET /': return getSession(id);
        case 'GET diff/': return diff((await getSession(id)).worktree);
        case 'POST threads/': return exclusive(() => openThread(id, body));
        case 'POST threads/messages': return exclusive(() => addMessage(id, Number(thread), body));
        case 'POST threads/resolve': return exclusive(() => resolve(id, Number(thread)));
        case 'POST send/': return exclusive(() => send(id, body.tree));
        case 'POST approve/': return exclusive(() => approve(id));
    }
    throw httpError(404, `No route for ${method} ${path}`);
}

if (import.meta.main) {
    const server = await start(Number(process.env.CLAUDE_REVIEWS_PORT ?? 7778));
    console.log(`claude-reviews listening on http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
