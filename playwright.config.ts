import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Not 7778, so the tests run next to a real server.
const port = 7779;
// Workers load this file again, with the environment of the main process: one data directory per run, never the real one.
// ponytail: the directory stays in the temporary directory after the run; remove it in a globalTeardown if they pile up.
process.env.CLAUDE_REVIEWS_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'claude-reviews-e2e-'));

export default defineConfig({
    testDir: 'e2e',
    use: { baseURL: `http://127.0.0.1:${port}` },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    webServer: {
        command: 'node server/main.ts',
        env: { CLAUDE_REVIEWS_PORT: String(port), XDG_DATA_HOME: process.env.CLAUDE_REVIEWS_E2E_DATA },
        url: `http://127.0.0.1:${port}/`,
    },
});
