import assert from 'node:assert/strict';
import { connect, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, test } from 'node:test';
import { get, type Server } from 'node:http';
import { git, removeRepos, repo, write } from './fixture.ts';
import { start } from './main.ts';

let server: Server;
let port: number;
before(async () => {
    server = await start(0);
    port = (server.address() as AddressInfo).port;
});
after(() => {
    server.close();
    removeRepos();
});

test('/ serves the HTML page', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/html/);
    assert.match(await res.text(), /<html data-color-mode="auto" data-light-theme="light" data-dark-theme="dark">/);
});

test('the diff API serves the worktree diff as JSON', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'a.txt': 'b\n' });

    const res = await fetch(`http://127.0.0.1:${port}/api/diff?worktree=${encodeURIComponent(dir)}`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^application\/json/);
    const body = await res.json();
    assert.match(body.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(body.files.map((f: { path: string }) => f.path), ['a.txt']);
});

test('static files cannot escape the UI directory', async () => {
    // fetch() would normalize the path before sending it.
    const status = await new Promise(resolve => get({ host: '127.0.0.1', port, path: '/../package.json' }, res => resolve(res.resume().statusCode)));

    assert.equal(status, 404);
});

/** A raw request, since fetch() would not send some of these headers as given. */
function request(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise(resolve => get({ host: '127.0.0.1', port, path, headers }, res => {
        let body = '';
        res.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => resolve({ status: res.statusCode!, body }));
    }));
}

test('a request whose Host is not the local server is refused, against DNS rebinding', async () => {
    const refused = await request('/', { host: 'evil.example:7778' });
    assert.equal(refused.status, 403);
    assert.match(JSON.parse(refused.body).error, /Host/);
    assert.equal((await request('/', { host: `evil.example:${port}` })).status, 403);
    assert.equal((await request('/', { host: `127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await request('/api/diff?worktree=/tmp', { host: `evil.example:${port}` })).status, 403);
    assert.equal((await request('/', { host: `localhost:${port}` })).status, 200);
    assert.equal((await request('/', { host: `127.0.0.1:${port}` })).status, 200);
});

test('a request sent by another site is refused before git runs', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'a.txt': 'b\n' });
    const path = `/api/diff?worktree=${encodeURIComponent(dir)}`;
    const host = `127.0.0.1:${port}`;
    const objectsBefore = git(dir, 'count-objects');

    for (const site of ['cross-site', 'same-site']) {
        const refused = await request(path, { host, 'sec-fetch-site': site });
        assert.equal(refused.status, 403, site);
        assert.match(JSON.parse(refused.body).error, /Sec-Fetch-Site/);
    }
    assert.equal(git(dir, 'count-objects'), objectsBefore, 'no git object was written');
    assert.equal((await request(path, { host, 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await request(path, { host, 'sec-fetch-site': 'none' })).status, 200);
});

test('a link from another site opens the page, but cannot call the API', async () => {
    const headers = { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' };

    assert.equal((await request('/', headers)).status, 200);
    assert.equal((await request('/api/diff?worktree=/tmp', headers)).status, 403);
});

test('a worktree that does not exist gets a 400 naming its path', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/diff?worktree=${encodeURIComponent('/no/such/worktree')}`);

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /\/no\/such\/worktree/);
});

test('the server listens on 127.0.0.1 only', async () => {
    assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
    // IPv6 link-local addresses need a scope id to be reachable, so IPv4 interfaces stand for the others.
    const others = Object.values(networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i!.address);
    for (const host of ['::1', ...others]) {
        await assert.rejects(new Promise((resolve, reject) => {
            const socket = connect({ host, port }, () => resolve(socket.end()));
            socket.setTimeout(1000, () => socket.destroy(new Error('timeout')));
            socket.on('error', reject);
        }), `${host} should refuse the connection`);
    }
});
