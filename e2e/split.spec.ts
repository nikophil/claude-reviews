import { expect, test, type APIRequestContext, type Page } from './fixtures.ts';
import { git, removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

function open(page: Page, worktree: string) {
    return page.goto(`/?worktree=${encodeURIComponent(worktree)}`);
}

/** A worktree whose a.txt gains a first line and has its old line 2 replaced. */
function changed(): string {
    const dir = repo({ 'a.txt': 'one\ntwo\nthree\n' });
    write(dir, { 'a.txt': 'zero\none\n2\nthree\n' });
    return dir;
}

async function choose(page: Page, view: 'Unified' | 'Split') {
    await page.getByRole('button', { name: 'Diff view settings' }).click();
    await page.getByRole('radio', { name: view }).check();
}

/** The row under a diff row, that holds its threads. */
const under = (page: Page, text: string) => row(page, text).locator('xpath=following-sibling::tr[1]');

/** Whether a thread lies under the right half of the diff, and not under the left one. */
async function onTheRight(page: Page, text: string) {
    const thread = (await under(page, text).locator('.thread').boundingBox())!;
    const added = (await row(page, text).locator('.diff-num').last().boundingBox())!;
    return thread.x >= added.x;
}

/** The diff row of a line, by its text, out of the excerpts of Outdated threads. */
const row = (page: Page, text: string) => page.locator('section > div > table > tbody > tr', { has: page.locator('.diff-code', { hasText: new RegExp(`^${text}$`) }) });

test('in Split, the old code is on the left and the new on the right, a deleted line facing the added line that replaces it', async ({ page }) => {
    await open(page, changed());
    await expect(row(page, 'zero')).toHaveCount(1);

    await choose(page, 'Split');

    await expect(row(page, 'zero').locator('.diff-num')).toHaveText(['1']);
    await expect(row(page, 'one').locator('.diff-num')).toHaveText(['1', '2']);
    await expect(row(page, 'one').locator('.diff-code')).toHaveText(['one', 'one']);
    await expect(row(page, 'two').locator('.diff-num')).toHaveText(['2', '3']);
    await expect(row(page, 'two').locator('.diff-code')).toHaveText(['two', '2']);
    const old = (await row(page, 'two').locator('.diff-line-del').last().boundingBox())!;
    const added = (await row(page, 'two').locator('.diff-line-add').first().boundingBox())!;
    expect(old.x + old.width).toBeLessThanOrEqual(added.x);
    expect(old.width).toBeGreaterThan(200);
});

test('the Split view stays after a reload', async ({ page }) => {
    await open(page, changed());
    await choose(page, 'Split');
    await expect(row(page, 'two').locator('.diff-code')).toHaveText(['two', '2']);

    await page.reload();

    await expect(row(page, 'two').locator('.diff-code')).toHaveText(['two', '2']);
    await page.getByRole('button', { name: 'Diff view settings' }).click();
    await expect(page.getByRole('radio', { name: 'Split' })).toBeChecked();
});

test('in Split, a range selected on the right opens a thread on the new side, under the right half', async ({ page }) => {
    await open(page, changed());
    await choose(page, 'Split');

    await row(page, 'two').locator('.diff-num').last().click();
    await row(page, 'three').locator('.diff-num').last().click({ modifiers: ['Shift'] });
    await expect(page.locator('td.selected')).toHaveCount(4);
    await page.getByRole('textbox').fill('Why?');
    await page.getByRole('button', { name: 'Add message' }).click();

    await expect(under(page, 'three').locator('.thread')).toContainText('Lines +3 to +4');
    expect(await onTheRight(page, 'three')).toBe(true);
});

test('in Split, a deleted line selected on the left opens a thread on the old side, under the left half', async ({ page }) => {
    await open(page, changed());
    await choose(page, 'Split');

    await row(page, 'two').locator('.diff-num').first().click();
    await page.getByRole('textbox').fill('Why not two?');
    await page.getByRole('button', { name: 'Add message' }).click();

    await expect(under(page, 'two').locator('.thread')).toContainText('Line -2');
    expect(await onTheRight(page, 'two')).toBe(false);
});

/** Opens a thread as Claude does, through the API, on one line of a.txt. */
async function claudeThread(request: APIRequestContext, worktree: string, side: 'old' | 'new', line: number, body: string) {
    const { id } = await (await request.post('/api/sessions', { data: { worktree } })).json();
    const res = await request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side, start: line, end: line, body } });
    expect(res.status()).toBe(200);
}

test('a thread shows at the same line in Unified and in Split, with the message being written', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 'old', 2, 'Old two');
    await claudeThread(request, dir, 'new', 1, 'New zero');
    await open(page, dir);
    const old = page.locator('.thread', { hasText: 'Old two' });
    await expect(old).toContainText('Line -2');
    await old.getByRole('textbox').fill('My draft');

    await choose(page, 'Split');

    await expect(under(page, 'two').locator('.thread')).toContainText('Old two');
    expect(await onTheRight(page, 'two')).toBe(false);
    await expect(under(page, 'zero').locator('.thread')).toContainText('New zero');
    expect(await onTheRight(page, 'zero')).toBe(true);
    await expect(old.getByRole('textbox')).toHaveValue('My draft');

    await choose(page, 'Unified');

    await expect(under(page, 'two').locator('.thread')).toContainText('Old two');
    await expect(under(page, 'zero').locator('.thread')).toContainText('New zero');
    await expect(old.getByRole('textbox')).toHaveValue('My draft');
});

test('an Outdated thread shows in Split, with its original excerpt', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 'new', 3, 'Why 2?');
    write(dir, { 'a.txt': 'zero\none\ndeux\nthree\n' });
    await open(page, dir);
    await choose(page, 'Split');

    const thread = page.locator('.thread');
    await expect(thread).toContainText('Outdated');
    await expect(thread.locator('.diff-line-del .diff-code')).toHaveText('two');
    await expect(row(page, 'two').locator('.diff-code')).toHaveText(['two', 'deux']);
});

test('in Split, a line added after a line without newline at end of file faces an empty side, not the note', async ({ page }) => {
    const dir = repo({ 'a.txt': 'foo' });
    write(dir, { 'a.txt': 'foo\nbar\n' });
    await open(page, dir);
    await choose(page, 'Split');

    await expect(row(page, 'foo').locator('.diff-code')).toHaveText(['foo', 'foo']);
    await expect(row(page, 'bar').locator('.diff-code')).toHaveText(['bar']);
    await expect(row(page, 'bar').locator('.diff-empty')).toHaveCount(1);
    await expect(page.getByText('No newline at end of file')).toBeVisible();
});

test('a thread keeps its fold when the view changes', async ({ page, request }) => {
    const dir = changed();
    await claudeThread(request, dir, 'old', 2, 'Old two');
    await claudeThread(request, dir, 'new', 1, 'New zero');
    await open(page, dir);
    const old = page.locator('.thread', { hasText: 'Line -2' });
    const zero = page.locator('.thread', { hasText: 'Line +1' });
    await old.getByRole('button', { name: 'Resolve' }).click();
    await expect(old.getByText('Old two')).toBeHidden();
    await old.getByText('Line -2').click();
    await zero.getByText('Line +1').click();
    await expect(old.getByText('Old two')).toBeVisible();
    await expect(zero.getByText('New zero')).toBeHidden();

    await choose(page, 'Split');

    await expect(old.getByText('Old two')).toBeVisible();
    await expect(zero.getByText('New zero')).toBeHidden();
});

test('in Split, the line numbers widen to the largest of the file', async ({ page }) => {
    const lines = Array.from({ length: 100002 }, (_, i) => `l${i + 1}`);
    const dir = repo({ 'a.txt': `${lines.join('\n')}\n` });
    lines[100000] = 'changed';
    write(dir, { 'a.txt': `${lines.join('\n')}\n` });
    await open(page, dir);
    await choose(page, 'Split');

    const nums = row(page, 'l100001').locator('.diff-num');
    await expect(nums).toHaveText(['100001', '100001']);
    // The number fits in its cell, within its padding.
    for (const num of await nums.all()) {
        expect(await num.evaluate(td => {
            const range = document.createRange();
            range.selectNodeContents(td);
            return range.getBoundingClientRect().right <= td.getBoundingClientRect().right - parseFloat(getComputedStyle(td).paddingRight);
        })).toBe(true);
    }
});

test('the settings menu closes on Escape, and once a view is chosen', async ({ page }) => {
    await open(page, changed());
    const settings = page.getByRole('button', { name: 'Diff view settings' });
    const split = page.getByRole('radio', { name: 'Split' });

    await settings.click();
    await expect(split).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(split).toBeHidden();

    await settings.click();
    await split.check();
    await expect(split).toBeHidden();
    await expect(row(page, 'two').locator('.diff-code')).toHaveText(['two', '2']);
});

/** Whether a row holds a single number and a single code cell, the code reaching the right edge of the table, over most of its width. */
async function fullWidth(page: Page, text: string) {
    const line = row(page, text);
    if (await line.locator('.diff-num').count() !== 1 || await line.locator('.diff-code').count() !== 1) return false;
    const code = (await line.locator('.diff-code').boundingBox())!;
    const table = (await line.locator('xpath=ancestor::table[1]').boundingBox())!;
    return Math.abs(code.x + code.width - (table.x + table.width)) <= 1 && code.width > table.width * 0.8;
}

test('in Split, a new file takes the whole width on a single column, a modified file two columns', async ({ page }) => {
    const dir = changed();
    write(dir, { 'b.txt': 'b1\nb2' });
    await open(page, dir);
    await expect(row(page, 'b1')).toHaveCount(1);

    await choose(page, 'Split');

    await expect(row(page, 'two').locator('.diff-code')).toHaveText(['two', '2']);
    await expect(row(page, 'b1').locator('.diff-num')).toHaveText(['1']);
    await expect.poll(() => fullWidth(page, 'b1')).toBe(true);
    await expect.poll(() => fullWidth(page, 'b2')).toBe(true);
    await expect(page.getByText('No newline at end of file')).toBeVisible();
});

test('in Split, a modified file that only adds lines keeps two columns', async ({ page }) => {
    const dir = repo({ 'a.txt': '' });
    write(dir, { 'a.txt': 'added1\nadded2\n' });
    await open(page, dir);
    await expect(row(page, 'added1')).toHaveCount(1);

    await choose(page, 'Split');

    await expect(row(page, 'added1').locator('.diff-empty')).toHaveCount(1);
    expect(await fullWidth(page, 'added1')).toBe(false);
});

test('in Split, a deleted file takes the whole width on a single column, where a line selected opens a thread on the old side', async ({ page }) => {
    const dir = repo({ 'a.txt': 'gone1\ngone2\n' });
    git(dir, 'rm', '-q', 'a.txt');
    await open(page, dir);
    await expect(row(page, 'gone1')).toHaveCount(1);

    await choose(page, 'Split');

    await expect(row(page, 'gone2').locator('.diff-num')).toHaveText(['2']);
    await expect.poll(() => fullWidth(page, 'gone1')).toBe(true);

    await row(page, 'gone2').locator('.diff-num').click();
    await page.getByRole('textbox').fill('Why gone?');
    await page.getByRole('button', { name: 'Add message' }).click();

    await expect(under(page, 'gone2').locator('.thread')).toContainText('Line -2');
});

test('in Split, a range selected in a new file opens a thread on the new side', async ({ page }) => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'b.txt': 'b1\nb2\nb3\n' });
    await open(page, dir);
    await choose(page, 'Split');

    await row(page, 'b2').locator('.diff-num').click();
    await row(page, 'b3').locator('.diff-num').click({ modifiers: ['Shift'] });
    await page.getByRole('textbox').fill('Why?');
    await page.getByRole('button', { name: 'Add message' }).click();

    await expect(under(page, 'b3').locator('.thread')).toContainText('Lines +2 to +3');
});
