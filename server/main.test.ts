import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, test } from 'node:test';
import { get, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { dataHome, git, removeRepos, repo, write } from './fixture.ts';
import { start } from './main.ts';

dataHome();
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

test('/s/<id> serves the HTML page of a session', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/s/0123456789abcdef`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/html/);
    assert.match(await res.text(), /<script type="module" src="\/app.js">/);
});

test('static files cannot escape the UI directory', async () => {
    // fetch() would normalize the path before sending it.
    const status = await new Promise(resolve => get({ host: '127.0.0.1', port, path: '/../package.json' }, res => resolve(res.resume().statusCode)));

    assert.equal(status, 404);
});

/** A raw request, since fetch() would not send some of these headers as given. */
function request(path: string, headers: Record<string, string>, method = 'GET', body = ''): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
    return new Promise(resolve => httpRequest({ host: '127.0.0.1', port, path, headers, method }, res => {
        let body = '';
        res.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }).end(body));
}

test('a write needs Content-Type: application/json and no Origin but the server\'s, and no answer carries CORS headers', async () => {
    const host = `127.0.0.1:${port}`;
    const json = 'application/json';
    const body = JSON.stringify({ worktree: repo({ 'a.txt': 'a\n' }) });
    const answers = [];

    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
        const refused = await request('/api/sessions', { host, 'content-type': type }, 'POST', body);
        assert.equal(refused.status, 415, type);
        assert.match(JSON.parse(refused.body).error, /Content-Type/);
        answers.push(refused);
    }
    answers.push(await request('/api/sessions', { host }, 'POST', body));
    assert.equal(answers.at(-1)!.status, 415);
    for (const origin of ['http://evil.example', `http://localhost:${port}`, 'null']) {
        const refused = await request('/api/sessions', { host, origin, 'content-type': json }, 'POST', body);
        assert.equal(refused.status, 403, origin);
        assert.match(JSON.parse(refused.body).error, /Origin/);
        answers.push(refused);
    }
    answers.push(await request('/api/sessions', { host, 'content-type': `${json}; charset=utf-8` }, 'POST', body));
    assert.equal(answers.at(-1)!.status, 200, 'a write without Origin, as the mod sends it, passes');
    answers.push(await request('/api/sessions', { host, origin: `http://${host}`, 'content-type': json }, 'POST', body));
    assert.equal(answers.at(-1)!.status, 200, 'a write from the page itself passes');
    answers.push(await request('/api/sessions', { host, origin: 'http://evil.example', 'access-control-request-method': 'POST' }, 'OPTIONS'));
    answers.push(await request('/', { host, origin: 'http://evil.example' }));

    for (const answer of answers) assert.equal(answer.headers['access-control-allow-origin'], undefined);
});

test('a request whose Host is not the local server is refused, against DNS rebinding', async () => {
    const refused = await request('/', { host: 'evil.example:7778' });
    assert.equal(refused.status, 403);
    assert.match(JSON.parse(refused.body).error, /Host/);
    assert.equal((await request('/', { host: `evil.example:${port}` })).status, 403);
    assert.equal((await request('/', { host: `127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await request('/api/sessions/0123456789abcdef', { host: `evil.example:${port}` })).status, 403);
    assert.equal((await request('/', { host: `localhost:${port}` })).status, 200);
    assert.equal((await request('/', { host: `127.0.0.1:${port}` })).status, 200);
});

test('a request sent by another site is refused before git runs', async () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'a.txt': 'b\n' });
    const { id } = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worktree: dir }) })).json();
    const path = `/api/sessions/${id}/diff`;
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
    assert.equal((await request('/api/sessions/0123456789abcdef', headers)).status, 403);
});

test('a worktree that does not exist gets a 400 naming its path', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worktree: '/no/such/worktree' }) });

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

test('GET /api/health names the app and the version of the plugin', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { app: 'claude-reviews', version });
});

test('POST /api/shutdown is guarded like any write, then stops the server', async () => {
    const other = await start(0);
    const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const closed = new Promise(resolve => other.once('close', resolve));

    assert.equal((await fetch(`${url}/api/shutdown`, { method: 'POST' })).status, 415);
    const res = await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);

    await closed;
    await assert.rejects(fetch(`${url}/api/health`));
});

test('a second server on the same port exits on EADDRINUSE, and the first keeps answering', async () => {
    const second = spawnSync(process.execPath, [new URL('main.ts', import.meta.url).pathname], {
        env: { ...process.env, CLAUDE_REVIEWS_PORT: String(port) }, encoding: 'utf8', timeout: 10_000,
    });

    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /EADDRINUSE/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
});
