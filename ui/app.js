import { html, render, useEffect, useRef, useState } from '/vendor/preact-htm.js';
import hljs from '/vendor/highlight.js';
import { marked, Renderer } from '/vendor/marked.js';

const worktree = new URLSearchParams(location.search).get('worktree');
const sessionId = location.pathname.match(/^\/s\/([0-9a-f]{16})$/)?.[1];

const STATUS = {
    'waiting-for-claude': ['Waiting for Claude', 'Label--attention'],
    'awaiting-you': ['Awaiting you', 'Label--accent'],
    resolved: ['Resolved', 'Label--done'],
};

// Raw HTML shows as text, and only http, https and mailto links are clickable: a message can quote any HTML.
// A link opens in a new tab, so following it does not lose a message being written.
marked.use({
    renderer: {
        html: ({ text }) => escape(text),
        link(token) {
            return /^(https?|mailto):/i.test(token.href)
                ? Renderer.prototype.link.call(this, token).replace('<a ', '<a target="_blank" rel="noopener noreferrer" ')
                : this.parser.parseInline(token.tokens);
        },
        // An image would load from anywhere: its alt text stands for it.
        image: ({ text }) => escape(text),
    },
});

function escape(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function api(path, body) {
    const res = await fetch(path, body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    return json;
}

function App() {
    const [session, setSession] = useState();
    const [diff, setDiff] = useState();
    const [error, setError] = useState();
    const [flash, setFlash] = useState();
    const [selection, setSelection] = useState(null);
    // The first message of a new thread lives here, so it follows the selection from line to line and file to file.
    const draft = useState('');
    const [busy, setBusy] = useState(false);
    // Odd while a write is on its way: one write at a time, and a poll that crossed a write is stale.
    const writes = useRef(0);
    // What the author sees now, for a write that answers after they typed or selected on.
    const now = useRef();
    now.current = { selection, text: draft[0] };
    useEffect(() => {
        (async () => {
            const opened = worktree ? await api('/api/sessions', { worktree }) : await api(`/api/sessions/${sessionId}`);
            if (worktree) history.replaceState(null, '', `/s/${opened.id}`);
            setSession(opened);
            setDiff(await api(`/api/sessions/${opened.id}/diff`));
        })().catch(error => setError(error.message));
    }, []);
    useEffect(() => {
        if (!session || session.approvedAt) return;
        // The next poll leaves 2 s after the answer to the last one, so a slow server never has two polls on its way.
        let stopped = false;
        let timer;
        const poll = () => {
            const at = writes.current;
            api(`/api/sessions/${session.id}`).then(fresh => {
                if (writes.current === at) setSession(current => JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh);
            }, () => {}).finally(() => { if (!stopped) timer = setTimeout(poll, 2000); });
        };
        timer = setTimeout(poll, 2000);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [session?.id, session?.approvedAt]);

    if (error) return html`<div class="flash flash-error m-3">${error}</div>`;
    if (!diff) return html`<p class="m-3 color-fg-muted">Loading…</p>`;
    /** Posts to the session, and tells whether it took. */
    const act = async (path, body) => {
        if (writes.current % 2) return false;
        writes.current++;
        setBusy(true);
        try {
            setSession(await api(`/api/sessions/${session.id}${path}`, body));
            setFlash(null);
            return true;
        } catch (error) {
            setFlash(error.message);
            return false;
        } finally {
            writes.current++;
            setBusy(false);
        }
    };
    const review = { readOnly: !!session.approvedAt, busy, selection, setSelection, draft, act, diff, now };
    const pending = session.threads.some(thread => thread.messages.some(message => !message.date));
    const approve = () => {
        const open = session.threads.filter(thread => !thread.resolved).length;
        if (confirm(`Approve this session with ${open} open thread${open === 1 ? "" : "s"}?`)) act('/approve', {});
    };
    return html`
        <div class="d-flex">
            <nav aria-label="Changed files" class="file-tree-pane position-sticky top-0 overflow-auto p-3 border-right">
                <${Tree} node=${buildTree(diff.files)} />
            </nav>
            <main class="flex-1 min-width-0 p-3">
                <div class="d-flex flex-items-center mb-3">
                    <h1 class="h4 flex-1">${diff.files.length} files changed <span class="text-mono text-normal color-fg-muted f6">${session.worktree}</span></h1>
                    ${review.readOnly ? html`<span class="Label Label--done">Approved</span>` : html`
                        <button class="btn mr-2" disabled=${busy} onClick=${() => act('/send', { tree: diff.tree })}>Send</button>
                        <button class="btn btn-primary" disabled=${busy || pending} onClick=${approve}>Approve</button>`}
                </div>
                ${flash && html`<div class="flash flash-error mb-3">${flash}</div>`}
                ${diff.files.map((file, i) => html`
                    <${FileDiff} key=${i} id=${`diff-${i}`} file=${file} threads=${session.threads.filter(thread => thread.anchor.path === file.path)} review=${review} />`)}
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

function FileDiff({ id, file, threads, review }) {
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
                : html`<table class="diff-table"><tbody>${rows(file, threads, review)}</tbody></table>`}
        </section>`;
}

function language(path) {
    const ext = path.split('.').pop();
    return hljs.getLanguage(ext) ? ext : null;
}

/** Whether the range of lines (a thread's Anchor or the selection) ends on this line of the file. */
function endsAt(range, file, line) {
    return range?.path === file.path && (range.side === 'new' ? line.newNo : line.oldNo) === range.end;
}

// Rows carry keys, so a thread arriving above a reply being typed moves its row instead of rebuilding the textarea.
function rows(file, threads, { readOnly, busy, selection, setSelection, draft, act, diff, now }) {
    const lang = language(file.path);
    const selected = (side, no) => selection?.path === file.path && selection.side === side && no >= selection.start && no <= selection.end;
    // A click selects a line, a Shift+click extends the selection from the line clicked first, on the same side of the same file.
    const select = (side, no) => event => {
        if (readOnly || no === null) return;
        const from = event.shiftKey && selection?.path === file.path && selection.side === side ? selection.from : no;
        setSelection({ path: file.path, side, from, start: Math.min(from, no), end: Math.max(from, no) });
    };
    // Text typed or a selection made while the thread opens stays, with the selection and its draft.
    const openThread = async body => {
        const sent = selection;
        const { path, side, start, end } = sent;
        const done = await act('/threads', { author: 'me', path, side, start, end, body, base: diff.base, tree: diff.tree })
            && now.current.selection === sent && now.current.text === body;
        if (done) setSelection(null);
        return done;
    };
    const cancel = () => {
        setSelection(null);
        draft[1]('');
    };
    return file.hunks.flatMap((hunk, h) => [
        html`<tr key=${`h${h}`} class="diff-hunk"><td colspan="2"></td><td>${hunk.header}</td></tr>`,
        ...hunk.lines.flatMap((line, l) => [
            html`
                <tr key=${`${h}-${l}`} class=${`diff-line-${line.type}${selected('old', line.oldNo) || selected('new', line.newNo) ? ' selected' : ''}`}>
                    <td class="diff-num" onClick=${select('old', line.oldNo)}>${line.oldNo}</td>
                    <td class="diff-num" onClick=${select('new', line.newNo)}>${line.newNo}</td>
                    <td class="diff-code" dangerouslySetInnerHTML=${{ __html: highlight(line.text, line.type === 'note' ? null : lang) }}></td>
                </tr>`,
            // ponytail: a thread whose last line is not in the displayed diff is not shown; slice 5 shows it with its excerpt.
            ...threads.filter(thread => endsAt(thread.anchor, file, line)).map(thread => html`
                <tr key=${`t${thread.id}`}><td colspan="3"><${Thread} thread=${thread} readOnly=${readOnly} busy=${busy} act=${act} /></td></tr>`),
            !readOnly && endsAt(selection, file, line) && html`
                <tr key="selection"><td colspan="3"><div class="Box m-2 p-2">
                    <${Composer} draft=${draft} busy=${busy} onSubmit=${openThread} onCancel=${cancel} />
                </div></td></tr>`,
        // Preact matches keyed rows only among real children: a false left here rebuilds the rows after it, and their drafts.
        ].filter(Boolean)),
    ]);
}

function Thread({ thread, readOnly, busy, act }) {
    const [label, color] = STATUS[thread.status] ?? [];
    const { side, start, end } = thread.anchor;
    const sign = side === 'new' ? '+' : '-';
    // A Resolved thread arrives folded; once open, a poll does not fold it again, since `open` only changes with the status.
    return html`
        <details class="Box m-2 thread" open=${!thread.resolved}>
            <summary class="Box-header py-2">
                <span class="text-bold">${start === end ? `Line ${sign}${start}` : `Lines ${sign}${start} to ${sign}${end}`}</span>
                ${label && html`<span class=${`Label ${color} ml-2`}>${label}</span>`}
            </summary>
            ${thread.messages.map(message => html`
                <div class="Box-row">
                    <div class="mb-1">
                        <span class="text-bold mr-2">${message.author === 'me' ? 'You' : 'Claude'}</span>
                        ${message.date ? html`<span class="color-fg-muted f6">${new Date(message.date).toLocaleString()}</span>`
                            : html`<span class="Label Label--attention">Pending</span>`}
                    </div>
                    <div class="markdown-body" dangerouslySetInnerHTML=${{ __html: marked.parse(message.body) }}></div>
                </div>`)}
            ${!readOnly && html`
                <div class="Box-footer">
                    <${Composer} busy=${busy} onSubmit=${body => act(`/threads/${thread.id}/messages`, { author: 'me', body })} />
                    ${!thread.resolved && html`<button class="btn btn-sm mt-2" disabled=${busy} onClick=${() => act(`/threads/${thread.id}/resolve`, {})}>Resolve</button>`}
                </div>`}
        </details>`;
}

/** A message being written, kept across polls, and cleared once the server took it, unless typed on meanwhile. */
function Composer({ draft, busy, onSubmit, onCancel }) {
    const own = useState('');
    const [text, setText] = draft ?? own;
    const submit = async event => {
        event.preventDefault();
        const sent = text;
        if (await onSubmit(sent)) setText(current => current === sent ? '' : current);
    };
    return html`
        <form onSubmit=${submit}>
            <textarea class="form-control width-full mb-2" aria-label="Message" placeholder="Leave a message (markdown)" value=${text} onInput=${event => setText(event.target.value)}></textarea>
            <button class="btn btn-sm btn-primary" type="submit" disabled=${busy || !text.trim()}>Add message</button>
            ${onCancel && html`<button class="btn btn-sm ml-2" type="button" onClick=${onCancel}>Cancel</button>`}
        </form>`;
}

// ponytail: line by line, a token spanning lines (block comment, template string) is miscolored; highlight whole files if it bothers.
function highlight(text, language) {
    return language ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escape(text);
}

render(worktree || sessionId ? html`<${App} />` : html`<p class="m-3">Pass the worktree to review: <code>?worktree=/path/to/worktree</code></p>`, document.getElementById('app'));
