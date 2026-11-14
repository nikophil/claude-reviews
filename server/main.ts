import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { diff } from './diff.ts';

const UI = join(import.meta.dirname, '..', 'ui');
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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
        try {
            if (url.pathname === '/api/diff') {
                // ponytail: the worktree comes from the URL until slice 2 gives sessions their own URLs.
                const worktree = url.searchParams.get('worktree');
                if (!worktree || !existsSync(worktree)) return json(res, 400, { error: `No worktree at ${worktree}` });
                return json(res, 200, await diff(worktree));
            }
            // The URL parser already resolves "..", so the joined path stays inside UI.
            const path = join(UI, url.pathname === '/' ? 'index.html' : url.pathname);
            const type = TYPES[extname(path)];
            if (!type) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
            const content = await readFile(path);
            res.writeHead(200, { 'content-type': type }).end(content);
        } catch (error) {
            json(res, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, { error: String(error) });
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

if (import.meta.main) {
    const server = await start(Number(process.env.CLAUDE_REVIEWS_PORT ?? 7778));
    console.log(`claude-reviews listening on http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
