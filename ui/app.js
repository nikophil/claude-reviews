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

// Octicons 19.15.0, 16 px, inline: no dependency at runtime.
const OCTICONS = {
    'sidebar-collapse': 'M6.823 7.823a.25.25 0 0 1 0 .354l-2.396 2.396A.25.25 0 0 1 4 10.396V5.604a.25.25 0 0 1 .427-.177ZM1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0ZM1.5 1.75v12.5c0 .138.112.25.25.25H9.5v-13H1.75a.25.25 0 0 0-.25.25ZM11 14.5h3.25a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H11Z',
    'sidebar-expand': 'm4.177 7.823 2.396-2.396A.25.25 0 0 1 7 5.604v4.792a.25.25 0 0 1-.427.177L4.177 8.177a.25.25 0 0 1 0-.354ZM0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25H9.5v-13Zm12.5 13a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H11v13Z',
    copy: 'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
    'chevron-down': 'M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z',
    'chevron-right': 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z',
    'file-directory-fill': 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z',
    'file-directory-open-fill': 'M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z',
    file: 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z',
    'diff-added': 'M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm10.5 1.5H2.75a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4Z',
    'diff-removed': 'M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm8.5 6.25h-6.5a.75.75 0 0 1 0-1.5h6.5a.75.75 0 0 1 0 1.5Z',
    // Not an octicon: the frame of diff-removed, without its sign.
    'diff-unchanged': 'M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Z',
    gear: 'M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z',
    'diff-modified': 'M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z',
};

/** An octicon, decorative unless it has a label. */
function octicon(name, label, cls = '') {
    return html`
        <svg class=${`octicon ${cls}`} width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            role=${label ? 'img' : null} aria-label=${label} aria-hidden=${label ? null : 'true'}><path d=${OCTICONS[name]} /></svg>`;
}

const BADGES = {
    added: ['diff-added', 'Added', 'color-fg-success'],
    deleted: ['diff-removed', 'Deleted', 'color-fg-danger'],
    modified: ['diff-modified', 'Modified', 'color-fg-attention'],
    unchanged: ['diff-unchanged', 'Unchanged', 'color-fg-muted'],
};

/** The query that has the server place the threads in the displayed code. */
const placedOn = shown => `?base=${shown.base}&tree=${shown.tree}`;

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
    // Messages being written, by thread: a thread out of the displayed diff keeps its own.
    const [messages, setMessages] = useState({});
    // Threads unfolded or folded by hand, by id and status: a change of view rebuilds them, and resolving a thread folds it again.
    const [folds, setFolds] = useState({});
    const [bases, setBases] = useState([]);
    const [changed, setChanged] = useState(false);
    // Since my last review, put forward after a Refresh that a Snapshot came before.
    const [forward, setForward] = useState(false);
    const [busy, setBusy] = useState(false);
    // A preference of the browser, kept from page to page; a browser that refuses its storage opens the file tree.
    const [fileTreeOpen, setFileTreeOpen] = useState(() => {
        try {
            return localStorage.getItem('claude-reviews.file-tree') !== 'collapsed';
        } catch {
            return true;
        }
    });
    // Unified or Split, a preference of the browser too; a browser that refuses its storage shows Unified.
    const [split, setSplit] = useState(() => {
        try {
            return localStorage.getItem('claude-reviews.diff-view') === 'split';
        } catch {
            return false;
        }
    });
    const settings = useRef();
    // The toggle moves between the file tree and the toolbar: the focus follows it, after a click only.
    const toggled = useRef(false);
    useEffect(() => {
        if (toggled.current) document.querySelector('.file-tree-toggle').focus();
        toggled.current = false;
    }, [fileTreeOpen]);
    // Odd while a write is on its way: one write at a time, and a poll that crossed a write is stale.
    const writes = useRef(0);
    // What the author sees now, for a write that answers after they typed or selected on.
    const now = useRef();
    now.current = { selection, text: draft[0] };
    const shown = useRef();
    shown.current = diff;
    useEffect(() => {
        (async () => {
            const opened = worktree ? await api('/api/sessions', { worktree }) : await api(`/api/sessions/${sessionId}`);
            if (worktree) history.replaceState(null, '', `/s/${opened.id}`);
            // A closed session may outlive its worktree: without code to show, its threads show the code they were opened on.
            const loaded = await api(`/api/sessions/${opened.id}/diff`).catch(error => { if (!opened.approvedAt) throw error; });
            setSession(loaded ? await api(`/api/sessions/${opened.id}${placedOn(loaded)}`) : opened);
            setDiff(loaded ?? { ref: 'HEAD', files: [] });
        })().catch(error => setError(error.message));
    }, []);
    useEffect(() => {
        if (session) api(`/api/sessions/${session.id}/bases`).then(setBases, () => {});
    }, [session?.id, session?.sends]);
    useEffect(() => {
        if (!session || session.approvedAt) return;
        // The next poll leaves 2 s after the answer to the last one, so a slow server never has two polls on its way.
        let stopped = false;
        let timer;
        const poll = () => {
            const at = writes.current;
            const loaded = shown.current;
            Promise.allSettled([
                // Placed in the code loaded when it left: stale once another diff is loaded.
                api(`/api/sessions/${session.id}${placedOn(loaded)}`).then(fresh => {
                    if (writes.current === at && loaded === shown.current) setSession(current => JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh);
                }),
                // Both ids name content: a mismatch is a change, whenever the displayed diff was loaded.
                // Since my last review, only a Send moves the base, and a Send changes no code.
                // An answer to a poll that left before a new diff was loaded (base chosen, Refresh) is stale.
                api(`/api/sessions/${session.id}/tree`).then(now => {
                    if (loaded && loaded === shown.current) setChanged(now.tree !== loaded.tree || (now.base !== loaded.base && loaded.ref !== 'last-review'));
                }),
            ]).finally(() => { if (!stopped) timer = setTimeout(poll, 2000); });
        };
        timer = setTimeout(poll, 2000);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [session?.id, session?.approvedAt]);

    if (error) return html`<div class="flash flash-error m-3">${error}</div>`;
    if (!diff) return html`<p class="m-3 color-fg-muted">Loading…</p>`;
    /** Posts to the session, then runs `then` before the next write, and tells whether it took. */
    const act = async (path, body, then) => {
        if (writes.current % 2) return false;
        writes.current++;
        setBusy(true);
        try {
            setSession(await api(`/api/sessions/${session.id}${path}${placedOn(diff)}`, body));
            await then?.();
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
    const load = async () => {
        const fresh = await api(`/api/sessions/${session.id}/diff`);
        setSession(await api(`/api/sessions/${session.id}${placedOn(fresh)}`));
        setDiff(fresh);
        setChanged(false);
        return fresh;
    };
    const refresh = () => load().then(fresh => setForward(session.sends > 0 && fresh.ref !== 'last-review'), error => setFlash(error.message));
    const choose = ref => {
        setForward(false);
        act('/base', { base: ref }, load);
    };
    const message = id => [messages[id] ?? '', text => setMessages(all => ({ ...all, [id]: typeof text === 'function' ? text(all[id] ?? '') : text }))];
    const fold = thread => {
        const key = `${thread.id}:${thread.resolved}`;
        return [folds[key] ?? !thread.resolved, open => setFolds(all => all[key] === open ? all : { ...all, [key]: open })];
    };
    const review = { readOnly: !!session.approvedAt, busy, selection, setSelection, draft, message, fold, act, diff, now, split };
    // As GitHub's, the menu closes once a view is chosen, and on Escape; the focus goes back to its button.
    const closeSettings = () => {
        settings.current.open = false;
        settings.current.querySelector('summary').focus();
    };
    const chooseView = value => {
        try {
            localStorage.setItem('claude-reviews.diff-view', value ? 'split' : 'unified');
        } catch {}
        setSplit(value);
        closeSettings();
    };
    const pending = session.threads.some(thread => thread.messages.some(message => !message.date));
    const approve = () => {
        const open = session.threads.filter(thread => !thread.resolved).length;
        if (confirm(`Approve this session with ${open} open thread${open === 1 ? "" : "s"}?`)) act('/approve', {});
    };
    // A file out of the diff still shows its threads, while one is not Resolved.
    const changedPaths = new Set(diff.files.map(file => file.path));
    const files = [...diff.files, ...[...new Set(session.threads.filter(thread => !thread.resolved).map(thread => thread.anchor.path))].filter(path => !changedPaths.has(path))
        .map(path => ({ path, status: 'unchanged', binary: false, collapsed: false, additions: 0, deletions: 0, hunks: [] }))];
    // The answer placed on the displayed tree keeps only the files whose content did not change since they were marked.
    const isViewed = path => Object.hasOwn(session.viewed ?? {}, path);
    const viewedCount = diff.files.filter(file => isViewed(file.path)).length;
    const toggleFileTree = () => {
        try {
            localStorage.setItem('claude-reviews.file-tree', fileTreeOpen ? 'collapsed' : 'open');
        } catch {}
        toggled.current = true;
        setFileTreeOpen(!fileTreeOpen);
    };
    const toggle = html`
        <button class="btn-octicon file-tree-toggle ml-0 mr-2" aria-label=${fileTreeOpen ? 'Collapse file tree' : 'Expand file tree'} onClick=${toggleFileTree}>
            ${octicon(fileTreeOpen ? 'sidebar-collapse' : 'sidebar-expand')}
        </button>`;
    return html`
        <div class="d-flex">
            <nav aria-label="Changed files" hidden=${!fileTreeOpen} class="file-tree-pane position-sticky top-0 overflow-auto p-2 border-right">
                <div class="d-flex flex-items-center p-1 mb-2">${fileTreeOpen && toggle}<span class="text-bold">Files</span></div>
                <${FileTree} files=${files} />
            </nav>
            <main class="flex-1 min-width-0 p-3">
                <div class="d-flex flex-items-center mb-3">
                    ${!fileTreeOpen && toggle}
                    <a class="mr-3" href="/">Reviews</a>
                    <h1 class="h4 flex-1">${diff.files.length} files changed <span class="text-mono text-normal color-fg-muted f6">${session.worktree}</span></h1>
                    <details ref=${settings} class="details-reset details-overlay position-relative mr-3" onKeyDown=${event => { if (event.key === 'Escape') closeSettings(); }}>
                        <summary class="btn-octicon" role="button" aria-label="Diff view settings">${octicon('gear')}</summary>
                        <div class="dropdown-menu dropdown-menu-sw diff-settings">
                            <div class="dropdown-header">Layout</div>
                            ${[['Unified', false], ['Split', true]].map(([name, value]) => html`
                                <label class="dropdown-item"><input type="radio" name="diff-view" class="mr-2" checked=${split === value} onChange=${() => chooseView(value)} />${name}</label>`)}
                        </div>
                    </details>
                    ${diff.files.length > 0 && html`
                        <span class="d-flex flex-items-center mr-3 f6 color-fg-muted">${progress(viewedCount, diff.files.length)}${viewedCount} / ${diff.files.length} viewed</span>`}
                    <select aria-label="Base" class=${`form-select mr-2${forward ? ' color-border-accent-emphasis color-bg-accent' : ''}`} disabled=${busy || review.readOnly}
                        value=${diff.ref} onChange=${event => choose(event.target.value)}>
                        ${bases.map(base => html`
                            <option value=${base.ref} disabled=${base.disabled}
                                class=${forward && base.ref === 'last-review' ? 'text-bold' : ''}>${base.name}${forward && base.ref === 'last-review' ? ' (new changes)' : ''}</option>`)}
                    </select>
                    ${review.readOnly ? html`<span class="Label Label--done">${session.closedBecause ? 'Closed' : 'Approved'}</span>` : html`
                        <button class="btn mr-2" disabled=${busy} onClick=${() => act('/send', { tree: diff.tree })}>Send</button>
                        <button class="btn btn-primary" disabled=${busy || pending} onClick=${approve}>Approve</button>`}
                </div>
                ${flash && html`<div class="flash flash-error mb-3">${flash}</div>`}
                ${session.closedBecause && html`<div class="flash mb-3">The worktree is gone: the threads show the code they were opened on.</div>`}
                ${changed && html`<div class="flash mb-3">The code changed since it was loaded · <button class="btn-link" onClick=${refresh}>Refresh</button></div>`}
                ${files.map((file, i) => html`
                    <${FileDiff} key=${file.path} id=${`diff-${i}`} file=${file} viewed=${file.status !== 'unchanged' && isViewed(file.path)} threads=${session.threads.filter(thread => thread.anchor.path === file.path)} review=${review} />`)}
            </main>
        </div>`;
}

/** The share of files viewed, as GitHub's ring. */
function progress(done, total) {
    const length = 2 * Math.PI * 7;
    return html`
        <svg class="viewed-progress mr-2" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="7" />
            <circle cx="8" cy="8" r="7" stroke-dasharray=${length} stroke-dashoffset=${total ? length * (1 - done / total) : length} transform="rotate(-90 8 8)" />
        </svg>`;
}

function buildTree(files) {
    // Maps: a directory may be named `constructor` or `2024`, and directories keep the order of the diff; they come before files, as on GitHub.
    const root = { dirs: new Map(), files: [] };
    files.forEach((file, i) => {
        const parts = file.path.split('/');
        let node = root;
        for (const dir of parts.slice(0, -1)) {
            if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
            node = node.dirs.get(dir);
        }
        node.files.push({ name: parts.at(-1), path: file.path, id: `diff-${i}`, status: file.status });
    });
    return root;
}

/** The files of the diff as GitHub shows them: folding directories, and the file at the top of the window highlighted. */
function FileTree({ files }) {
    // Directories by full path, so a directory stays folded when a Refresh merges it with its only child or splits it.
    const [folded, setFolded] = useState(() => new Set());
    const [current, setCurrent] = useState(null);
    // A click on a file at the end of the diff cannot bring it to the top: it stays highlighted while the page cannot scroll further down.
    const clicked = useRef(null);
    // ponytail: measures every file on each scroll and render; an IntersectionObserver if hundreds of files make it slow.
    const follow = () => {
        const sections = [...document.querySelectorAll('section[data-path]')];
        const kept = sections.find(section => section.dataset.path === clicked.current)?.getBoundingClientRect();
        const end = innerHeight + scrollY >= document.documentElement.scrollHeight - 1;
        if (end && kept && kept.top < innerHeight && kept.bottom > 0) return;
        clicked.current = null;
        const top = sections.findLast(section => section.getBoundingClientRect().top <= 1) ?? sections[0];
        setCurrent(top?.dataset.path ?? null);
    };
    // After each render too: the diff loaded, reloaded or folded moves the files without a scroll.
    useEffect(follow);
    useEffect(() => {
        addEventListener('scroll', follow, { passive: true });
        return () => removeEventListener('scroll', follow);
    }, []);
    const choose = path => {
        clicked.current = path;
        setCurrent(path);
    };
    const items = (node, path, depth) => [
        ...[...node.dirs].map(([name, child]) => {
            // A directory whose only child is a directory shares its line.
            const paths = [`${path}${name}/`];
            while (child.files.length === 0 && child.dirs.size === 1) {
                const [[sub, only]] = child.dirs;
                name += `/${sub}`;
                child = only;
                paths.push(`${path}${name}/`);
            }
            const at = paths.at(-1);
            const open = !paths.some(dir => folded.has(dir));
            const fold = () => setFolded(all => {
                const next = new Set(all);
                if (open) next.add(at);
                else for (const dir of paths) next.delete(dir);
                return next;
            });
            return html`
                <li key=${at}>
                    <button class="file-tree-row" style=${`padding-left: ${8 + depth * 16}px`} aria-expanded=${open} onClick=${fold}
                        aria-current=${!open && current?.startsWith(at) ? 'true' : null}>
                        ${octicon(open ? 'chevron-down' : 'chevron-right')}
                        ${octicon(open ? 'file-directory-open-fill' : 'file-directory-fill', null, 'file-tree-directory')}
                        <span class="file-tree-name">${name}</span>
                    </button>
                    ${open && html`<ul class="list-style-none">${items(child, at, depth + 1)}</ul>`}
                </li>`;
        }),
        ...node.files.map(file => {
            const [icon, label, color] = BADGES[file.status];
            return html`
                <li key=${file.path}>
                    <a class="file-tree-row" style=${`padding-left: ${30 + depth * 16}px`} href=${`#${file.id}`}
                        aria-current=${current === file.path ? 'true' : null} onClick=${() => choose(file.path)}>
                        ${octicon('file')}
                        <span class="file-tree-name">${file.name}</span>
                        ${octicon(icon, label, color)}
                    </a>
                </li>`;
        }),
    ];
    return html`<ul class="list-style-none">${items(buildTree(files), '', 0)}</ul>`;
}

function FileDiff({ id, file, viewed, threads, review }) {
    const [open, setOpen] = useState(!file.collapsed);
    // Folded by the chevron, apart from Viewed; marking a file Viewed folds it, and unmarking it unfolds it.
    const [folded, setFolded] = useState(viewed);
    // Checked at once, without waiting for the server, and back as it was if the write fails.
    const [checked, setChecked] = useState(viewed);
    const mark = value => {
        setChecked(value);
        setFolded(value);
    };
    // The answer to my own click changes nothing; a file that lost Viewed (its content changed) unfolds.
    useEffect(() => { if (viewed !== checked) mark(viewed); }, [viewed]);
    const hunks = withContext(file.hunks, threads);
    const { readOnly, busy, act, diff } = review;
    return html`
        <section id=${id} data-path=${file.path} class="Box mb-3">
            <div class=${`Box-header file-header py-2 pl-2 d-flex flex-items-center${folded ? ' border-bottom-0 rounded-2' : ''}`}>
                <button class="btn-octicon ml-0 mr-1" aria-label=${folded ? 'Expand file' : 'Collapse file'} aria-expanded=${!folded} onClick=${() => setFolded(!folded)}>
                    ${octicon(folded ? 'chevron-right' : 'chevron-down')}
                </button>
                <span class="text-mono text-bold">${file.path}</span>
                <button class="btn-octicon ml-1 mr-auto" aria-label="Copy file path"
                    onClick=${() => Promise.resolve().then(() => navigator.clipboard.writeText(file.path)).catch(() => {})}>${octicon('copy')}</button>
                <span class="color-fg-success mr-1">+${file.additions}</span>
                <span class="color-fg-danger">−${file.deletions}</span>
                ${file.status !== 'unchanged' && html`
                    <label class="file-viewed ml-3">
                        <input type="checkbox" checked=${checked} disabled=${readOnly || busy}
                            onChange=${async event => {
                                const value = event.target.checked;
                                mark(value);
                                if (!await act('/viewed', { path: file.path, tree: diff.tree, viewed: value })) mark(!value);
                            }} />
                        Viewed
                    </label>`}
            </div>
            <div hidden=${folded}>
                ${threads.filter(thread => !thread.at).map(thread => html`<div key=${thread.id}>${threadBox(thread, review)}</div>`)}
                ${file.binary ? html`<div class="Box-body color-fg-muted">Binary file not shown</div>`
                    : hunks.length === 0 ? file.status !== 'unchanged' && html`<div class="Box-body color-fg-muted">${file.status === 'modified' ? 'File mode changed' : 'Empty file'}</div>`
                    : !open ? html`<div class="Box-body text-center"><button class="btn-link" onClick=${() => setOpen(true)}>Load diff</button></div>`
                    : html`
                        <table class=${`diff-table${review.split ? ' diff-split' : ''}`}>
                            ${review.split && html`<colgroup><col style=${numbers(hunks)} /><col /><col style=${numbers(hunks)} /><col /></colgroup>`}
                            <tbody>${rows({ ...file, hunks }, threads, review)}</tbody>
                        </table>`}
            </div>
        </section>`;
}

/** The width of the line numbers in Split, whose fixed layout cannot size them on their content: as wide as the largest. */
function numbers(hunks) {
    const largest = hunks.reduce((max, hunk) => hunk.lines.reduce((max, line) => Math.max(max, line.oldNo ?? 0, line.newNo ?? 0), max), 0);
    // The padding of the cell, and the border between the halves.
    return `width: max(50px, calc(${String(largest).length}ch + 22px))`;
}

/** The file's hunks, and the lines around threads out of them as hunks of their own, in the order of the file. */
function withContext(hunks, threads) {
    const around = new Map();
    for (const thread of threads) for (const line of thread.at?.context ?? []) around.set(line.newNo, line);
    const runs = [];
    for (const line of [...around.values()].sort((a, b) => a.newNo - b.newNo)) {
        if (runs.at(-1)?.at(-1).newNo === line.newNo - 1) runs.at(-1).push(line);
        else runs.push([line]);
    }
    const start = hunk => Number(hunk.header.match(/\+(\d+)/)[1]);
    return [...hunks, ...runs.map(run => ({ header: `@@ -${run[0].oldNo},${run.length} +${run[0].newNo},${run.length} @@`, lines: run }))]
        .sort((a, b) => start(a) - start(b));
}

function threadBox(thread, { message, fold, readOnly, busy, act }) {
    return html`<${Thread} thread=${thread} draft=${message(thread.id)} fold=${fold(thread)} readOnly=${readOnly} busy=${busy} act=${act} />`;
}

function language(path) {
    const ext = path.split('.').pop();
    return hljs.getLanguage(ext) ? ext : null;
}

/** The lines of a hunk side by side: a context line on both sides, and each deleted line of a block facing the added line in its place. */
function pairs(lines) {
    const result = [];
    let deleted = [];
    let added = [];
    // A note (no newline at end of file) about a deleted or added line takes no part in the facing: it gets a row of its own, after its line.
    const notes = new Map();
    const flush = () => {
        for (let i = 0; i < Math.max(deleted.length, added.length); i++) {
            const pair = [deleted[i] ?? null, added[i] ?? null];
            result.push(pair);
            if (pair.some(line => notes.has(line))) result.push(pair.map(line => notes.get(line) ?? null));
        }
        deleted = [];
        added = [];
    };
    lines.forEach((line, i) => {
        if (line.type === 'note' && ['del', 'add'].includes(lines[i - 1]?.type)) notes.set(lines[i - 1], line);
        else if (line.type === 'del') {
            if (added.length) flush();
            deleted.push(line);
        } else if (line.type === 'add') added.push(line);
        else {
            flush();
            result.push([line, line]);
        }
    });
    flush();
    return result;
}

// Rows carry keys, so a thread arriving above a message being typed moves its row instead of rebuilding the textarea.
function rows(file, threads, review) {
    const { readOnly, busy, selection, setSelection, draft, act, diff, now, split } = review;
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
    const code = line => ({ __html: highlight(line.text, line.type === 'note' ? null : lang) });
    // The threads that end on a line, then the box of the selection that ends there: on one side in Split, on either in Unified.
    const under = (line, side) => {
        const ends = range => range?.path === file.path && (!side || range.side === side) && (range.side === 'new' ? line.newNo : line.oldNo) === range.end;
        return line ? [
            ...threads.filter(thread => thread.at && ends({ ...thread.anchor, ...thread.at })).map(thread => html`<div key=${`t${thread.id}`}>${threadBox(thread, review)}</div>`),
            !readOnly && ends(selection) && html`
                <div key="selection" class="Box m-2 p-2">
                    <${Composer} draft=${draft} busy=${busy} onSubmit=${openThread} onCancel=${cancel} />
                </div>`,
        ].filter(Boolean) : [];
    };
    /** The number and the code of a line on one side of Split, or an empty side. */
    const half = (line, side) => {
        if (!line) return html`<td class="diff-empty" colspan="2"></td>`;
        const no = side === 'old' ? line.oldNo : line.newNo;
        const cls = `diff-line-${line.type}${selected(side, no) ? ' selected' : ''}`;
        return html`
            <td class=${`diff-num ${cls}`} onClick=${select(side, no)}>${no}</td>
            <td class=${`diff-code ${cls}`} dangerouslySetInnerHTML=${code(line)}></td>`;
    };
    return file.hunks.flatMap((hunk, h) => [
        html`<tr key=${`h${h}`} class="diff-hunk"><td colspan=${split ? 1 : 2}></td><td colspan=${split ? 3 : 1}>${hunk.header}</td></tr>`,
        ...split ? pairs(hunk.lines).flatMap(([left, right], r) => {
            const [old, added] = [under(left, 'old'), under(right, 'new')];
            return [
                html`<tr key=${`${h}-${r}`}>${half(left, 'old')}${half(right, 'new')}</tr>`,
                (old.length > 0 || added.length > 0) && html`<tr key=${`u${h}-${r}`}><td colspan="2">${old}</td><td colspan="2">${added}</td></tr>`,
            ];
        }) : hunk.lines.flatMap((line, l) => {
            const items = under(line);
            return [
                html`
                    <tr key=${`${h}-${l}`} class=${`diff-line-${line.type}${selected('old', line.oldNo) || selected('new', line.newNo) ? ' selected' : ''}`}>
                        <td class="diff-num" onClick=${select('old', line.oldNo)}>${line.oldNo}</td>
                        <td class="diff-num" onClick=${select('new', line.newNo)}>${line.newNo}</td>
                        <td class="diff-code" dangerouslySetInnerHTML=${code(line)}></td>
                    </tr>`,
                items.length > 0 && html`<tr key=${`u${h}-${l}`}><td colspan="3">${items}</td></tr>`,
            ];
        }),
    // Preact matches keyed rows only among real children: a false left here rebuilds the rows after it, and their drafts.
    ]).filter(Boolean);
}

function Thread({ thread, draft, fold: [open, setOpen], readOnly, busy, act }) {
    const [label, color] = STATUS[thread.status] ?? [];
    const { side } = thread.anchor;
    const { start, end } = thread.at ?? thread.anchor;
    const sign = side === 'new' ? '+' : '-';
    // A Resolved thread arrives folded; a fold by hand holds through polls and changes of view, until the status changes.
    return html`
        <details class="Box m-2 thread" open=${open} onToggle=${event => setOpen(event.target.open)}>
            <summary class="Box-header py-2">
                <span class="text-bold">${start === end ? `Line ${sign}${start}` : `Lines ${sign}${start} to ${sign}${end}`}</span>
                ${label && html`<span class=${`Label ${color} ml-2`}>${label}</span>`}
                ${!thread.at && html`<span class="Label Label--secondary ml-2">Outdated</span>`}
            </summary>
            ${!thread.at && html`<${Excerpt} anchor=${thread.anchor} />`}
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
                    <${Composer} draft=${draft} busy=${busy} onSubmit=${body => act(`/threads/${thread.id}/messages`, { author: 'me', body })} />
                    ${!thread.resolved && html`<button class="btn btn-sm mt-2" disabled=${busy} onClick=${() => act(`/threads/${thread.id}/resolve`, {})}>Resolve</button>`}
                </div>`}
        </details>`;
}

/** The original diff excerpt of an Outdated thread; an Anchor written out of the diff kept its lines alone. */
function Excerpt({ anchor: { path, side, start, lines, hunk } }) {
    const { header, lines: shown } = hunk ?? {
        header: null,
        lines: lines.map((text, i) => ({ type: 'context', oldNo: side === 'old' ? start + i : null, newNo: side === 'new' ? start + i : null, text })),
    };
    const lang = language(path);
    return html`
        <table class="diff-table"><tbody>
            ${header && html`<tr class="diff-hunk"><td colspan="2"></td><td>${header}</td></tr>`}
            ${shown.map(line => html`
                <tr class=${`diff-line-${line.type}`}>
                    <td class="diff-num">${line.oldNo}</td>
                    <td class="diff-num">${line.newNo}</td>
                    <td class="diff-code" dangerouslySetInnerHTML=${{ __html: highlight(line.text, line.type === 'note' ? null : lang) }}></td>
                </tr>`)}
        </tbody></table>`;
}

/** A message being written, kept across polls, and cleared once the server took it, unless typed on meanwhile. */
function Composer({ draft, busy, onSubmit, onCancel }) {
    const [text, setText] = draft;
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

/** The open sessions of all worktrees, the ones that wait for me first. */
function Reviews() {
    const [sessions, setSessions] = useState();
    const [error, setError] = useState();
    useEffect(() => { api('/api/sessions').then(setSessions, error => setError(error.message)); }, []);
    if (error) return html`<div class="flash flash-error m-3">${error}</div>`;
    if (!sessions) return html`<p class="m-3 color-fg-muted">Loading…</p>`;
    return html`
        <main class="p-3">
            <h1 class="h4 mb-3">Reviews</h1>
            ${sessions.length === 0 ? html`<p class="color-fg-muted">No open session. Open one with <code>/review-local</code>, or <code>?worktree=/path/to/worktree</code>.</p>` : html`
                <div class="Box">
                    ${sessions.map(session => html`
                        <a key=${session.id} href=${`/s/${session.id}`} class="Box-row d-flex flex-items-center Link--primary no-underline">
                            <span class="text-bold mr-2">${session.repo}</span>
                            <span class="text-mono mr-2">${session.branch}</span>
                            <span class="flex-1 text-mono f6 color-fg-muted">${session.worktree}</span>
                            <span class="Label Label--accent mr-2">${session.awaitingYou} Awaiting you</span>
                            <span class="Label Label--attention">${session.waitingForClaude} Waiting for Claude</span>
                        </a>`)}
                </div>`}
        </main>`;
}

render(worktree || sessionId ? html`<${App} />` : html`<${Reviews} />`, document.getElementById('app'));
