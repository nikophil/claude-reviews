import { test as base } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export { expect, type APIRequestContext, type Page } from '@playwright/test';

// The data directory of the server of the run: playwright.config.ts's, or playwright.vscode.config.ts's.
const endpoint = join((process.env.CLAUDE_REVIEWS_E2E_DATA ?? process.env.CLAUDE_REVIEWS_VSCODE_DATA)!, 'claude-reviews', 'endpoint');

/** The token of the test server, from its endpoint file, read once the server has written it. */
let cached = '';
async function readToken(): Promise<string> {
    for (let probe = 0; !cached && probe < 50; probe++) {
        try { cached = JSON.parse(readFileSync(endpoint, 'utf8')).token ?? ''; } catch {}
        if (!cached) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return cached;
}

export const test = base.extend<{ token: string }>({
    token: async ({}, use) => { await use(await readToken()); },
    // The direct API calls of the tests carry the token, as the clients do.
    request: async ({ playwright, baseURL }, use) => {
        const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${await readToken()}` } });
        await use(context);
        await context.dispose();
    },
    page: async ({ page, request }, use) => {
        const token = await readToken();
        // A page of the app opens with #token=, as /review-local opens it; a URL of another server (openvscode-server) is left as it is.
        const goto = page.goto.bind(page);
        page.goto = (url, options) => goto(url.startsWith('/') && !url.includes('#') ? `${url}#token=${token}` : url, options);
        // page.request calls the API as `request` does, with the token.
        Object.defineProperty(page, 'request', { value: request });
        await use(page);
    },
});
