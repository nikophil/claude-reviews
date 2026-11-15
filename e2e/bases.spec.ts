import { expect, test, type Page } from './fixtures.ts';
import { git, removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

function open(page: Page, worktree: string) {
    return page.goto(`/?worktree=${encodeURIComponent(worktree)}`);
}

/** A worktree whose a.txt has line 2 changed. */
function changed(): string {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
    write(dir, { 'a.txt': 'one\n2\nthree\nfour\n' });
    return dir;
}

const banner = (page: Page) => page.getByText('The code changed since it was loaded');
const base = (page: Page) => page.getByRole('combobox', { name: 'Base' });
const lastReview = (page: Page) => base(page).locator('option[value="last-review"]');

test('Since my last review is grayed out until the first Send', async ({ page }) => {
    await open(page, changed());
    await expect(base(page)).toHaveValue('HEAD');
    await expect(lastReview(page)).toBeDisabled();

    await page.getByRole('button', { name: 'Send' }).click();

    await expect(lastReview(page)).toBeEnabled();
});

test('the base chosen stays selected after a reload', async ({ page }) => {
    const dir = changed();
    git(dir, 'branch', 'other');
    await open(page, dir);

    await base(page).selectOption('refs/heads/other');
    await expect(base(page)).toHaveValue('refs/heads/other');
    await page.reload();

    await expect(base(page)).toHaveValue('refs/heads/other');
});

test('the selector names the default and base branches, then groups the other branches', async ({ page }) => {
    const dir = changed();
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    // Both on HEAD: the first by name is the base branch.
    git(dir, 'branch', 'alpha');
    git(dir, 'branch', 'beta');
    await open(page, dir);

    await expect(base(page).locator('option[value="origin/HEAD"]')).toHaveText('main (default branch)');
    await expect(base(page).locator('option[value="refs/heads/alpha"]')).toHaveText(/\(base branch\)/);
    await expect(base(page).locator('optgroup[label="Local branches"] option')).toHaveCount(1);
});

test('a change of the worktree shows the banner without touching the diff, and Refresh loads it, keeping my draft', async ({ page }) => {
    const dir = changed();
    await open(page, dir);
    await page.locator('.diff-line-add .diff-num').nth(1).click();
    await page.getByRole('textbox').fill('My draft');

    write(dir, { 'a.txt': 'one\n2\nthree\n4\n' });

    await expect(banner(page)).toBeVisible({ timeout: 4000 });
    await expect(page.locator('.diff-line-add')).toHaveCount(1);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.diff-line-add')).toHaveText([/2/, /4/]);
    await expect(banner(page)).toBeHidden();
    await expect(page.getByRole('textbox')).toHaveValue('My draft');
});

test('a Refresh after a Send puts Since my last review forward', async ({ page }) => {
    const dir = changed();
    await open(page, dir);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(lastReview(page)).toBeEnabled();
    await expect(lastReview(page)).not.toContainText('new changes');

    write(dir, { 'a.txt': 'one\n2\nthree\n4\n' });
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 4000 });

    await expect(lastReview(page)).toContainText('new changes');
    await expect(base(page)).toHaveClass(/color-border-accent-emphasis/);
});

test('a Send with the banner up snapshots the displayed code, and the change not loaded shows Since my last review', async ({ page }) => {
    const dir = changed();
    await open(page, dir);
    await expect(page.locator('.diff-line-add')).toHaveText([/2/]);
    write(dir, { 'a.txt': 'one\n2\nthree\nnot loaded\n' });
    await expect(banner(page)).toBeVisible({ timeout: 4000 });

    await page.getByRole('button', { name: 'Send' }).click();
    await expect(lastReview(page)).toBeEnabled();
    await base(page).selectOption('last-review');

    await expect(page.locator('.diff-line-add')).toHaveText([/not loaded/]);
    await expect(page.locator('.diff-line-del')).toHaveText([/four/]);
    await expect(banner(page)).toBeHidden();
});

test('a message being written survives a base where its thread leaves the diff', async ({ page, request }) => {
    const dir = changed();
    const { id } = await (await request.post('/api/sessions', { data: { worktree: dir } })).json();
    await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side: 'new', start: 2, end: 2, body: 'Why 2?' } });
    await open(page, dir);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(lastReview(page)).toBeEnabled();
    await page.locator('.thread').getByRole('textbox').fill('Because');

    // Nothing changed since the Send: the diff is empty, and the thread shows out of it, in a hunk of its own.
    await base(page).selectOption('last-review');
    await expect(page.locator('.diff-line-add')).toHaveCount(0);
    await expect(page.locator('.thread').getByRole('textbox')).toHaveValue('Because');
    await base(page).selectOption('HEAD');
    await expect(page.locator('.diff-line-add')).toHaveCount(1);

    await expect(page.locator('.thread').getByRole('textbox')).toHaveValue('Because');
});

test('the base shown follows the diff when a branch without merge-base falls back on HEAD', async ({ page }) => {
    const dir = changed();
    // A branch with a history of its own: no merge-base with HEAD.
    git(dir, 'branch', 'unrelated', git(dir, 'commit-tree', '-m', 'unrelated', git(dir, 'hash-object', '-t', 'tree', '/dev/null').trim()).trim());
    await open(page, dir);

    await base(page).selectOption('refs/heads/unrelated');

    await expect(page.locator('.diff-line-add')).toHaveText([/2/]);
    await expect(base(page)).toHaveValue('HEAD');
});

test('a Send under Since my last review without any change of the code shows no banner', async ({ page }) => {
    await open(page, changed());
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(lastReview(page)).toBeEnabled();
    await base(page).selectOption('last-review');
    // A Snapshot commit is dated to the second: one second later, the same tree makes another commit.
    await page.waitForTimeout(1000);

    const sent = page.waitForResponse(/\/send\?/);
    await page.getByRole('button', { name: 'Send' }).click();
    await sent;
    // A poll leaves after the Send and sees its Snapshot; the next one leaves once its answer is applied.
    await page.waitForRequest(/\/tree$/);
    await page.waitForRequest(/\/tree$/);

    await expect(banner(page)).toBeHidden();
});

test('a poll answered after a change of base shows no banner', async ({ page }) => {
    const dir = changed();
    git(dir, 'branch', 'other');
    write(dir, { 'b.txt': 'b\n' });
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', 'b');
    let release!: () => void;
    const released = new Promise<void>(resolve => release = resolve);
    let held!: () => void;
    const holding = new Promise<void>(resolve => held = resolve);
    let first = true;
    // The first poll reads the tree against HEAD, and answers once the diff against other is shown; the next ones fail.
    await page.route(/\/tree$/, async route => {
        if (!first) return route.abort();
        first = false;
        const response = await route.fetch();
        held();
        await released;
        await route.fulfill({ response });
    });
    await open(page, dir);
    await holding;

    await base(page).selectOption('refs/heads/other');
    await expect(page.locator('section')).toHaveCount(2);
    release();
    // The next poll leaves once the late answer is applied.
    await page.waitForRequest(/\/tree$/);

    await expect(banner(page)).toBeHidden();
});

test('a slow change of base shows no banner while its diff loads', async ({ page }) => {
    const dir = changed();
    git(dir, 'branch', 'other');
    git(dir, 'commit', '-qam', 'Committed');
    await open(page, dir);
    await expect(page.getByText('0 files changed')).toBeVisible();
    await page.route('**/diff*', async route => {
        await new Promise(resolve => setTimeout(resolve, 4000));
        await route.continue();
    });

    await base(page).selectOption('refs/heads/other');
    await page.waitForTimeout(3000);

    // Checked once, before the diff loads: a retried check would pass once it loaded.
    expect(await banner(page).isVisible()).toBe(false);
});
