import { expect, test, type Page } from '@playwright/test';
import { removeRepos, repo, write } from '../server/fixture.ts';

test.afterAll(removeRepos);

// A 1×1 PNG, so the avatar loads without the network.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

type Me = { login: string | null; name: string | null };

/**
 * Opens a worktree with a thread of Claude and my message under it, which `add()` follows with another,
 * `/api/me` answering each of `answers` in turn, then the last one; `reads()` counts its reads.
 */
async function threadOf(page: Page, answers: Me | Me[]) {
    let read = 0;
    await page.route('**/api/me', route => route.fulfill({ json: [answers].flat()[Math.min(read++, [answers].flat().length - 1)] }));
    const dir = repo({ 'a.txt': 'one\ntwo\n' });
    write(dir, { 'a.txt': 'one\n2\n' });
    const { id } = await (await page.request.post('/api/sessions', { data: { worktree: dir } })).json();
    await page.request.post(`/api/sessions/${id}/threads`, { data: { author: 'claude', path: 'a.txt', side: 'new', start: 2, end: 2, body: 'Why 2?' } });
    await page.request.post(`/api/sessions/${id}/threads/1/messages`, { data: { author: 'me', body: 'Because.' } });
    await page.goto(`/?worktree=${encodeURIComponent(dir)}`);
    const messages = page.locator('.thread .Box-row');
    await expect(messages).toHaveCount(2);
    const add = () => page.request.post(`/api/sessions/${id}/threads/1/messages`, { data: { author: 'me', body: 'And then?' } });
    return { claude: messages.nth(0), mine: messages.nth(1), messages, add, reads: () => read };
}

test('the message of Claude shows its logo, square as a GitHub app\'s, and mine my GitHub avatar', async ({ page }) => {
    await page.route('https://github.com/**', route => route.fulfill({ contentType: 'image/png', body: PNG }));

    const { claude, mine } = await threadOf(page, { login: 'octocat', name: 'Mona Lisa' });

    await expect(claude.getByRole('img', { name: 'Claude' })).toBeVisible();
    await expect(claude.getByRole('img', { name: 'Claude' })).toHaveCSS('border-radius', '6px');
    await expect(mine.getByRole('img', { name: '@octocat' })).toHaveAttribute('src', /^https:\/\/github\.com\/octocat\.png\?size=\d+$/);
    await expect(mine.getByRole('img', { name: '@octocat' })).toBeVisible();
});

test('without a login, my message shows my initials in a circle', async ({ page }) => {
    const { mine } = await threadOf(page, { login: null, name: 'Mona Lisa' });

    await expect(mine.locator('.avatar-initials')).toHaveText('ML');
    await expect(mine.locator('img')).toHaveCount(0);
});

test('an initial outside the BMP shows whole', async ({ page }) => {
    const { mine } = await threadOf(page, { login: null, name: '🦊 fox' });

    await expect(mine.locator('.avatar-initials')).toHaveText('🦊F');
});

test('a GitHub avatar that does not load gives way to my initials, and a message of mine written after is not asked for it again', async ({ page }) => {
    let asked = 0;
    await page.route('https://github.com/**', route => { asked++; return route.abort(); });

    const { mine, messages, add } = await threadOf(page, { login: 'octocat', name: 'Mona Lisa' });
    await expect(mine.locator('.avatar-initials')).toHaveText('ML');
    await add();

    await expect(messages.locator('.avatar-initials')).toHaveText(['ML', 'ML']);
    await expect(messages.locator('img')).toHaveCount(0);
    expect(asked).toBe(1);
});

test('a login that comes after the page opened shows at the next poll, and is not read again', async ({ page }) => {
    await page.route('https://github.com/**', route => route.fulfill({ contentType: 'image/png', body: PNG }));

    const { mine, reads } = await threadOf(page, [{ login: null, name: 'Mona Lisa' }, { login: 'octocat', name: 'Mona Lisa' }]);

    await expect(mine.locator('.avatar-initials')).toHaveText('ML');
    await expect(mine.getByRole('img', { name: '@octocat' })).toBeVisible();
    const read = reads();
    await page.waitForTimeout(2500);
    expect(reads()).toBe(read);
});
