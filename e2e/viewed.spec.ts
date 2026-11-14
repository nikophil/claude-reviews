import { expect, test, type Page } from '@playwright/test';
import { git, removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

/** Opens a session on three changed files, a.txt, b.txt and c.txt, once their diff shows. */
async function threeFiles(page: Page) {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    write(dir, { 'a.txt': 'A\n', 'b.txt': 'B\n', 'c.txt': 'C\n' });
    await page.goto(`/?worktree=${encodeURIComponent(dir)}`);
    await expect(page.locator('section[data-path] table')).toHaveCount(3);
    return dir;
}

const file = (page: Page, path: string) => page.locator(`section[data-path="${path}"]`);

test('the chevron of a file hides its diff and keeps its header, a second click shows it, and Viewed stays as it was', async ({ page }) => {
    await threeFiles(page);
    const a = file(page, 'a.txt');

    await a.getByRole('button', { name: 'Collapse file' }).click();

    await expect(a.locator('table')).toBeHidden();
    await expect(a.getByText('a.txt')).toBeVisible();
    await expect(a.getByRole('button', { name: 'Expand file' })).toHaveAttribute('aria-expanded', 'false');

    await a.getByRole('button', { name: 'Expand file' }).click();

    await expect(a.locator('table')).toBeVisible();
    await expect(a.getByRole('checkbox', { name: 'Viewed' })).not.toBeChecked();
});

test('checking Viewed on one of three files folds its diff and counts 1 / 3 viewed, and it stays checked after a reload', async ({ page }) => {
    await threeFiles(page);
    const a = file(page, 'a.txt');
    await expect(page.getByText('0 / 3 viewed')).toBeVisible();

    await a.getByRole('checkbox', { name: 'Viewed' }).check();

    await expect(a.locator('table')).toBeHidden();
    await expect(page.getByText('1 / 3 viewed')).toBeVisible();

    await page.reload();

    await expect(a.getByRole('checkbox', { name: 'Viewed' })).toBeChecked();
    await expect(a.locator('table')).toBeHidden();
    await expect(page.getByText('1 / 3 viewed')).toBeVisible();
});

test('a Viewed file that changes in the worktree is unchecked and unfolded after a Refresh, and the counter goes down', async ({ page }) => {
    const dir = await threeFiles(page);
    const a = file(page, 'a.txt');
    await a.getByRole('checkbox', { name: 'Viewed' }).check();
    await expect(page.getByText('1 / 3 viewed')).toBeVisible();

    write(dir, { 'a.txt': 'A again\n' });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    await expect(a.getByRole('checkbox', { name: 'Viewed' })).not.toBeChecked();
    await expect(a.locator('table')).toBeVisible();
    await expect(page.getByText('0 / 3 viewed')).toBeVisible();
});

test('a Viewed file that the worktree does not change stays Viewed after a Refresh brought by another file', async ({ page }) => {
    const dir = await threeFiles(page);
    const a = file(page, 'a.txt');
    await a.getByRole('checkbox', { name: 'Viewed' }).check();
    await expect(page.getByText('1 / 3 viewed')).toBeVisible();

    write(dir, { 'b.txt': 'B again\n' });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    await expect(file(page, 'b.txt').getByText('B again')).toBeVisible();
    await expect(a.getByRole('checkbox', { name: 'Viewed' })).toBeChecked();
    await expect(a.locator('table')).toBeHidden();
    await expect(page.getByText('1 / 3 viewed')).toBeVisible();
});

/** Holds the answer to the next Viewed write until `release` is called. */
async function holdViewed(page: Page) {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname.endsWith('/viewed'), async route => {
        const response = await route.fetch();
        await released;
        await route.fulfill({ response });
    }, { times: 1 });
    return release;
}

test('the Viewed boxes wait while a write is on its way, so a second one checked meanwhile is not undone', async ({ page }) => {
    await threeFiles(page);
    const release = await holdViewed(page);

    await file(page, 'a.txt').getByRole('checkbox', { name: 'Viewed' }).check();

    await expect(file(page, 'b.txt').getByRole('checkbox', { name: 'Viewed' })).toBeDisabled();
    release();
    await file(page, 'b.txt').getByRole('checkbox', { name: 'Viewed' }).check();
    await expect(page.getByText('2 / 3 viewed')).toBeVisible();
    await expect(file(page, 'b.txt').getByRole('checkbox', { name: 'Viewed' })).toBeChecked();
});

test('a file I unfold by its chevron right after checking Viewed stays unfolded when the server answers', async ({ page }) => {
    await threeFiles(page);
    const a = file(page, 'a.txt');
    const release = await holdViewed(page);
    await a.getByRole('checkbox', { name: 'Viewed' }).check();
    await expect(a.locator('table')).toBeHidden();

    await a.getByRole('button', { name: 'Expand file' }).click();
    release();

    await expect(page.getByText('1 / 3 viewed')).toBeVisible();
    await expect(a.locator('table')).toBeVisible();
});

test('a Viewed file committed since, shown for its thread, opens unfolded with its thread', async ({ page, request }) => {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(dir, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
    const { id } = await (await request.post('/api/sessions', { data: { worktree: dir } })).json();
    expect((await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side: 'new', start: 1, end: 1, body: 'Why A?' } })).status()).toBe(200);
    await page.goto(`/?worktree=${encodeURIComponent(dir)}`);
    await file(page, 'a.txt').getByRole('checkbox', { name: 'Viewed' }).check();
    await expect(page.getByText('1 / 2 viewed')).toBeVisible();

    git(dir, 'commit', '-qm', 'a', 'a.txt');
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    await expect(page.getByText('0 / 1 viewed')).toBeVisible();
    await expect(file(page, 'a.txt').getByText('Why A?')).toBeVisible();
});

test('the copy button of a file puts its path in the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await threeFiles(page);

    await file(page, 'b.txt').getByRole('button', { name: 'Copy file path' }).click();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('b.txt');
});

test('no counter shows when no file changed', async ({ page }) => {
    const dir = repo({ 'a.txt': 'a\n' });
    await page.goto(`/?worktree=${encodeURIComponent(dir)}`);

    await expect(page.getByText('0 files changed')).toBeVisible();
    await expect(page.getByText(/viewed/)).toHaveCount(0);
});
