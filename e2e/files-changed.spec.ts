import { expect, test, type Page } from '@playwright/test';
import { chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { removeRepos, repo, write } from '../server/fixture.ts';

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

test('the tree lists the changed files, and a click on one brings its diff into view', async ({ page }) => {
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
