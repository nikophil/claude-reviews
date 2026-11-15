import { defineConfig } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The extension in openvscode-server, VS Code in a browser, against a server of its own: not 7778, nor the 7779 of playwright.config.ts, nor the 7780 of the PhpStorm UI tests.
const port = 7781;
const vscode = 3011;
const server = process.env.OPENVSCODE_SERVER ?? join(homedir(), '.cache/claude-reviews/openvscode-server-v1.109.5-linux-x64/bin/openvscode-server');
// ponytail: the directory stays in the temporary directory after the run, as in playwright.config.ts.
process.env.CLAUDE_REVIEWS_VSCODE_DATA ??= mkdtempSync(join(tmpdir(), 'claude-reviews-vscode-'));
const data = process.env.CLAUDE_REVIEWS_VSCODE_DATA;
const bin = join(data, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
// Nor the developer's name, which /api/me reads from the global git config, and which the README's image would show.
const gitconfig = join(data, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = Ada Lovelace\n');
const dirs = `--extensions-dir ${join(data, 'extensions')} --server-data-dir ${join(data, 'server')} --user-data-dir ${join(data, 'user')}`;

export default defineConfig({
    testDir: 'e2e',
    testMatch: 'vscode.spec.ts',
    // One openvscode-server, whose window each test opens on a worktree of its own.
    workers: 1,
    timeout: 60_000,
    use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1400, height: 900 }, screenshot: 'only-on-failure' },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    webServer: [
        {
            command: 'node server/main.ts',
            env: { CLAUDE_REVIEWS_PORT: String(port), XDG_DATA_HOME: data, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: gitconfig },
            url: `http://127.0.0.1:${port}/`,
        },
        {
            command: `sh vscode/build.sh && ${server} ${dirs} --install-extension var/vscode/local-reviews.vsix --force && ${server} --host 127.0.0.1 --port ${vscode} --without-connection-token ${dirs}`,
            env: { CLAUDE_REVIEWS_PORT: String(port) },
            url: `http://127.0.0.1:${vscode}/`,
            timeout: 120_000,
        },
    ],
});
