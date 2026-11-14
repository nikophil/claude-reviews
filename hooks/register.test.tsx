// Run by `npm run test:mod` (`claude plugin test`), in the engine's own kit; `.tsx` keeps it out of `node --test`.
import { expect, mock, test } from 'claude-code/testing';

test('once the mod starts, its three tools are registered not deferred, and /review-local exists', async ($, on) => {
    const tools: { name: string; isDeferred?: boolean }[] = [];
    const commands: string[] = [];
    on('session.start', (_, e) => ({ cwd: e.cwd }));
    on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'git' ? '/work\n' : '', stderr: '' } }));
    on('env.get', () => ({ value: undefined }));
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ app: 'claude-reviews', version: '0.1.0' }) } }));
    on('fs.read', () => ({ value: JSON.stringify({ version: '0.1.0' }) }));
    on('tool.register', (_, e) => (tools.push(e), { value: { tool: `mcp__local-reviews__${e.name}` } }));
    on('command.register', (_, e) => (commands.push(e.name), { value: { command: e.name } }));
    mock.clock(on);

    await $.session.start({ cwd: '/work/src', surface: null, isInteractive: false });

    expect(tools.map(({ name, isDeferred }) => [name, isDeferred])).toEqual([
        ['list_open_threads', false], ['reply_to_thread', false], ['open_thread', false],
    ]);
    expect(commands).toEqual(['review-local']);
});
