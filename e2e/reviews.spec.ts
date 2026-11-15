import { expect, test, type APIRequestContext } from '@playwright/test';
import { basename } from 'node:path';
import { git, removeRepos, repo, vanish, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

/** A worktree whose a.txt has line 2 changed, with an open session and a thread on that line, from `author`. */
async function withThread(request: APIRequestContext, author: 'me' | 'claude', body: string) {
    const dir = repo({ 'a.txt': 'one\ntwo\n' });
    write(dir, { 'a.txt': 'one\n2\n' });
    const { id } = await (await request.post('/api/sessions', { data: { worktree: dir } })).json();
    const shown = await (await request.get(`/api/sessions/${id}/diff`)).json();
    const thread = { author, path: 'a.txt', side: 'new', start: 2, end: 2, body, ...(author === 'me' && { base: shown.base, tree: shown.tree }) };
    expect((await request.post(`/api/sessions/${id}/threads`, { data: thread })).status()).toBe(200);
    if (author === 'me') await request.post(`/api/sessions/${id}/send`, { data: { tree: shown.tree } });
    return { dir, id };
}

test('Reviews shows each open session with its repository, branch and counters, and a click opens its Files changed page', async ({ page, request }) => {
    const awaiting = await withThread(request, 'claude', 'Look');
    git(awaiting.dir, 'checkout', '-qb', 'invoice-footer');
    const waiting = await withThread(request, 'me', 'Why?');
    git(waiting.dir, 'checkout', '-qb', 'pdf-export');

    await page.goto('/');

    const first = page.getByRole('link', { name: new RegExp(basename(awaiting.dir)) });
    await expect(first).toContainText('invoice-footer');
    await expect(first).toContainText('0 Waiting for Claude');
    const second = page.getByRole('link', { name: new RegExp(basename(waiting.dir)) });
    await expect(second).toContainText('pdf-export');
    await expect(page.getByText(/Awaiting you/)).toHaveCount(0);
    await expect(second).toContainText('1 Waiting for Claude');
    await second.click();
    await expect(page).toHaveURL(`/s/${waiting.id}`);
    await expect(page.getByRole('heading', { name: /1 files changed/ })).toBeVisible();
});

test('a session archived because its worktree is gone shows read-only at its URL', async ({ page, request }) => {
    const { dir, id } = await withThread(request, 'claude', 'Is this right?');
    vanish(dir);
    await request.get('/api/sessions');

    await page.goto(`/s/${id}`);

    await expect(page.locator('.thread')).toContainText('Is this right?');
    await expect(page.getByText('Closed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('an approved session whose worktree is gone afterwards shows Approved, not Closed', async ({ page, request }) => {
    const { dir, id } = await withThread(request, 'claude', 'Is this right?');
    await request.post(`/api/sessions/${id}/approve`, { data: {} });
    vanish(dir);
    await request.get('/api/sessions');

    await page.goto(`/s/${id}`);

    await expect(page.locator('.thread')).toContainText('Is this right?');
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
    await expect(page.getByText('Closed', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/The worktree is gone/)).toHaveCount(0);
});
