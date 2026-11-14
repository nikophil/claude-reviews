import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

function open(page: Page, worktree: string) {
    return page.goto(`/?worktree=${encodeURIComponent(worktree)}`);
}

/** A worktree whose a.txt has lines 2 and 3 changed. */
function changed(): string {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
    write(dir, { 'a.txt': 'one\n2\n3\nfour\n' });
    return dir;
}

/** Opens a thread as Claude does, through the API, on line `line` of the new a.txt. */
async function claudeThread(request: APIRequestContext, worktree: string, line: number, body: string) {
    const { id } = await (await request.post('/api/sessions', { data: { worktree } })).json();
    const res = await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side: 'new', start: line, end: line, body } });
    expect(res.status()).toBe(200);
    return { id, thread: (await res.json()).threads.at(-1).id };
}

test('a click on a line number then a Shift+click on another opens a thread on the range, whose message is Pending and survives a reload', async ({ page }) => {
    await open(page, changed());
    await expect(page).toHaveURL(/\/s\/[0-9a-f]{16}$/);

    const added = page.locator('.diff-line-add');
    await added.nth(0).locator('.diff-num').nth(1).click();
    await added.nth(1).locator('.diff-num').nth(1).click({ modifiers: ['Shift'] });
    await expect(page.locator('.selected')).toHaveCount(2);
    await page.getByRole('textbox').fill('Why **two** lines?');
    await page.getByRole('button', { name: 'Add message' }).click();

    const thread = page.locator('.diff-line-add:has-text("3") + tr .thread');
    await expect(thread).toContainText('Lines +2 to +3');
    await expect(thread.locator('.markdown-body strong')).toHaveText('two');
    await expect(thread).toContainText('Pending');
    await page.reload();
    await expect(thread).toContainText('Pending');
    await expect(thread).toContainText('Why two lines?');
});

test('the HTML of a message shows as text, and a javascript: link is not clickable', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'See <img src=x onerror=alert(1)> and [this](javascript:alert(1)) or [docs](https://example.com).');
    page.on('dialog', dialog => { throw new Error(`Unexpected dialog: ${dialog.message()}`); });
    await open(page, dir);

    const body = page.locator('.thread .markdown-body');
    await expect(body).toContainText('See <img src=x onerror=alert(1)> and this or docs.');
    await expect(body.locator('img')).toHaveCount(0);
    await expect(body.getByRole('link')).toHaveCount(1);
    await expect(body.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com');
});

test('Send is active without Pending message, and Approve is grayed out with one', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'Is this right?');
    await open(page, dir);

    const send = page.getByRole('button', { name: 'Send' });
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(send).toBeEnabled();
    await expect(approve).toBeEnabled();
    await page.getByRole('textbox').fill('Yes');
    await page.getByRole('button', { name: 'Add message' }).click();
    await expect(page.locator('.thread')).toContainText('Pending');
    await expect(approve).toBeDisabled();
    await expect(send).toBeEnabled();

    await send.click();

    await expect(page.locator('.thread')).not.toContainText('Pending');
    await expect(page.locator('.thread')).toContainText('Waiting for Claude');
    await expect(approve).toBeEnabled();
});

test('a Resolved thread folds, and opens again on a click', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'Is this right?');
    await open(page, dir);

    await page.getByRole('button', { name: 'Resolve' }).click();

    const thread = page.locator('.thread');
    await expect(thread).toContainText('Resolved');
    await expect(thread.getByText('Is this right?')).toBeHidden();
    await thread.getByText('Line +2').click();
    await expect(thread.getByText('Is this right?')).toBeVisible();
});

test('the Approve dialog counts the open threads, and the approved session turns read-only', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'First');
    await claudeThread(request, dir, 3, 'Second');
    await open(page, dir);
    await expect(page.locator('.thread')).toHaveCount(2);

    let message = '';
    page.once('dialog', dialog => { message = dialog.message(); dialog.accept(); });
    await page.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
    expect(message).toContain('2 open threads');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await page.locator('.diff-line-add .diff-num').nth(1).click();
    await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('a reply of Claude shows up without reload while I type, and leaves my text intact', async ({ page, request }) => {
    const dir = changed();
    const { id, thread } = await claudeThread(request, dir, 2, 'Is this right?');
    await open(page, dir);
    await page.evaluate(() => { (window as any).loaded = true; });
    await page.getByRole('textbox').fill('I am still typ');

    await request.post(`/api/sessions/${id}/threads/${thread}/messages`, { data: { author: 'claude', body: 'Also, line 3.' } });

    await expect(page.locator('.thread')).toContainText('Also, line 3.', { timeout: 4000 });
    await expect(page.getByRole('textbox')).toHaveValue('I am still typ');
    await expect(page.getByRole('textbox')).toBeFocused();
    expect(await page.evaluate(() => (window as any).loaded)).toBe(true);
});

test('a draft reply stays intact when Claude opens a thread above it', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 3, 'On three');
    await open(page, dir);
    await page.locator('.thread').getByRole('textbox').fill('My draft');

    await claudeThread(request, dir, 2, 'On two');

    await expect(page.locator('.thread')).toHaveCount(2, { timeout: 4000 });
    await expect(page.locator('.thread', { hasText: 'On three' }).getByRole('textbox')).toHaveValue('My draft');
});

test('the draft of a new thread follows the selection to another line, of this file or another', async ({ page }) => {
    const dir = repo({ 'a.txt': 'one\ntwo\n', 'b.txt': 'x\n' });
    write(dir, { 'a.txt': 'one\n2\n', 'b.txt': 'y\n' });
    await open(page, dir);
    await page.locator('#diff-0 .diff-line-context .diff-num').nth(1).click();
    await page.getByRole('textbox').fill('My draft');

    await page.locator('#diff-0 .diff-line-add .diff-num').nth(1).click();
    await expect(page.locator('#diff-0 .diff-line-add + tr').getByRole('textbox')).toHaveValue('My draft');

    await page.locator('#diff-1 .diff-line-add .diff-num').nth(1).click();
    await expect(page.locator('#diff-1').getByRole('textbox')).toHaveValue('My draft');
    await expect(page.getByRole('textbox')).toHaveCount(1);
});

test('text typed while Add message waits for the server stays in the box', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'Is this right?');
    await open(page, dir);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/threads/*/messages', async route => { await held; await route.continue(); });
    const box = page.getByRole('textbox');
    await box.fill('First');
    await page.getByRole('button', { name: 'Add message' }).click();

    await box.fill('First, then more');
    release();

    await expect(page.locator('.thread')).toContainText('Pending');
    await expect(box).toHaveValue('First, then more');
});

test('a double click on Add message or Send writes once', async ({ page }) => {
    await open(page, changed());
    await expect(page.locator('.diff-line-add').first()).toBeVisible();
    await page.route('**/api/sessions/*/*', async route => { await new Promise(resolve => setTimeout(resolve, 300)); await route.continue(); });
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname.split('/').pop()!); });
    await page.locator('.diff-line-add .diff-num').nth(1).click();
    await page.getByRole('textbox').fill('Once');

    await page.getByRole('button', { name: 'Add message' }).dblclick();
    await expect(page.locator('.thread')).toContainText('Pending');
    await page.getByRole('button', { name: 'Send' }).dblclick();
    await expect(page.locator('.thread')).toContainText('Waiting for Claude');

    expect(posts).toEqual(['threads', 'send']);
});

test('an approved session stays read-only when a late poll answers, and stops polling', async ({ page, request }) => {
    const dir = changed();
    const { id } = await claudeThread(request, dir, 2, 'Only one');
    // Every poll answers late, so one is still on its way when the Approve answers.
    await page.route(`**/api/sessions/${id}`, async route => {
        const response = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.fulfill({ response });
    });
    const polled = page.waitForRequest(request => request.method() === 'GET' && request.url().endsWith(`/api/sessions/${id}`));
    await open(page, dir);
    await polled;
    const late = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/api/sessions/${id}`));
    let message = '';
    page.once('dialog', dialog => { message = dialog.message(); dialog.accept(); });

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
    let polls = 0;
    page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith(`/api/sessions/${id}`)) polls++; });
    await late;
    await page.waitForTimeout(200);

    expect(message).toBe('Approve this session with 1 open thread?');
    expect(await page.getByRole('button', { name: 'Send' }).count()).toBe(0);
    await page.waitForTimeout(2500);
    expect(polls).toBe(0);
});

test('text typed while a new thread opens stays in the box of the range', async ({ page }) => {
    await open(page, changed());
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/sessions/*/threads', async route => { await held; await route.continue(); });
    await page.locator('.diff-line-add .diff-num').nth(1).click();
    const box = page.locator('form', { has: page.getByRole('button', { name: 'Cancel' }) }).getByRole('textbox');
    await box.fill('First');
    await page.getByRole('button', { name: 'Add message' }).click();

    await box.fill('First, then more');
    release();

    await expect(page.locator('.thread')).toContainText('Pending');
    await expect(box).toHaveValue('First, then more');
});

test('a link of a message opens in a new tab', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'See [docs](https://example.com).');
    await open(page, dir);

    const link = page.locator('.thread .markdown-body').getByRole('link', { name: 'docs' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
