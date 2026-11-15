import { expect, test, type Page } from '@playwright/test';
import { git, removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

function open(page: Page, worktree: string) {
    return page.goto(`/?worktree=${encodeURIComponent(worktree)}`);
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `l${i + 1}`);

/** A worktree whose a.txt of 100 lines gains a line after l5 and has l62 changed: 50 unchanged lines lie between the two hunks. */
function apart(): string {
    const lines = numbered(100);
    const dir = repo({ 'a.txt': `${lines.join('\n')}\n` });
    write(dir, { 'a.txt': `${[...lines.slice(0, 5), 'added', ...lines.slice(5, 61), 'changed', ...lines.slice(62)].join('\n')}\n` });
    return dir;
}

/** The diff row of a line, by its text, out of the excerpts of Outdated threads. */
const row = (page: Page, text: string) => page.locator('section > div > table > tbody > tr', { has: page.locator('.diff-code', { hasText: new RegExp(`^${text}$`) }) });

/** The row above a hunk, that expands the lines hidden before it. */
const expander = (page: Page, header: string) => page.locator('tr.diff-hunk', { hasText: header });

test('Expand down under a hunk shows the next 20 hidden lines, numbered on both sides', async ({ page }) => {
    await open(page, apart());
    await expect(row(page, 'changed')).toHaveCount(1);
    await expect(row(page, 'l9')).toHaveCount(0);

    await expander(page, '@@ -59,7 +60,7 @@').getByRole('button', { name: 'Expand down' }).click();

    await expect(row(page, 'l9').locator('.diff-num')).toHaveText(['9', '10']);
    await expect(row(page, 'l28').locator('.diff-num')).toHaveText(['28', '29']);
    await expect(row(page, 'l28')).toHaveClass(/diff-line-context/);
    await expect(row(page, 'l29')).toHaveCount(0);
    await expect(expander(page, '@@ -59,7 +60,7 @@').getByRole('button', { name: 'Expand up' })).toBeVisible();
});

test('Expand all on fewer than 20 hidden lines shows them all, and the two hunks join', async ({ page }) => {
    const lines = numbered(23);
    const dir = repo({ 'a.txt': `${lines.join('\n')}\n` });
    write(dir, { 'a.txt': `${lines.map(line => ({ l5: 'five', l20: 'twenty' })[line] ?? line).join('\n')}\n` });
    await open(page, dir);
    const hunk = expander(page, '@@ -17,7 +17,7 @@');
    await expect(hunk.getByRole('button', { name: 'Expand down' })).toHaveCount(0);

    await hunk.getByRole('button', { name: 'Expand all' }).click();

    await expect(hunk).toHaveCount(0);
    await expect(page.locator('section > div > table > tbody > tr:not(.diff-line-del) .diff-code')).toHaveText(
        lines.slice(1).map(line => ({ l5: 'five', l20: 'twenty' })[line] ?? line),
    );
});

test('a line expanded and selected opens a thread on the new side, on that line', async ({ page }) => {
    await open(page, apart());
    await expander(page, '@@ -59,7 +60,7 @@').getByRole('button', { name: 'Expand down' }).click();

    await row(page, 'l20').locator('.diff-num').nth(1).click();
    await page.getByRole('textbox').fill('Why l20?');
    await page.getByRole('button', { name: 'Add message' }).click();

    await expect(row(page, 'l20').locator('xpath=following-sibling::tr[1]').locator('.thread')).toContainText('Line +21');
});

test('Expand down after the last hunk of a modified file shows the next 20 lines, up to the end of the file', async ({ page }) => {
    await open(page, apart());
    await expect(row(page, 'changed')).toHaveCount(1);
    const last = page.locator('tr.diff-hunk').last();

    await last.getByRole('button', { name: 'Expand down' }).click();
    await expect(row(page, 'l66').locator('.diff-num')).toHaveText(['66', '67']);
    await expect(row(page, 'l85')).toHaveCount(1);
    await expect(row(page, 'l86')).toHaveCount(0);
    await last.getByRole('button', { name: 'Expand all' }).click();

    await expect(row(page, 'l100').locator('.diff-num')).toHaveText(['100', '101']);
    await expect(page.locator('tr.diff-hunk')).toHaveCount(2);
});

test('an Expand stays disabled while its lines are on their way, so a double click asks for them once', async ({ page }) => {
    let asked = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/lines?*', async route => {
        asked++;
        await held;
        await route.continue();
    });
    await open(page, apart());
    const down = expander(page, '@@ -59,7 +60,7 @@').getByRole('button', { name: 'Expand down' });

    await down.click();
    await expect(down).toBeDisabled();
    await down.dblclick({ force: true });
    release();

    await expect(row(page, 'l28')).toHaveCount(1);
    await expect(row(page, 'l48')).toHaveCount(0);
    expect(asked).toBe(1);
});

test('the error of an Expand that failed goes once an Expand succeeds', async ({ page }) => {
    let failed = false;
    await page.route('**/lines?*', route => {
        if (failed) return route.continue();
        failed = true;
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'git failed' }) });
    });
    await open(page, apart());
    const down = expander(page, '@@ -59,7 +60,7 @@').getByRole('button', { name: 'Expand down' });
    await down.click();
    await expect(page.locator('.flash-error')).toHaveText('git failed');

    await down.click();

    await expect(row(page, 'l9')).toHaveCount(1);
    await expect(page.locator('.flash-error')).toHaveCount(0);
});

test('the lines expanded go once the diff reloads, at the Refresh or at a change of base', async ({ page }) => {
    const dir = apart();
    git(dir, 'branch', 'other');
    await open(page, dir);
    const down = expander(page, '@@ -59,7 +60,7 @@').getByRole('button', { name: 'Expand down' });
    await down.click();
    await expect(row(page, 'l9')).toHaveCount(1);

    write(dir, { 'b.txt': 'new\n' });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });
    await expect(page.locator('h1')).toContainText('2 files changed');
    await expect(row(page, 'l9')).toHaveCount(0);

    await down.click();
    await expect(row(page, 'l9')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Base' }).selectOption('refs/heads/other');
    await expect(page.getByRole('combobox', { name: 'Base' })).toHaveValue('refs/heads/other');
    await expect(row(page, 'l9')).toHaveCount(0);
});

test('in Split, the lines of an expanded gap show in both columns', async ({ page }) => {
    await open(page, apart());
    await expect(row(page, 'changed')).toHaveCount(1);
    await page.getByRole('button', { name: 'Diff view settings' }).click();
    await page.getByRole('radio', { name: 'Split' }).check();

    await expander(page, '@@ -59,7 +60,7 @@').getByRole('button', { name: 'Expand up' }).click();

    await expect(row(page, 'l58').locator('.diff-num')).toHaveText(['58', '59']);
    await expect(row(page, 'l58').locator('.diff-code')).toHaveText(['l58', 'l58']);
    await expect(row(page, 'l39').locator('.diff-code')).toHaveText(['l39', 'l39']);
    await expect(row(page, 'l38')).toHaveCount(0);
});
