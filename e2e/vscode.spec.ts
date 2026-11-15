import { expect, test, type Page } from './fixtures.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { removeRepos, repo, write } from '../server/fixture.ts';
import { IMAGES, project, ROOT } from './readme.ts';

// Run by playwright.vscode.config.ts: the extension in openvscode-server on 3011, against the server of its baseURL.
test.afterAll(removeRepos);

const VSCODE = 'http://127.0.0.1:3011';

/** A worktree whose a.txt changed on line 2, with its session; `claude` opens a thread of Claude on that line. */
async function worktree(page: Page, { claude = false } = {}) {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\n', 'src/b.ts': 'export const x = 1;\n' });
    write(dir, { 'a.txt': 'one\n2\nthree\n', 'src/b.ts': 'export const x = 2;\n' });
    const { id } = await (await page.request.post('/api/sessions', { data: { worktree: dir } })).json();
    const route = `/api/sessions/${id}`;
    /** A thread of Claude, published at once. */
    const thread = (path: string, side: string, line: number, body: string) =>
        page.request.post(`${route}/threads`, { data: { author: 'claude', path, side, start: line, end: line, body } });
    if (claude) await thread('a.txt', 'new', 2, 'Why **2**?');
    const session = async () => (await page.request.get(route)).json();
    // What the mod does every 2 s: a Claude session runs in the worktree, for 10 s.
    const listen = () => page.request.get(`/api/sessions?worktree=${encodeURIComponent(dir)}&claude`);
    return { dir, id, route, thread, session, listen };
}

/** Opens VS Code on `dir`, trusting it if asked, and shows the view of the review unless `view` is false. */
async function open(page: Page, dir: string, { view = true } = {}) {
    await page.goto(`${VSCODE}/?folder=${encodeURIComponent(dir)}`);
    await page.getByRole('button', { name: 'Yes, I trust the authors' }).click({ timeout: 10_000 }).catch(() => {});
    const sidebar = page.locator('.part.sidebar');
    // A click while the workbench still loads can get lost.
    if (view) {
        await expect(async () => {
            // force: a badge on the icon keeps it from looking stable to Playwright.
            await page.locator('.activitybar .action-label[aria-label^="Claude Reviews"]').click({ timeout: 2000, force: true });
            await expect(sidebar.getByRole('heading', { name: 'Claude Reviews: Review' })).toBeVisible({ timeout: 2000 });
        }).toPass();
    }
    return sidebar;
}

/** Opens a new thread on line `line` of the editor, from the + of the gutter. */
async function draft(page: Page, line: number) {
    const glyph = page.locator('.editor-instance .margin-view-overlays > div', { has: page.locator('.line-numbers', { hasText: new RegExp(`^${line}$`) }) })
        .locator('.comment-range-glyph');
    await glyph.hover();
    await glyph.click();
    // The draft opens folded or not.
    const reply = page.locator('.review-widget .review-thread-reply-button');
    await expect(async () => {
        if (await reply.isVisible()) await reply.click();
        await page.locator('.review-widget .comment-form .monaco-editor').click({ timeout: 1000 });
    }).toPass();
}

test('the view lists the changed files, and a thread of Claude shows under its line, in markdown', async ({ page }) => {
    const { dir } = await worktree(page, { claude: true });

    const view = await open(page, dir);

    await expect(view.getByRole('treeitem', { name: /^a\.txt/ })).toBeVisible();
    await expect(view.getByRole('treeitem', { name: /^src\/b\.ts/ })).toBeVisible();
    await view.getByRole('treeitem', { name: /#1 · Line \+2/ }).click();
    await expect(page.locator('.review-widget strong', { hasText: '2' })).toBeVisible();
    await expect(page.locator('.review-widget').getByText('Claude', { exact: true })).toBeVisible();
});

test('a thread of Claude on the whole file shows at the top of the file', async ({ page }) => {
    const { dir, thread } = await worktree(page);
    await thread('a.txt', 'new', 0, 'About the whole file.');

    const view = await open(page, dir);

    await view.getByRole('treeitem', { name: /#1 · File/ }).click();
    await expect(page.locator('.review-widget').getByText('About the whole file.')).toBeVisible();
});

test('a reply stays Pending until Send, which publishes it', async ({ page }) => {
    const { dir, session, listen } = await worktree(page, { claude: true });
    await listen();
    const view = await open(page, dir);
    await view.getByRole('treeitem', { name: /#1 · Line \+2/ }).click();

    await page.locator('.review-widget .review-thread-reply-button').click();
    await page.keyboard.type('Because.');
    await page.locator('.review-widget').getByRole('button', { name: 'Add Pending' }).click();

    await expect(page.locator('.review-widget').getByText('Pending', { exact: true })).toBeVisible();
    expect((await session()).threads[0].messages[1]).toMatchObject({ author: 'me', body: 'Because.', date: null });
    await listen();
    await view.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('1 message sent to Claude', { exact: true })).toBeVisible();
    expect((await session()).threads[0].messages[1]).toMatchObject({ body: 'Because.', review: 1 });
});

test('a new thread opens from the + of the gutter, its first message Pending', async ({ page }) => {
    const { dir, session } = await worktree(page);
    const view = await open(page, dir);
    // A poll that reads a new state redraws the tree, which takes the hover, and with it the button, away: on a slow machine, after the view shows.
    await expect(async () => {
        await view.getByRole('treeitem', { name: /^a\.txt/ }).hover();
        await view.getByRole('button', { name: 'Open File' }).click({ timeout: 1000 });
    }).toPass();

    await draft(page, 3);
    await page.keyboard.type('Why three?');
    await page.locator('.review-widget').getByRole('button', { name: 'Add Pending' }).click();

    await expect(page.locator('.review-widget').getByText('#1 · Line +3 · Pending')).toBeVisible();
    const [thread] = (await session()).threads;
    expect(thread.anchor).toMatchObject({ path: 'a.txt', side: 'new', start: 3, end: 3 });
    expect(thread.messages).toMatchObject([{ author: 'me', body: 'Why three?', date: null }]);
});

test('the checkbox of a file marks it Viewed, until it is unchecked', async ({ page }) => {
    const { dir, session, listen } = await worktree(page);
    await listen();
    const view = await open(page, dir);
    const checkbox = view.getByRole('treeitem', { name: /^a\.txt/ }).getByRole('checkbox');

    // A poll that redraws the tree can drop a click: check() clicks again only while the box shows unchecked.
    await expect(async () => {
        await checkbox.check({ timeout: 1000 });
        expect(Object.keys((await session()).viewed)).toEqual(['a.txt']);
    }).toPass();
    await expect(view.getByText('2 files · 1 viewed')).toBeVisible();
    await expect(async () => {
        await checkbox.uncheck({ timeout: 1000 });
        expect(Object.keys((await session()).viewed)).toEqual([]);
    }).toPass();
});

test('an Outdated thread opens on the diff excerpt it was opened on', async ({ page }) => {
    const { dir } = await worktree(page, { claude: true });
    write(dir, { 'a.txt': 'one\ndeux\nthree\n' });
    const view = await open(page, dir);

    await view.getByRole('treeitem', { name: /#1 · Line \+2 · Outdated/ }).click();

    await expect(page.getByRole('tab', { name: /a\.txt\.diff/ })).toBeVisible();
    await expect(page.locator('.review-widget').getByText('Why')).toBeVisible();
});

test('the base picker offers Since my last review after a Send, and the session keeps it', async ({ page }) => {
    const { dir, id, session, listen } = await worktree(page);
    await listen();
    const tree = (await (await page.request.get(`/api/sessions/${id}/tree`)).json()).tree;
    await page.request.post(`/api/sessions/${id}/send`, { data: { tree } });
    const view = await open(page, dir);
    await expect(view.getByRole('treeitem', { name: /^a\.txt/ })).toBeVisible();

    await view.getByRole('button', { name: 'Choose Base' }).click();
    await page.getByRole('option', { name: /Since my last review/ }).click();

    await expect.poll(async () => (await session()).base).toBe('last-review');
    await expect(view.getByText('0 files')).toBeVisible();
});

test('Approve, once confirmed, closes the session', async ({ page }) => {
    const { dir, session } = await worktree(page, { claude: true });
    const view = await open(page, dir);
    await expect(view.getByRole('treeitem', { name: /^a\.txt/ })).toBeVisible();

    await view.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();

    await expect.poll(async () => (await session()).approvedAt).not.toBeNull();
    await expect(view.getByText('No review of this worktree yet.')).toBeVisible();
});

test('Send thread publishes the Pending messages of its thread alone', async ({ page }) => {
    const { dir, route, thread, session, listen } = await worktree(page, { claude: true });
    await thread('src/b.ts', 'new', 1, 'Why 2?');
    await page.request.post(`${route}/threads/1/messages`, { data: { author: 'me', body: 'First.' } });
    await page.request.post(`${route}/threads/2/messages`, { data: { author: 'me', body: 'Second.' } });
    await listen();
    const view = await open(page, dir);
    await view.getByRole('treeitem', { name: /#1 · Line \+2/ }).click();

    await page.locator('.review-widget').getByRole('button', { name: 'Send Thread' }).click();

    await expect(page.getByText('1 message sent to Claude', { exact: true })).toBeVisible();
    const [first, second] = (await session()).threads;
    expect(first.messages[1]).toMatchObject({ body: 'First.', review: 1 });
    expect(second.messages[1]).toMatchObject({ body: 'Second.', date: null });
});

test('Resolve folds a thread and takes it out of the view, Unresolve gives it back', async ({ page }) => {
    const { dir, session } = await worktree(page, { claude: true });
    const view = await open(page, dir);
    await view.getByRole('treeitem', { name: /#1 · Line \+2/ }).click();

    await page.locator('.review-widget').getByRole('button', { name: 'Resolve' }).click();

    await expect.poll(async () => (await session()).threads[0].resolved).toBe(true);
    await expect(view.getByRole('treeitem', { name: /#1/ })).toHaveCount(0);
    await expect(page.locator('.review-widget').getByText('Why')).toBeHidden();
    // The thread folded stays in its gutter, which unfolds it.
    await page.locator('.editor-instance .margin-view-overlays .comment-range-glyph.comment-thread').click();
    await page.locator('.review-widget').getByRole('button', { name: 'Unresolve' }).click();
    await expect.poll(async () => (await session()).threads[0].resolved).toBe(false);
    await expect(view.getByRole('treeitem', { name: /#1 · Line \+2/ })).toBeVisible();
});

test('a file opens in its diff against the base, with the threads of both sides', async ({ page }) => {
    const { dir, thread } = await worktree(page, { claude: true });
    await thread('a.txt', 'old', 2, 'Why not **two**?');
    const view = await open(page, dir);

    await view.getByRole('treeitem', { name: /^a\.txt/ }).click();

    await expect(page.getByRole('tab', { name: /a\.txt \([0-9a-f]{7} ↔ Working tree\)/ })).toBeVisible();
    await expect(page.locator('.editor-instance .view-line', { hasText: /^two$/ }).first()).toBeVisible();
    await expect(page.locator('.review-widget strong', { hasText: /^2$/ })).toBeVisible();
    await expect(page.locator('.review-widget strong', { hasText: /^two$/ })).toBeVisible();
});

test('the toolbar of the diff marks its file Viewed, and unmarks it', async ({ page }) => {
    const { dir, session } = await worktree(page);
    const view = await open(page, dir);
    await view.getByRole('treeitem', { name: /^a\.txt/ }).click();

    await page.locator('.editor-actions').getByRole('button', { name: 'Mark as Viewed' }).click();

    await expect.poll(async () => Object.keys((await session()).viewed)).toEqual(['a.txt']);
    await expect(view.getByRole('treeitem', { name: /^a\.txt/ }).getByRole('checkbox')).toBeChecked();
    await page.locator('.editor-actions').getByRole('button', { name: 'Viewed' }).click();
    await expect.poll(async () => Object.keys((await session()).viewed)).toEqual([]);
});

test('/review-local shows the view, once, when VS Code reads a recent request', async ({ page }) => {
    const { dir, route } = await worktree(page);
    await page.request.post(`${route}/show`, { data: {} });

    const sidebar = await open(page, dir, { view: false });

    await expect(sidebar.getByRole('treeitem', { name: /^a\.txt/ })).toBeVisible();
    await expect(page.getByText(`The review of ${dir} is open in VS Code`, { exact: true })).toBeVisible();
});

test('without a session, the view offers to start one; without a Claude session, Send says how to start one', async ({ page }) => {
    const dir = repo({ 'a.txt': 'one\n' });
    write(dir, { 'a.txt': '1\n' });
    const view = await open(page, dir);

    await view.getByRole('button', { name: 'Start Review' }).click();

    await expect(view.getByRole('treeitem', { name: /^a\.txt/ })).toBeVisible();
    const { id } = await (await page.request.get(`/api/sessions?worktree=${encodeURIComponent(dir)}`)).json();
    await page.request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Why?' } });
    await page.request.post(`/api/sessions/${id}/threads/1/messages`, { data: { author: 'me', body: 'Because.' } });
    await expect(view.getByText(`Start a Claude session in this worktree to send to Claude: cd ${dir} && claude`)).toBeVisible();
    await view.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(`Start a Claude session in this worktree to send to Claude: cd ${dir} && claude`).last()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Command' })).toBeVisible();
});

test('the image of the README', async ({ page }) => {
    test.skip(!process.env.README, 'npm run readme makes the images of the README');
    rmSync(join(ROOT, 'acme-shop'), { recursive: true, force: true });
    const dir = project('acme-shop', 'vat-per-line');
    const { id } = await (await page.request.post('/api/sessions', { data: { worktree: dir } })).json();
    const route = `/api/sessions/${id}`;
    const { base, tree } = await (await page.request.get(`${route}/tree`)).json();
    await page.request.post(`${route}/threads`, { data: { author: 'me', base, tree, path: 'src/cart.ts', side: 'new', start: 3, end: 3, body: 'Why round every total, rather than on display?' } });
    await page.request.post(`${route}/threads`, { data: { author: 'claude', path: 'src/cart.ts', side: 'new', start: 9, end: 11, body: 'I put the VAT rate on each line: an invoice can mix 5.5% and 20%.' } });
    await page.request.post(`${route}/send`, { data: { tree } });
    await page.request.post(`${route}/threads/1/messages`, {
        data: { author: 'claude', body: 'So that `total` and `totalWithVat` return amounts to the cent: the invoice adds them up afterwards, and `format` rounds too late for that sum.' },
    });
    // As the mod does every 2 s: the view then shows no warning about a missing Claude session.
    const listen = () => page.request.get(`/api/sessions?worktree=${encodeURIComponent(dir)}&claude`).catch(() => {});
    await listen();
    const listening = setInterval(listen, 2000);

    await page.setViewportSize({ width: 1600, height: 900 });
    const view = await open(page, dir);
    await view.getByRole('treeitem', { name: /^src\/cart\.ts/ }).click();
    await expect(page.locator('.review-widget').getByText('return amounts to the cent')).toBeVisible();
    // The diff alone, without the chat and the panel of openvscode-server.
    for (const [part, toggle] of [['.part.auxiliarybar', 'Toggle Secondary Side Bar'], ['.part.panel', 'Toggle Panel']]) {
        if (await page.locator(part).isVisible()) await page.locator(`.titlebar .action-label[aria-label^="${toggle}"]`).click();
        await expect(page.locator(part)).toBeHidden();
    }
    await page.screenshot({ path: join(IMAGES, 'vscode.png') });
    clearInterval(listening);
});
