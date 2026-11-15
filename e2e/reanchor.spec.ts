import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { git, removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

function open(page: Page, worktree: string) {
    return page.goto(`/?worktree=${encodeURIComponent(worktree)}`);
}

/** Opens a thread as Claude does, through the API, on one line of a.txt. */
async function claudeThread(request: APIRequestContext, worktree: string, side: 'old' | 'new', line: number, body: string) {
    const { id } = await (await request.post('/api/sessions', { data: { worktree } })).json();
    const res = await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side, start: line, end: line, body } });
    expect(res.status()).toBe(200);
}

/** The diff row right above a thread. */
const above = (page: Page) => page.locator('tr', { has: page.locator('.thread') }).locator('xpath=preceding-sibling::tr[1]');

test('a thread follows its line when code is added above it and I Refresh', async ({ page, request }) => {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
    write(dir, { 'a.txt': 'one\n2\nthree\nfour\n' });
    await claudeThread(request, dir, 'new', 2, 'Why 2?');
    await open(page, dir);
    await expect(page.locator('.thread')).toContainText('Line +2');

    write(dir, { 'a.txt': 'zero\none\n2\nthree\nfour\n' });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    await expect(page.locator('.thread')).toContainText('Line +3');
    await expect(page.locator('.thread')).not.toContainText('Outdated');
    await expect(above(page).locator('.diff-num').nth(1)).toHaveText('3');
    await expect(above(page).locator('.diff-code')).toHaveText('2');
});

test('a thread on a line that Claude changes shows Outdated after a Refresh, with its original excerpt', async ({ page, request }) => {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
    write(dir, { 'a.txt': 'one\n2\nthree\nfour\n' });
    await claudeThread(request, dir, 'new', 2, 'Why 2?');
    await open(page, dir);
    await expect(page.locator('.thread')).toContainText('Line +2');

    write(dir, { 'a.txt': 'one\ndeux\nthree\nfour\n' });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    const thread = page.locator('.thread');
    await expect(thread).toContainText('Outdated');
    await expect(thread.locator('.diff-line-del .diff-code')).toHaveText('two');
    await expect(thread.locator('.diff-line-add .diff-code')).toHaveText('2');
    await expect(page.locator('.diff-line-add .diff-code', { hasText: 'deux' })).toBeVisible();
});

test('a thread whose line left the diff shows in its file, at its line, between 3 lines of context, as one more hunk, until Resolved', async ({ page, request }) => {
    const dir = repo({ 'a.txt': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n' });
    write(dir, { 'a.txt': 'l1\nl2\nl3\nl4\nfive\nl6\nl7\nl8\nl9\nl10\n' });
    await claudeThread(request, dir, 'new', 5, 'Why five?');
    git(dir, 'commit', '-q', '-am', 'five');
    await open(page, dir);

    const file = page.locator('section', { hasText: 'a.txt' });
    await expect(file.locator('.diff-hunk')).toHaveText(['@@ -2,7 +2,7 @@']);
    await expect(file.locator('.diff-line-context .diff-code')).toHaveText(['l2', 'l3', 'l4', 'five', 'l6', 'l7', 'l8']);
    await expect(above(page).locator('.diff-code')).toHaveText('five');
    await expect(file.locator('.thread')).not.toContainText('Outdated');

    await file.getByRole('button', { name: 'Resolve' }).click();
    await expect(file).toHaveCount(0);
    await page.reload();
    await expect(page.locator('h1')).toContainText('0 files changed');
    await expect(file).toHaveCount(0);
});

test('a thread that Claude opens on code not loaded yet is Outdated until the Refresh, then anchored', async ({ page, request }) => {
    const dir = repo({ 'a.txt': 'one\ntwo\n' });
    write(dir, { 'a.txt': 'one\n2\n' });
    await open(page, dir);
    await expect(page.locator('.diff-line-add')).toHaveText([/2/]);

    write(dir, { 'a.txt': 'one\n2\nadded by Claude\n' });
    await claudeThread(request, dir, 'new', 3, 'Look at this');

    await expect(page.locator('.thread')).toContainText('Outdated', { timeout: 4000 });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });
    await expect(page.locator('.thread')).not.toContainText('Outdated');
    await expect(above(page).locator('.diff-code')).toHaveText('added by Claude');
});

test('a thread on the old side follows its line to a base where it moved, and is Outdated on a base without it', async ({ page, request }) => {
    const dir = repo({ 'a.txt': 'one\nthree\nfour\n' });
    git(dir, 'branch', 'gone');
    write(dir, { 'a.txt': 'zero\none\ntwo\nthree\nfour\n' });
    git(dir, 'commit', '-q', '-am', 'zero and two');
    git(dir, 'branch', 'moved');
    write(dir, { 'a.txt': 'one\ntwo\nthree\nfour\n' });
    git(dir, 'commit', '-q', '-am', 'no zero');
    write(dir, { 'a.txt': 'one\n2\nthree\nfour\n' });
    await claudeThread(request, dir, 'old', 2, 'Why not two?');
    await open(page, dir);
    await expect(page.locator('.thread')).toContainText('Line -2');
    const base = page.getByRole('combobox', { name: 'Base' });

    await base.selectOption('refs/heads/moved');
    await expect(page.locator('.thread')).toContainText('Line -3');
    await expect(above(page).locator('.diff-num').nth(0)).toHaveText('3');
    await expect(above(page).locator('.diff-code')).toHaveText('two');

    await base.selectOption('refs/heads/gone');
    await expect(page.locator('.thread')).toContainText('Outdated');
});
