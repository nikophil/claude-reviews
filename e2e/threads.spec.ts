import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { git, removeRepos, repo, vanish, write } from '../server/fixture.ts';

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

test('a Resolved thread folds, opens again on a click, takes no message, and takes them again once Unresolved', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'Is this right?');
    await open(page, dir);

    await page.getByRole('button', { name: 'Resolve' }).click();

    const thread = page.locator('.thread');
    await expect(thread).toContainText('Resolved');
    await expect(thread.getByText('Is this right?')).toBeHidden();
    await thread.getByText('Line +2').click();
    await expect(thread.getByText('Is this right?')).toBeVisible();
    await expect(thread.getByLabel('Message')).toHaveCount(0);

    await thread.getByRole('button', { name: 'Unresolve' }).click();
    await expect(thread).not.toContainText('Resolved');
    await expect(thread.getByLabel('Message')).toBeVisible();
    await expect(thread.getByRole('button', { name: 'Resolve' })).toBeVisible();
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
    const isSession = (url: string) => new URL(url).pathname === `/api/sessions/${id}`;
    // Every poll answers late, so one is still on its way when the Approve answers.
    await page.route(url => isSession(url.href), async route => {
        const response = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.fulfill({ response });
    });
    await open(page, dir);
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.waitForRequest(request => request.method() === 'GET' && isSession(request.url()));
    const late = page.waitForResponse(response => response.request().method() === 'GET' && isSession(response.url()));
    let message = '';
    page.once('dialog', dialog => { message = dialog.message(); dialog.accept(); });

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
    let polls = 0;
    page.on('request', request => { if (request.method() === 'GET' && isSession(request.url())) polls++; });
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

test('a Refresh drops a selection whose lines changed, so a thread never opens on the line that took its number', async ({ page }) => {
    const dir = repo({ 'a.txt': 'one\ntwo\n' });
    write(dir, { 'a.txt': 'one\nTARGET\n' });
    await open(page, dir);
    await page.locator('.diff-line-add .diff-num').nth(1).click();
    await page.getByRole('textbox').fill('About TARGET');
    write(dir, { 'a.txt': 'zero\nhalf\none\nTARGET\n' });

    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    await expect(page.locator('.selected')).toHaveCount(0);
    await page.locator('.diff-line-add:has-text("TARGET") .diff-num').nth(1).click();
    await expect(page.getByRole('textbox')).toHaveValue('About TARGET');
});

test('a Pending message of a Resolved thread does not gray out Approve, and text typed but not added is named before an Approve', async ({ page, request }) => {
    const dir = changed();
    const { id, thread } = await claudeThread(request, dir, 2, 'Is this right?');
    await request.post(`/api/sessions/${id}/threads/${thread}/messages`, { data: { author: 'me', body: 'Written, then resolved' } });
    await request.post(`/api/sessions/${id}/threads/${thread}/resolve`, { data: {} });
    await claudeThread(request, dir, 3, 'And this?');
    await open(page, dir);
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeEnabled();
    await page.getByRole('textbox').fill('Not added yet');
    const asked = new Promise<string>(resolve => page.once('dialog', dialog => { resolve(dialog.message()); dialog.dismiss(); }));

    await approve.click();

    expect(await asked).toMatch(/not added/i);
});

test('a line break in a message shows as one, as on GitHub', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 2, 'First line\nSecond line');
    await open(page, dir);

    await expect(page.locator('.thread .markdown-body br')).toHaveCount(1);
});

test('the page of a session closed because its worktree is gone shows every thread, none Outdated, and not the diff of a new worktree at its path', async ({ page, request }) => {
    const main = repo({ 'a.txt': 'one\ntwo\n' });
    const dir = `${main}/linked`;
    git(main, 'worktree', 'add', '-q', dir);
    const { id, thread } = await claudeThread(request, dir, 1, 'Resolved one');
    await request.post(`/api/sessions/${id}/threads/${thread}/resolve`, { data: {} });
    await claudeThread(request, dir, 2, 'Open one');
    vanish(dir);
    await request.get(`/api/sessions/${id}`);
    git(main, 'init', '-q', dir);
    write(dir, { 'new.txt': 'new\n' });

    await page.goto(`/s/${id}`);

    await expect(page.getByText('Closed', { exact: true })).toBeVisible();
    await expect(page.locator('.thread')).toHaveCount(2);
    await expect(page.locator('.thread').first()).toContainText('Resolved one');
    await expect(page.getByText('Outdated')).toHaveCount(0);
    await expect(page.getByText('new.txt')).toHaveCount(0);
});

test('a page left open on a session learns at its next poll that the worktree is gone, and shows it Closed', async ({ page, request }) => {
    const main = repo({ 'a.txt': 'one\ntwo\n' });
    const dir = `${main}/linked`;
    git(main, 'worktree', 'add', '-q', dir);
    await claudeThread(request, dir, 1, 'Here');
    await open(page, dir);
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    vanish(dir);

    await expect(page.getByText('Closed', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
});

/** Opens a thread of mine on the first added line of the page, through the page. */
async function myThread(page: Page, body: string) {
    await page.locator('.diff-line-add .diff-num').nth(1).click();
    await page.getByRole('textbox').fill(body);
    await page.getByRole('button', { name: 'Add message' }).click();
    await expect(page.locator('.thread')).toContainText(body);
}

test('a Pending message of mine can be edited, then deleted, which deletes a thread left without message', async ({ page }) => {
    await open(page, changed());
    await myThread(page, 'Typo hree');
    const thread = page.locator('.thread');

    await thread.getByRole('button', { name: 'Edit' }).click();
    await thread.getByRole('textbox').fill('Typo here');
    await thread.getByRole('button', { name: 'Save' }).click();
    await expect(thread.locator('.markdown-body')).toHaveText('Typo here');
    await expect(thread).toContainText('Pending');
    page.once('dialog', dialog => dialog.accept());
    await thread.getByRole('button', { name: 'Delete' }).click();

    await expect(page.locator('.thread')).toHaveCount(0);
});

test('Suggest change puts the selected lines in a suggestion block, shown as the change it proposes', async ({ page }) => {
    await open(page, changed());
    await page.locator('.diff-line-add .diff-num').nth(1).click();

    await page.getByRole('button', { name: 'Suggest change' }).click();

    await expect(page.getByRole('textbox')).toHaveValue('```suggestion\n2\n```\n');
    await page.getByRole('textbox').fill('```suggestion\ntwo\n```\n');
    await page.getByRole('button', { name: 'Add message' }).click();
    const suggestion = page.locator('.thread .suggestion');
    await expect(suggestion).toContainText('Suggested change');
    await expect(suggestion.locator('.diff-line-del')).toHaveText('2');
    await expect(suggestion.locator('.diff-line-add')).toHaveText('two');
});

test('Comment on file opens a thread on the whole file, above its diff', async ({ page }) => {
    await open(page, changed());
    const file = page.locator('section[data-path="a.txt"]');

    await file.getByRole('button', { name: 'Comment on file' }).click();
    await file.getByRole('textbox').fill('Split this file');
    await file.getByRole('button', { name: 'Add message' }).click();

    const thread = file.locator('.thread');
    await expect(thread.locator('summary')).toContainText('File');
    await page.reload();
    await expect(thread).toContainText('Split this file');
});

test('Copy threads copies the published messages of every thread as markdown', async ({ page, request }) => {
    const dir = changed();
    const { id, thread } = await claudeThread(request, dir, 2, 'Is this right?');
    await request.post(`/api/sessions/${id}/threads/${thread}/messages`, { data: { author: 'me', body: 'Not sent' } });
    await claudeThread(request, dir, 3, 'And this?');
    await request.post(`/api/sessions/${id}/threads/2/resolve`, { data: {} });
    await open(page, dir);
    await page.evaluate(() => { navigator.clipboard.writeText = async text => { (window as any).copied = text; }; });

    await page.getByRole('button', { name: 'Copy threads' }).click();

    expect(await page.evaluate(() => (window as any).copied)).toBe('### `a.txt` line +2\n\n**Claude**: Is this right?\n\n### `a.txt` line +3 · Resolved\n\n**Claude**: And this?\n');
});

test('without a Claude session in the worktree, the page says a Send wakes no one, until one reads the session', async ({ page, request }) => {
    const dir = changed();
    await open(page, dir);
    const warning = page.getByText('No Claude session runs in this worktree');
    await expect(warning).toBeVisible();

    await request.get(`/api/sessions?worktree=${encodeURIComponent(dir)}&claude`);

    await expect(warning).toBeHidden({ timeout: 5000 });
});

test('j and k go from thread to thread, the Conversations menu lists them and marks those Claude replied in since my last Send', async ({ page, request }) => {
    const dir = repo({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
    write(dir, { 'a.txt': 'ONE\n', 'b.txt': 'ONE\n' });
    const { id } = await (await request.post('/api/sessions', { data: { worktree: dir } })).json();
    for (const path of ['a.txt', 'b.txt']) await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path, side: 'new', start: 1, end: 1, body: `About ${path}` } });
    const { tree } = await (await request.get(`/api/sessions/${id}/tree`)).json();
    await request.post(`/api/sessions/${id}/send`, { data: { tree } });
    await request.post(`/api/sessions/${id}/threads/2/messages`, { data: { author: 'claude', body: 'Later' } });
    await request.post(`/api/sessions/${id}/viewed`, { data: { path: 'b.txt', tree, viewed: true } });
    await open(page, dir);
    await expect(page.locator('section[data-path="a.txt"] .thread')).toBeVisible();
    await expect(page.locator('section[data-path="b.txt"] .thread')).toBeHidden();

    await page.keyboard.press('j');
    await expect(page).toHaveURL(/#thread-1$/);
    await page.keyboard.press('j');
    await expect(page).toHaveURL(/#thread-2$/);
    await expect(page.locator('#thread-2')).toBeVisible();
    await page.keyboard.press('k');
    await expect(page).toHaveURL(/#thread-1$/);

    await page.getByRole('button', { name: '2 conversations' }).click();
    const menu = page.locator('.conversations');
    await expect(menu.getByRole('button')).toHaveText([/a\.txt/, /b\.txt.*Replied/]);
});
