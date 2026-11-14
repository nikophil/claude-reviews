import { expect, test, type Page } from '@playwright/test';
import { removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

function open(page: Page, worktree: string) {
    return page.goto(`/?worktree=${encodeURIComponent(worktree)}`);
}

/** A worktree whose a.txt has its line 3 indented, and its line 15 replaced. */
function changed(): string {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const dir = repo({ 'a.txt': `${lines.join('\n')}\n` });
    write(dir, { 'a.txt': `${lines.map(line => ({ l3: '    l3', l15: 'fifteen' })[line] ?? line).join('\n')}\n` });
    return dir;
}

async function hideWhitespace(page: Page, hide: boolean) {
    await page.getByRole('button', { name: 'Diff view settings' }).click();
    await page.getByRole('checkbox', { name: 'Hide whitespace' }).setChecked(hide);
}

const added = (page: Page) => page.locator('.diff-line-add .diff-code');

test('Hide whitespace takes a change of indentation out of the diff, and brings it back once unchecked', async ({ page }) => {
    await open(page, changed());
    await expect(added(page)).toHaveText(['    l3', 'fifteen']);

    await hideWhitespace(page, true);
    await expect(added(page)).toHaveText(['fifteen']);

    await hideWhitespace(page, false);
    await expect(added(page)).toHaveText(['    l3', 'fifteen']);
});

test('Hide whitespace stays checked after a reload', async ({ page }) => {
    await open(page, changed());
    await hideWhitespace(page, true);
    await expect(added(page)).toHaveText(['fifteen']);

    await page.reload();

    await expect(added(page)).toHaveText(['fifteen']);
    await page.getByRole('button', { name: 'Diff view settings' }).click();
    await expect(page.getByRole('checkbox', { name: 'Hide whitespace' })).toBeChecked();
});

test('with Hide whitespace, a thread on a line changed only by its spaces stays visible, between its lines of context', async ({ page, request }) => {
    const dir = changed();
    const { id } = await (await request.post('/api/sessions', { data: { worktree: dir } })).json();
    expect((await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side: 'new', start: 3, end: 3, body: 'Why indent?' } })).status()).toBe(200);
    await open(page, dir);
    await expect(page.locator('.thread')).toContainText('Why indent?');

    await hideWhitespace(page, true);

    await expect(added(page)).toHaveText(['fifteen']);
    await expect(page.locator('.thread')).toContainText('Why indent?');
    await expect(page.locator('.thread')).not.toContainText('Outdated');
    await expect(page.locator('.diff-line-context .diff-code').filter({ hasText: /^(l1|l2|    l3|l4|l5|l6)$/ })).toHaveText(['l1', 'l2', '    l3', 'l4', 'l5', 'l6']);
});

test('Viewed and its fold stay through Hide whitespace, and a Refresh keeps whitespace hidden', async ({ page }) => {
    const dir = changed();
    await open(page, dir);
    const file = page.locator('section[data-path="a.txt"]');
    await file.getByRole('checkbox', { name: 'Viewed' }).check();
    await expect(file.locator('table')).toBeHidden();

    // The diff loaded with whitespace hidden, before the worktree changes.
    const loaded = page.waitForResponse(response => /\/diff\?.*w=1$/.test(response.url()));
    await hideWhitespace(page, true);
    await loaded;

    await expect(file.getByRole('checkbox', { name: 'Viewed' })).toBeChecked();
    await expect(file.locator('table')).toBeHidden();
    await expect(page.getByText('1 / 1 viewed')).toBeVisible();

    write(dir, { 'b.txt': 'b\n' });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    await expect(page.locator('section[data-path="b.txt"]')).toBeVisible();
    await file.getByRole('button', { name: 'Expand file' }).click();
    await expect(file.locator('.diff-line-add .diff-code')).toHaveText(['fifteen']);
});

test('with the banner of a code change shown, Hide whitespace keeps the code displayed, and the banner', async ({ page }) => {
    const dir = changed();
    await open(page, dir);
    await expect(added(page)).toHaveText(['    l3', 'fifteen']);
    write(dir, { 'a.txt': 'other\n' });
    const banner = page.getByText('The code changed since it was loaded');
    await expect(banner).toBeVisible({ timeout: 4000 });

    await hideWhitespace(page, true);

    await expect(added(page)).toHaveText(['fifteen']);
    await page.waitForResponse(response => response.url().endsWith('/tree'));
    await expect(banner).toBeVisible();
});

test('a diff that fails to load leaves Hide whitespace unchecked, also after a reload', async ({ page }) => {
    await open(page, changed());
    await expect(added(page)).toHaveText(['    l3', 'fifteen']);
    await page.route(/\/diff\?.*w=1$/, route => route.fulfill({ status: 500, json: { error: 'git diff failed' } }));

    await hideWhitespace(page, true);

    await expect(page.getByText('git diff failed')).toBeVisible();
    await expect(added(page)).toHaveText(['    l3', 'fifteen']);
    await page.getByRole('button', { name: 'Diff view settings' }).click();
    await expect(page.getByRole('checkbox', { name: 'Hide whitespace' })).not.toBeChecked();
    await page.unrouteAll();
    await page.reload();
    await expect(added(page)).toHaveText(['    l3', 'fifteen']);
});

test('a diff with Hide whitespace that answers after a Refresh does not replace it', async ({ page }) => {
    const dir = changed();
    await open(page, dir);
    await expect(added(page)).toHaveText(['    l3', 'fifteen']);
    write(dir, { 'a.txt': 'other\n' });
    await expect(page.getByText('The code changed since it was loaded')).toBeVisible({ timeout: 4000 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/diff\?.*w=1$/, async route => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
    });

    await hideWhitespace(page, true);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(added(page)).toHaveText(['other']);
    const stale = page.waitForResponse(/\/api\/sessions\/[0-9a-f]{16}\?base=.*&w=1$/);
    release();
    await stale;
    await page.waitForResponse(response => response.url().endsWith('/tree'));

    await expect(added(page)).toHaveText(['other']);
});
