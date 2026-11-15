import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { IMAGES, project, ROOT } from './readme.ts';

// The images of the README, made again by `npm run readme`; skipped by the test runs.
test.skip(!process.env.README, 'npm run readme makes the images of the README');

async function session(request: APIRequestContext, worktree: string): Promise<{ id: string; base: string; tree: string }> {
    const { id } = await (await request.post('/api/sessions', { data: { worktree } })).json();
    const { base, tree } = await (await request.get(`/api/sessions/${id}/tree`)).json();
    return { id, base, tree };
}

async function post(request: APIRequestContext, path: string, data: object) {
    const res = await request.post(path, { data });
    expect(res.status(), path).toBe(200);
}

/** The page as a reader of the README sees it: no real login, and a Claude session that listens. */
async function stage(page: Page, request: APIRequestContext, worktree: string) {
    await page.setViewportSize({ width: 1440, height: 820 });
    await page.route('**/api/me', route => route.fulfill({ json: { login: null, name: 'Ada Lovelace' } }));
    // As the mod does every 2 s: the page then shows no warning about a missing Claude session.
    const listen = () => request.get(`/api/sessions?worktree=${encodeURIComponent(worktree)}&claude`).catch(() => {});
    await listen();
    return setInterval(listen, 2000);
}

test('the images of the README', async ({ page, request }) => {
    test.setTimeout(120_000);
    rmSync(ROOT, { recursive: true, force: true });
    const shop = project('acme-shop', 'vat-per-line');
    const api = project('acme-api', 'pdf-invoices');
    project('acme-admin', 'export-csv');
    const { id, base, tree } = await session(request, shop);
    const mine = { author: 'me', base, tree, path: 'src/cart.ts', side: 'new' };
    await post(request, `/api/sessions/${id}/threads`, { ...mine, start: 3, end: 3, body: 'Pourquoi arrondir à chaque total, plutôt qu’à l’affichage ?' });
    await post(request, `/api/sessions/${id}/threads`, { author: 'claude', path: 'src/cart.ts', side: 'new', start: 9, end: 11, body: 'J’ai mis le taux de TVA sur chaque ligne : une facture peut mêler 5,5 % et 20 %.' });
    await post(request, `/api/sessions/${id}/send`, { tree });
    await post(request, `/api/sessions/${id}/threads/1/messages`, {
        author: 'claude',
        body: 'Pour que `total` et `totalWithVat` rendent des montants au centime : la facture les additionne ensuite, et `format` arrondit trop tard pour cette somme.',
    });
    await post(request, `/api/sessions/${id}/threads/2/messages`, { author: 'me', body: 'OK, merci.' });
    await post(request, `/api/sessions/${id}/threads/2/resolve`, {});
    for (const other of [api, join(ROOT, 'acme-admin')]) {
        const { id: otherId, tree: otherTree } = await session(request, other);
        await post(request, `/api/sessions/${otherId}/threads`, { author: 'claude', path: 'src/cart.ts', side: 'new', start: 1, end: 1, body: 'Ici ?' });
        await post(request, `/api/sessions/${otherId}/threads/1/messages`, { author: 'me', body: 'Oui.' });
        await post(request, `/api/sessions/${otherId}/send`, { tree: otherTree });
    }
    const listening = await stage(page, request, shop);
    await page.goto(`/s/${id}`);
    const cart = page.locator('section[data-path="src/cart.ts"]');
    await expect(cart.locator('.thread')).toHaveCount(2);
    await expect(page.getByText('No Claude session')).toHaveCount(0, { timeout: 5000 });
    mkdirSync(IMAGES, { recursive: true });

    // The animation: a thread opened on a line, a Send, Claude's reply, a Resolve.
    const frames: { png: Buffer; delay: number }[] = [];
    const frame = async (delay = 1200) => frames.push({ png: await page.screenshot(), delay });
    const format = cart.locator('.diff-line-add', { hasText: 'Intl.NumberFormat' });
    await format.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 260);
    await frame();
    await format.locator('.diff-num').nth(1).click();
    await frame();
    const composer = page.locator('form', { has: page.getByRole('button', { name: 'Cancel' }) });
    await composer.getByRole('button', { name: 'Suggest change' }).click();
    const box = composer.getByRole('textbox');
    const suggested = 'Gardons deux décimales, même pour un montant rond.\n\n```suggestion\n'
        + "    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(amount);\n```\n";
    await box.fill(suggested.slice(0, 51));
    await frame(900);
    await box.fill(suggested);
    await frame(1600);
    await composer.getByRole('button', { name: 'Add message' }).click();
    await expect(cart.locator('.thread')).toHaveCount(3);
    await frame(1600);
    await page.getByRole('button', { name: 'Send' }).click();
    const thread = page.locator('#thread-3');
    await expect(thread).toContainText('Waiting for Claude');
    // The click scrolled up to Send: back to the thread.
    await thread.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await frame(1600);
    await post(request, `/api/sessions/${id}/threads/3/messages`, { author: 'claude', body: 'Fait : `format(10)` rend maintenant « 10,00 € ».' });
    await expect(thread).toContainText('Fait :', { timeout: 5000 });
    await frame(2400);
    await thread.getByRole('button', { name: 'Resolve' }).click();
    await expect(thread).toContainText('Resolved');
    await frame(3000);
    writeFileSync(join(IMAGES, 'review.png'), apng(frames));

    await page.goto(`/s/${id}`);
    await expect(cart.locator('.thread')).toHaveCount(3);
    await page.getByRole('button', { name: /\d+ conversations?/ }).click();
    await page.screenshot({ path: join(IMAGES, 'files-changed.png') });
    await page.goto('/');
    await expect(page.getByRole('link')).toHaveCount(3);
    await page.screenshot({ path: join(IMAGES, 'reviews.png'), clip: { x: 0, y: 0, width: 1440, height: 280 } });
    clearInterval(listening);
});

/**
 * An animated PNG of screenshots of one size, each shown `delay` ms: their compressed data goes as it is into the frames,
 * so no encoder is needed, and browsers, GitHub's included, play it.
 */
function apng(frames: { png: Buffer; delay: number }[]): Buffer {
    const chunks = (png: Buffer) => {
        const found: { type: string; data: Buffer }[] = [];
        for (let i = 8; i < png.length; i += 12 + png.readUInt32BE(i)) found.push({ type: png.toString('latin1', i + 4, i + 8), data: png.subarray(i + 8, i + 8 + png.readUInt32BE(i)) });
        return found;
    };
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const head = Buffer.alloc(4);
        head.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([head, body, crc]);
    };
    const header = chunks(frames[0].png).find(({ type }) => type === 'IHDR')!.data;
    const control = Buffer.alloc(8);
    control.writeUInt32BE(frames.length, 0);
    const parts = [frames[0].png.subarray(0, 8), chunk('IHDR', header), chunk('acTL', control)];
    let sequence = 0;
    frames.forEach(({ png, delay }, i) => {
        const frameControl = Buffer.alloc(26);
        frameControl.writeUInt32BE(sequence++, 0);
        frameControl.writeUInt32BE(header.readUInt32BE(0), 4);
        frameControl.writeUInt32BE(header.readUInt32BE(4), 8);
        frameControl.writeUInt16BE(delay, 20);
        frameControl.writeUInt16BE(1000, 22);
        parts.push(chunk('fcTL', frameControl));
        for (const { data } of chunks(png).filter(({ type }) => type === 'IDAT')) {
            if (i === 0) {
                parts.push(chunk('IDAT', data));
            } else {
                const number = Buffer.alloc(4);
                number.writeUInt32BE(sequence++);
                parts.push(chunk('fdAT', Buffer.concat([number, data])));
            }
        }
    });
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}
