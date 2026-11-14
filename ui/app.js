import { html, render, useEffect, useState } from '/vendor/preact-htm.js';
import hljs from '/vendor/highlight.js';

const worktree = new URLSearchParams(location.search).get('worktree');

function App() {
    const [state, setState] = useState({});
    useEffect(() => {
        fetch(`/api/diff?worktree=${encodeURIComponent(worktree)}`)
            .then(async res => setState(res.ok ? { files: (await res.json()).files } : { error: (await res.json()).error }))
            .catch(error => setState({ error: String(error) }));
    }, []);

    if (state.error) return html`<div class="flash flash-error m-3">${state.error}</div>`;
    if (!state.files) return html`<p class="m-3 color-fg-muted">Loading…</p>`;
    return html`
        <div class="d-flex">
            <nav aria-label="Changed files" class="file-tree-pane position-sticky top-0 overflow-auto p-3 border-right">
                <${Tree} node=${buildTree(state.files)} />
            </nav>
            <main class="flex-1 min-width-0 p-3">
                <h1 class="h4 mb-3">${state.files.length} files changed <span class="text-mono text-normal color-fg-muted f6">${worktree}</span></h1>
                ${state.files.map((file, i) => html`<${FileDiff} key=${i} id=${`diff-${i}`} file=${file} />`)}
            </main>
        </div>`;
}

function buildTree(files) {
    const root = { dirs: {}, files: [] };
    files.forEach((file, i) => {
        const parts = file.path.split('/');
        let node = root;
        for (const dir of parts.slice(0, -1)) node = node.dirs[dir] ??= { dirs: {}, files: [] };
        node.files.push({ name: parts.at(-1), id: `diff-${i}` });
    });
    return root;
}

function Tree({ node }) {
    return html`
        <ul class="file-tree">
            ${Object.entries(node.dirs).map(([name, child]) => html`
                <li><span class="color-fg-muted">${name}/</span><${Tree} node=${child} /></li>`)}
            ${node.files.map(file => html`<li><a href=${`#${file.id}`}>${file.name}</a></li>`)}
        </ul>`;
}

function FileDiff({ id, file }) {
    const [open, setOpen] = useState(!file.collapsed);
    return html`
        <section id=${id} class="Box mb-3">
            <div class="Box-header py-2 d-flex flex-items-center">
                <span class="text-mono text-bold flex-1">${file.path}</span>
                <span class="color-fg-success mr-1">+${file.additions}</span>
                <span class="color-fg-danger">−${file.deletions}</span>
            </div>
            ${file.binary ? html`<div class="Box-body color-fg-muted">Binary file not shown</div>`
                : file.hunks.length === 0 ? html`<div class="Box-body color-fg-muted">${file.status === 'modified' ? 'File mode changed' : 'Empty file'}</div>`
                : !open ? html`<div class="Box-body text-center"><button class="btn-link" onClick=${() => setOpen(true)}>Load diff</button></div>`
                : html`<table class="diff-table"><tbody>${file.hunks.map(hunk => Hunk(hunk, language(file.path)))}</tbody></table>`}
        </section>`;
}

function language(path) {
    const ext = path.split('.').pop();
    return hljs.getLanguage(ext) ? ext : null;
}

function Hunk(hunk, language) {
    return [
        html`<tr class="diff-hunk"><td colspan="2"></td><td>${hunk.header}</td></tr>`,
        ...hunk.lines.map(line => html`
            <tr class=${`diff-line-${line.type}`}>
                <td class="diff-num">${line.oldNo}</td>
                <td class="diff-num">${line.newNo}</td>
                <td class="diff-code" dangerouslySetInnerHTML=${{ __html: highlight(line.text, line.type === 'note' ? null : language) }}></td>
            </tr>`),
    ];
}

// ponytail: line by line, a token spanning lines (block comment, template string) is miscolored; highlight whole files if it bothers.
function highlight(text, language) {
    if (language) return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

render(worktree ? html`<${App} />` : html`<p class="m-3">Pass the worktree to review: <code>?worktree=/path/to/worktree</code></p>`, document.getElementById('app'));
