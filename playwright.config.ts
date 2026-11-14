import { defineConfig } from '@playwright/test';

// Not 7778, so the tests run next to a real server.
const port = 7779;

export default defineConfig({
    testDir: 'e2e',
    use: { baseURL: `http://127.0.0.1:${port}` },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    webServer: {
        command: 'node server/main.ts',
        env: { CLAUDE_REVIEWS_PORT: String(port) },
        url: `http://127.0.0.1:${port}/`,
    },
});
