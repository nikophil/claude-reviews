import { expect, test, type Page } from '@playwright/test';
import { chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { git, removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

function open(page: Page, worktree: string) {
    return page.goto(`/?worktree=${encodeURIComponent(worktree)}`);
}

/** The computed value of a CSS color expression, in the same format as getComputedStyle. */
function color(page: Page, value: string) {
    return page.evaluate(value => {
        const probe = document.body.appendChild(document.createElement('div'));
        probe.style.color = value;
        const computed = getComputedStyle(probe).color;
        probe.remove();
        return computed;
    }, value);
}

test('the tree lists the changed files, and a click on one brings its diff into view and highlights it', async ({ page }) => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const dir = repo({ 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' });
    write(dir, { 'src/a.txt': `${long}\n`, 'src/b.txt': `${long}\n`, 'z.txt': 'last\n' });
    await open(page, dir);

    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await expect(tree.getByRole('link')).toHaveText(['a.txt', 'b.txt', 'z.txt']);
    await expect(tree).toContainText('src');
    await expect(page.locator('#diff-2')).not.toBeInViewport();

    await tree.getByRole('link', { name: 'z.txt' }).click();

    await expect(page.locator('#diff-2')).toBeInViewport();
    await expect(page.locator('#diff-2')).toContainText('last');
    await expect(tree.getByRole('link', { name: 'z.txt' })).toHaveAttribute('aria-current', 'true');
    await expect(tree.locator('[aria-current]')).toHaveCount(1);
});

test('the collapse button hides the tree and gives the diff the full width, and the expand button shows it again', async ({ page }) => {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(dir, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    const main = page.getByRole('main');
    await expect(tree.getByRole('link')).toHaveCount(2);
    const width = (await main.boundingBox())!.width;

    await page.getByRole('button', { name: 'Collapse file tree' }).click();

    await expect(tree).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand file tree' })).toBeFocused();
    expect((await main.boundingBox())!.x).toBe(0);
    expect((await main.boundingBox())!.width).toBeGreaterThan(width);

    await page.getByRole('button', { name: 'Expand file tree' }).click();

    await expect(tree.getByRole('link')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Collapse file tree' })).toBeFocused();
});

test('the page shows and the file tree folds when the browser storage throws', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } }));
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'a.txt': 'A\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await expect(tree.getByRole('link')).toHaveText(['a.txt']);

    await page.getByRole('button', { name: 'Collapse file tree' }).click();

    await expect(tree).toBeHidden();
});

test('the highlighted file stays the same file after a Refresh adds one before it', async ({ page }) => {
    const dir = repo({ 'b.txt': 'b\n', 'c.txt': 'c\n' });
    write(dir, { 'b.txt': 'B\n', 'c.txt': 'C\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await tree.getByRole('link', { name: 'c.txt' }).click();
    await expect(tree.getByRole('link', { name: 'c.txt' })).toHaveAttribute('aria-current', 'true');

    write(dir, { 'a.txt': 'a\n' });
    await page.getByRole('button', { name: 'Refresh' }).click();

    await expect(tree.getByRole('link')).toHaveText(['a.txt', 'b.txt', 'c.txt']);
    await expect(tree.getByRole('link', { name: 'c.txt' })).toHaveAttribute('aria-current', 'true');
    await expect(tree.locator('[aria-current]')).toHaveCount(1);
});

test('the highlighted file follows the diff when I scroll up after a click', async ({ page }) => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' });
    write(dir, { 'a.txt': `${long}\n`, 'b.txt': `${long}\n`, 'c.txt': `${long}\n`, 'd.txt': `${long}\n` });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await tree.getByRole('link', { name: 'c.txt' }).click();
    await expect(tree.getByRole('link', { name: 'c.txt' })).toHaveAttribute('aria-current', 'true');

    await page.mouse.move(700, 300);
    await page.mouse.wheel(0, -400);

    await expect(tree.getByRole('link', { name: 'b.txt' })).toHaveAttribute('aria-current', 'true');
    await expect(tree.locator('[aria-current]')).toHaveCount(1);
});

test('the first file is highlighted when the diff loads, and a Refresh that drops the highlighted file highlights the one now on top', async ({ page }) => {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(dir, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await expect(tree.getByRole('link', { name: 'a.txt' })).toHaveAttribute('aria-current', 'true');
    await tree.getByRole('link', { name: 'b.txt' }).click();
    await expect(tree.getByRole('link', { name: 'b.txt' })).toHaveAttribute('aria-current', 'true');

    write(dir, { 'b.txt': 'b\n' });
    await page.getByRole('button', { name: 'Refresh' }).click();

    await expect(tree.getByRole('link')).toHaveText(['a.txt']);
    await expect(tree.getByRole('link', { name: 'a.txt' })).toHaveAttribute('aria-current', 'true');
});

test('a folded directory holding the highlighted file is highlighted', async ({ page }) => {
    const dir = repo({ 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' });
    write(dir, { 'src/a.txt': 'A\n', 'src/b.txt': 'B\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await tree.getByRole('link', { name: 'b.txt' }).click();

    await tree.getByRole('button', { name: 'src', exact: true }).click();

    await expect(tree.getByRole('button', { name: 'src', exact: true })).toHaveAttribute('aria-current', 'true');
    await expect(tree.locator('[aria-current]')).toHaveCount(1);
});

test('the highlighted file follows the diff as it scrolls', async ({ page }) => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    write(dir, { 'a.txt': `${long}\n`, 'b.txt': `${long}\n`, 'c.txt': `${long}\n` });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await expect(page.locator('#diff-2')).toContainText('line 79');

    await page.locator('#diff-1 .diff-line-add').nth(10).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, (await page.locator('#diff-1').boundingBox())!.y + 100);

    await expect(tree.getByRole('link', { name: 'b.txt' })).toHaveAttribute('aria-current', 'true');
    await expect(tree.locator('[aria-current]')).toHaveCount(1);
});

test('a file out of the diff with an open thread is in the tree, with a neutral badge, and a click on it brings it into view', async ({ page, request }) => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const dir = repo({ 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
    write(dir, { 'a.txt': 'one\n2\n' });
    const { id } = await (await request.post('/api/sessions', { data: { worktree: dir } })).json();
    expect((await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side: 'new', start: 2, end: 2, body: 'Why 2?' } })).status()).toBe(200);
    git(dir, 'commit', '-q', '-am', 'two');
    write(dir, { 'b.txt': `${long}\n` });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    const file = tree.getByRole('link', { name: 'a.txt' });

    await expect(file.getByRole('img', { name: 'Unchanged' })).toBeVisible();
    await expect(page.locator('#diff-1')).not.toBeInViewport();

    await file.click();

    await expect(page.locator('#diff-1')).toBeInViewport();
    await expect(page.locator('#diff-1')).toContainText('Why 2?');
});

test('the collapsed tree stays collapsed after a reload', async ({ page }) => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'a.txt': 'A\n' });
    await open(page, dir);
    await page.getByRole('button', { name: 'Collapse file tree' }).click();
    await expect(page.getByRole('navigation', { name: 'Changed files' })).toBeHidden();

    await page.reload();

    await expect(page.locator('#diff-0')).toContainText('A');
    await expect(page.getByRole('button', { name: 'Expand file tree' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Changed files' })).toBeHidden();
});

test('a click on a directory hides its files, and another click shows them', async ({ page }) => {
    const dir = repo({ 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' });
    write(dir, { 'src/a.txt': 'A\n', 'src/b.txt': 'B\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    const folder = tree.getByRole('button', { name: 'src', exact: true });
    await expect(tree.getByRole('link')).toHaveText(['a.txt', 'b.txt']);

    await folder.click();

    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(tree.getByRole('link')).toHaveCount(0);

    await folder.click();

    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(tree.getByRole('link')).toHaveText(['a.txt', 'b.txt']);
});

test('directories named like object keys or numbers keep the order of the diff', async ({ page }) => {
    const dir = repo({});
    write(dir, { '.github/a.yml': 'a\n', '2024/b.txt': 'b\n', 'constructor/c.txt': 'c\n', '__proto__/d.txt': 'd\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });

    await expect(tree.getByRole('button', { expanded: true })).toHaveText(['.github', '2024', '__proto__', 'constructor']);
    await expect(tree.getByRole('link')).toHaveText(['a.yml', 'b.txt', 'd.txt', 'c.txt']);
});

test('a folded directory stays folded when a Refresh merges it with its only child', async ({ page }) => {
    const dir = repo({ 'src/x.txt': 'x\n', 'src/lib/y.txt': 'y\n' });
    write(dir, { 'src/x.txt': 'X\n', 'src/lib/y.txt': 'Y\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });
    await tree.getByRole('button', { name: 'src', exact: true }).click();
    await expect(tree.getByRole('link')).toHaveCount(0);

    write(dir, { 'src/x.txt': 'x\n' });
    await page.getByRole('button', { name: 'Refresh' }).click();

    await expect(tree.getByRole('button', { name: 'src/lib' })).toHaveAttribute('aria-expanded', 'false');
    await expect(tree.getByRole('link')).toHaveCount(0);
});

test('a directory whose only child is a directory shares its line', async ({ page }) => {
    const dir = repo({ 'a/b/c.ts': 'let c = 1;\n' });
    write(dir, { 'a/b/c.ts': 'let c = 2;\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });

    await expect(tree.getByRole('button', { expanded: true })).toHaveText(['a/b']);
    await expect(tree.getByRole('link')).toHaveText(['c.ts']);
});

test('an added, a deleted and a modified file wear their status badge', async ({ page }) => {
    const dir = repo({ 'deleted.txt': 'd\n', 'modified.txt': 'm\n' });
    rmSync(join(dir, 'deleted.txt'));
    write(dir, { 'added.txt': 'a\n', 'modified.txt': 'M\n' });
    await open(page, dir);
    const tree = page.getByRole('navigation', { name: 'Changed files' });

    for (const [file, status, fg] of [['added.txt', 'Added', 'success'], ['deleted.txt', 'Deleted', 'danger'], ['modified.txt', 'Modified', 'attention']]) {
        const badge = tree.getByRole('link', { name: file }).getByRole('img', { name: status });
        await expect(badge).toBeVisible();
        await expect(badge).toHaveCSS('color', await color(page, `var(--fgColor-${fg})`));
    }
});

test('a TypeScript diff wears the Primer diff colors and highlight.js syntax colors', async ({ page }) => {
    const dir = repo({ 'main.ts': 'const a = 1;\n' });
    write(dir, { 'main.ts': 'const a = 2;\n' });
    await open(page, dir);

    const added = page.locator('.diff-line-add .diff-code');
    const deleted = page.locator('.diff-line-del .diff-code');
    await expect(added).toHaveCSS('background-color', await color(page, 'var(--diffBlob-addition-bgColor-line)'));
    await expect(deleted).toHaveCSS('background-color', await color(page, 'var(--diffBlob-deletion-bgColor-line)'));
    await expect(added.locator('.hljs-keyword')).toHaveText('const');
    await expect(added.locator('.hljs-keyword')).toHaveCSS('color', await color(page, 'var(--color-prettylights-syntax-keyword)'));
});

test('a lockfile diff arrives collapsed, and Load diff shows it', async ({ page }) => {
    const dir = repo({ 'package-lock.json': '{ "v": 1 }\n' });
    write(dir, { 'package-lock.json': '{ "v": 2 }\n' });
    await open(page, dir);

    const file = page.locator('#diff-0');
    await expect(file).toContainText('package-lock.json');
    await expect(file.locator('.diff-line-add')).toHaveCount(0);

    await file.getByRole('button', { name: 'Load diff' }).click();

    await expect(file.locator('.diff-line-add')).toHaveText(/"v": 2/);
});

test('a binary file shows as not shown', async ({ page }) => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x01]) });
    await open(page, dir);

    await expect(page.locator('#diff-0')).toContainText('Binary file not shown');
});

test('a mode change alone or an empty file explains itself instead of an empty box', async ({ page }) => {
    const dir = repo({ 'script.sh': 'echo hi\n', 'old-empty.txt': '' });
    chmodSync(join(dir, 'script.sh'), 0o755);
    rmSync(join(dir, 'old-empty.txt'));
    write(dir, { 'new-empty.txt': '' });
    await open(page, dir);

    await expect(page.locator('section', { hasText: 'new-empty.txt' })).toContainText('Empty file');
    await expect(page.locator('section', { hasText: 'old-empty.txt' })).toContainText('Empty file');
    await expect(page.locator('section', { hasText: 'script.sh' })).toContainText('File mode changed');
});

test('a file turned into a symlink shows both of its diffs, with the missing newline note', async ({ page }) => {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    rmSync(join(dir, 'a.txt'));
    symlinkSync('b.txt', join(dir, 'a.txt'));
    await open(page, dir);

    await expect(page.locator('section')).toHaveCount(2);
    await expect(page.locator('#diff-0 .diff-line-del .diff-code')).toHaveText('a');
    await expect(page.locator('#diff-1 .diff-line-add .diff-code')).toHaveText('b.txt');
    await expect(page.locator('#diff-1 .diff-line-note .diff-code')).toHaveText('No newline at end of file');
});

test('an API error shows its message',async ({ page }) => {
    await open(page, '/no/such/worktree');

    await expect(page.locator('.flash-error')).toContainText('/no/such/worktree');
});

test('the page requests nothing but the local server',async ({ page, baseURL }) => {
    const urls: string[] = [];
    page.on('request', request => { urls.push(request.url()); });
    const dir = repo({ 'main.ts': 'let a = 1;\n' });
    write(dir, { 'main.ts': 'let a = 2;\n' });

    await open(page, dir);
    await expect(page.locator('.diff-line-add')).toBeVisible();

    expect(urls.length).toBeGreaterThan(4);
    expect(urls.filter(url => !url.startsWith(`${baseURL}/`))).toEqual([]);
});

test('the threads of a lockfile collapsed show above Load diff, and a folded file counts its threads not Resolved', async ({ page, request }) => {
    const dir = repo({ 'package-lock.json': '{ "v": 1 }\n', 'a.txt': 'a\n' });
    write(dir, { 'package-lock.json': '{ "v": 2 }\n', 'a.txt': 'b\n' });
    const { id } = await (await request.post('/api/sessions', { data: { worktree: dir } })).json();
    for (const path of ['package-lock.json', 'a.txt']) {
        await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path, side: 'new', start: 1, end: 1, body: `About ${path}` } });
    }
    const { tree } = await (await request.get(`/api/sessions/${id}/tree`)).json();
    await request.post(`/api/sessions/${id}/viewed`, { data: { path: 'a.txt', tree, viewed: true } });
    await open(page, dir);

    const lockfile = page.locator('section[data-path="package-lock.json"]');
    await expect(lockfile.getByRole('button', { name: 'Load diff' })).toBeVisible();
    await expect(lockfile.locator('.thread')).toContainText('About package-lock.json');
    const viewed = page.locator('section[data-path="a.txt"]');
    await expect(viewed.locator('.thread')).toBeHidden();
    await expect(viewed.locator('.file-header')).toContainText('1 thread');
});
