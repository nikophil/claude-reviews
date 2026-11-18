import { html, render, useEffect, useRef, useState } from '/vendor/preact-htm.js';
import hljs from '/vendor/highlight.js';
import { marked, Renderer } from '/vendor/marked.js';

const worktree = new URLSearchParams(location.search).get('worktree');
const sessionId = location.pathname.match(/^\/s\/([0-9a-f]{16})$/)?.[1];

// The token authenticates every API call. The mod opens the page with #token=, a fragment no request carries, not even a Referer;
// the page keeps it for the other tabs of this origin, where only its own scripts run, and drops it from the address bar.
const token = (() => {
    const hash = () => new URLSearchParams(location.hash.replace(/^#/, ''));
    try {
        const fromUrl = hash().get('token');
        if (!fromUrl) return localStorage.getItem('claude-reviews.token') ?? '';
        localStorage.setItem('claude-reviews.token', fromUrl);
        const rest = hash();
        rest.delete('token');
        history.replaceState(null, '', location.pathname + location.search + (rest.toString() ? `#${rest}` : ''));
        return fromUrl;
    } catch {
        // Without storage, the fragment stays in the address bar, and keeps the token for a reload.
        return hash().get('token') ?? '';
    }
})();

const STATUS = {
    'waiting-for-claude': ['Waiting for Claude', 'Label--attention'],
    resolved: ['Resolved', 'Label--done'],
};

// Raw HTML shows as text, and only http, https and mailto links are clickable: a message can quote any HTML.
// A link opens in a new tab, so following it does not lose a message being written.
// A line break shows as one, as in a comment on GitHub.
marked.use({
    breaks: true,
    renderer: {
        html: ({ text }) => escape(text),
        link(token) {
            return /^(https?|mailto):/i.test(token.href)
                ? Renderer.prototype.link.call(this, token).replace('<a ', '<a target="_blank" rel="noopener noreferrer" ')
                : this.parser.parseInline(token.tokens);
        },
        // An image would load from anywhere: its alt text stands for it.
        image: ({ text }) => escape(text),
        code: token => token.lang === 'suggestion' && suggestion(replaced, token.text),
    },
});

// The lines a suggestion replaces: those of the thread whose message marked is parsing, which it does at once.
let replaced = [];

/** The markdown of a message of a thread whose lines are `lines`. */
function markdown(body, lines = []) {
    replaced = lines;
    try {
        return marked.parse(body);
    } finally {
        replaced = [];
    }
}

/** A suggestion block, as GitHub shows it: the lines of the thread it replaces, then its own. */
function suggestion(old, text) {
    const rows = (lines, type) => lines.map(line => `<tr><td class="diff-code diff-line-${type}">${escape(line)}</td></tr>`).join('');
    return `<div class="suggestion Box my-2"><div class="Box-header py-1 px-2 f6 text-bold">Suggested change</div>`
        + `<table class="diff-table">${rows(old, 'del')}${rows(text === '' ? [] : text.split('\n'), 'add')}</table></div>`;
}

/** The threads as markdown, for a pull request: their published messages, in the order of the session. */
function threadsMarkdown(threads) {
    return threads.filter(thread => thread.messages.some(message => message.date)).map(thread => {
        const status = { resolved: ' · Resolved', 'waiting-for-claude': ' · Waiting for Claude' }[thread.status] ?? '';
        const messages = thread.messages.filter(message => message.date).map(message => `**${message.author === 'me' ? 'You' : 'Claude'}**: ${message.body}`);
        return `${[`### \`${thread.anchor.path}\` ${where(thread)}${status}`, ...messages].join('\n\n')}\n`;
    }).join('\n');
}

/** Where a thread is: file, line +2, or lines -2 to -4. */
function where(thread) {
    const { side, end: whole } = thread.anchor;
    const { start, end } = thread.at ?? thread.anchor;
    const sign = side === 'new' ? '+' : '-';
    return whole === 0 ? 'file' : start === end ? `line ${sign}${start}` : `lines ${sign}${start} to ${sign}${end}`;
}

/** A path as a shell reads it, quoted when it holds anything else than letters, digits and `_./-`. */
const shell = path => /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;

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
    'chevron-up': 'M3.22 10.53a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0l4.25 4.25a.749.749 0 1 1-1.06 1.06L8 6.811 4.28 10.53a.749.749 0 0 1-1.06 0Z',
    'chevron-right': 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z',
    'file-directory-fill': 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z',
    'file-directory-open-fill': 'M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z',
    file: 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z',
    'diff-added': 'M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm10.5 1.5H2.75a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4Z',
    'diff-removed': 'M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm8.5 6.25h-6.5a.75.75 0 0 1 0-1.5h6.5a.75.75 0 0 1 0 1.5Z',
    // Not an octicon: the frame of diff-removed, without its sign.
    'diff-unchanged': 'M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Z',
    comment: 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
    gear: 'M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z',
    'fold-down': 'm8.177 14.323 2.896-2.896a.25.25 0 0 0-.177-.427H8.75V7.764a.75.75 0 1 0-1.5 0V11H5.104a.25.25 0 0 0-.177.427l2.896 2.896a.25.25 0 0 0 .354 0ZM2.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75ZM8.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z',
    'fold-up': 'M7.823 1.677 4.927 4.573A.25.25 0 0 0 5.104 5H7.25v3.236a.75.75 0 1 0 1.5 0V5h2.146a.25.25 0 0 0 .177-.427L8.177 1.677a.25.25 0 0 0-.354 0ZM13.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Zm-3.75.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75ZM7.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5ZM4 11.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75ZM1.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Z',
    unfold: 'm8.177.677 2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM7.25 10.75a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12H7.25v-1.25Zm-5-2a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z',
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

/** The query that has the server place the threads in the displayed code, whitespace hidden as in the displayed diff. */
/** The bases in runs of the same group, in their order: `[group, bases]`, the group undefined for the quick choices. */
function grouped(bases) {
    const runs = [];
    for (const base of bases) {
        if (runs.length === 0 || runs.at(-1)[0] !== base.group) runs.push([base.group, []]);
        runs.at(-1)[1].push(base);
    }
    return runs;
}

const placedOn = shown => `?base=${shown.base}&tree=${shown.tree}${shown.hideWhitespace ? '&w=1' : ''}`;

/** A preference of the browser, kept from page to page; `fallback` when the browser refuses its storage, or has none. */
function preference(name, fallback) {
    try {
        return localStorage.getItem(`claude-reviews.${name}`) ?? fallback;
    } catch {
        return fallback;
    }
}

function setPreference(name, value) {
    try {
        localStorage.setItem(`claude-reviews.${name}`, value);
    } catch {}
}

async function api(path, body) {
    const auth = { authorization: `Bearer ${token}` };
    const res = await fetch(path, body ? { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: auth });
    // The server restarted with another token, or the page came without one.
    if (res.status === 401) throw new Error('The server refuses the token of this page: open the review again with /review-local.');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    return json;
}

// Claude's star, drawn here: rays of alternating length around a center, in its orange, square as a GitHub app's avatar.
const CLAUDE_AVATAR = html`
    <svg class="avatar mr-2 flex-shrink-0" width="40" height="40" viewBox="-12 -12 24 24" role="img" aria-label="Claude">
        <path stroke="#D97757" stroke-width="2.6" stroke-linecap="round" fill="none" d=${Array.from({ length: 12 }, (_, i) => {
            const angle = (i * 30 + 15) * Math.PI / 180;
            const length = i % 2 ? 6.5 : 9.5;
            return `M0 0L${(Math.cos(angle) * length).toFixed(2)} ${(Math.sin(angle) * length).toFixed(2)}`;
        }).join('')} />
    </svg>`;

/**
 * My avatar, as in a GitHub timeline: my GitHub avatar, or my initials without login, or once the image failed on the page.
 * `me` is `{ login, name, broken }`, undefined until `/api/me` answers.
 */
function myAvatar(me) {
    if (me?.login) {
        return html`<img class="avatar circle mr-2 flex-shrink-0" width="40" height="40" alt=${`@${me.login}`}
            src=${`https://github.com/${encodeURIComponent(me.login)}.png?size=80`} onError=${me.broken} />`;
    }
    const words = me?.name?.match(/\S+/g) ?? [];
    // Spread, so an initial outside the BMP (an emoji) stays whole.
    const initials = words.length ? ([...words[0]][0] + (words.length > 1 ? [...words.at(-1)][0] : '')).toUpperCase() : '';
    return html`<span class="avatar circle avatar-initials mr-2 flex-shrink-0" aria-hidden="true">${me && (initials || '?')}</span>`;
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
    // The thread j and k last went to, and the file to unfold for it.
    const [current, setCurrent] = useState(null);
    const [reveal, setReveal] = useState(null);
    const navigate = useRef();
    const [copied, setCopied] = useState(false);
    // Who I am: read again at each poll until it gives my login, which gh may give later; a failed image holds for the page.
    const [me, setMe] = useState();
    const [avatarBroken, setAvatarBroken] = useState(false);
    const login = useRef();
    login.current = me?.login;
    const readMe = () => {
        if (!login.current) api('/api/me').then(fresh => setMe(current => JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh), () => {});
    };
    useEffect(readMe, []);
    const [fileTreeOpen, setFileTreeOpen] = useState(() => preference('file-tree', 'open') !== 'collapsed');
    // Unified or Split.
    const [split, setSplit] = useState(() => preference('diff-view', 'unified') === 'split');
    // Each diff asked for gets a number: the answer to an older one is stale.
    const asked = useRef(0);
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
            // The fragment, still there when the browser storage failed, keeps its token.
            if (worktree) history.replaceState(null, '', `/s/${opened.id}${location.hash}`);
            // A closed session may outlive its worktree: without code to show, its threads show the code they were opened on.
            // Hide whitespace lives in the displayed diff; the preference only chooses the first one.
            const hideWhitespace = preference('hide-whitespace', 'false') === 'true';
            // A new worktree may stand at the path of a session closed because its worktree was gone: its code is not the session's.
            const loaded = opened.closedBecause ? undefined : await api(`/api/sessions/${opened.id}/diff${hideWhitespace ? '?w=1' : ''}`).then(loaded => ({ ...loaded, hideWhitespace }))
                .catch(error => { if (!opened.approvedAt) throw error; });
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
            readMe();
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
                // A write on its way may be a change of base, whose diff is not loaded yet.
                api(`/api/sessions/${session.id}/tree`).then(now => {
                    if (loaded && loaded === shown.current && writes.current === at && at % 2 === 0) setChanged(now.tree !== loaded.tree || (now.base !== loaded.base && loaded.ref !== 'last-review'));
                }),
            ]).finally(() => { if (!stopped) timer = setTimeout(poll, 2000); });
        };
        timer = setTimeout(poll, 2000);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [session?.id, session?.approvedAt]);
    // Text typed and not added yet: leaving the page, or an Approve, loses it.
    const typed = !!draft[0].trim() || Object.values(messages).some(text => text.trim());
    useEffect(() => {
        if (!typed) return;
        const warn = event => event.preventDefault();
        addEventListener('beforeunload', warn);
        return () => removeEventListener('beforeunload', warn);
    }, [typed]);
    // j and k, as on GitHub, out of the fields where they type.
    useEffect(() => {
        const keys = event => {
            if (event.ctrlKey || event.metaKey || event.altKey || (event.key !== 'j' && event.key !== 'k')) return;
            if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
            navigate.current?.(event.key === 'j' ? 1 : -1);
        };
        addEventListener('keydown', keys);
        return () => removeEventListener('keydown', keys);
    }, []);
    // Once the file of the thread unfolded, at its next render.
    useEffect(() => {
        if (!reveal) return;
        const timer = setTimeout(() => document.getElementById(`thread-${reveal.id}`)?.scrollIntoView({ block: 'center' }));
        return () => clearTimeout(timer);
    }, [reveal]);

    if (error) return html`<div class="flash flash-error m-3">${error}</div>`;
    if (!diff) return html`<p class="m-3 color-fg-muted">Loading…</p>`;
    /** Posts to the session, then runs `then` before the next write, and tells whether it took. */
    const act = async (path, body, then) => {
        if (writes.current % 2) return false;
        writes.current++;
        setBusy(true);
        try {
            const answer = await api(`/api/sessions/${session.id}${path}${placedOn(diff)}`, body);
            // Placed on a diff no longer displayed: the next poll places the write on the displayed one.
            if (diff === shown.current) setSession(answer);
            await then?.(answer);
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
    /**
     * Shows the diff of the working tree, or of the `displayed` base and tree again, with the threads placed on it;
     * null, and nothing shown, once another diff was asked for since.
     */
    const load = async (hideWhitespace = diff.hideWhitespace, displayed) => {
        const n = ++asked.current;
        const query = displayed ? placedOn({ ...displayed, hideWhitespace }) : hideWhitespace ? '?w=1' : '';
        const fresh = { ...displayed, ...await api(`/api/sessions/${session.id}/diff${query}`), hideWhitespace };
        const placed = await api(`/api/sessions/${session.id}${placedOn(fresh)}`);
        if (n !== asked.current) return null;
        setSession(placed);
        setDiff(fresh);
        // A selection names lines by their numbers: it stays while they hold the same text in the new diff, as my draft does.
        setSelection(current => current && (current.end === 0 || [...Array(current.end - current.start + 1)].every((_, i) => {
            const text = lineText(diff, current, current.start + i);
            return text !== undefined && text === lineText(fresh, current, current.start + i);
        })) ? current : null);
        if (!displayed) setChanged(false);
        return fresh;
    };
    const refresh = () => load().then(fresh => fresh && setForward(session.sends > 0 && fresh.ref !== 'last-review'), error => setFlash(error.message));
    const choose = ref => {
        setForward(false);
        act('/base', { base: ref }, () => load());
    };
    const message = id => [messages[id] ?? '', text => setMessages(all => ({ ...all, [id]: typeof text === 'function' ? text(all[id] ?? '') : text }))];
    const fold = thread => {
        const key = `${thread.id}:${thread.resolved}`;
        return [folds[key] ?? !thread.resolved, open => setFolds(all => all[key] === open ? all : { ...all, [key]: open })];
    };
    /** Lines `from` to `to` of a file in the displayed tree; null once another diff is displayed. */
    const lines = async (path, from, to) => {
        try {
            const { lines } = await api(`/api/sessions/${session.id}/lines?path=${encodeURIComponent(path)}&tree=${diff.tree}&from=${from}&to=${to}`);
            if (diff !== shown.current) return null;
            setFlash(null);
            return lines;
        } catch (error) {
            setFlash(error.message);
            return null;
        }
    };
    const avatar = me && { ...me, login: avatarBroken ? null : me.login, broken: () => setAvatarBroken(true) };
    // Send of the thread `n` alone, from within the write that added my message to it.
    const sendThread = async n => {
        const answer = await api(`/api/sessions/${session.id}/send${placedOn(diff)}`, { tree: diff.tree, threads: [n] });
        if (diff === shown.current) setSession(answer);
    };
    const review = { readOnly: !!session.approvedAt, busy, selection, setSelection, draft, message, fold, act, sendThread, diff, now, split, lines, avatar, current, reveal };
    // As GitHub's, the menu closes once a view is chosen, and on Escape; the focus goes back to its button.
    const closeSettings = () => {
        settings.current.open = false;
        settings.current.querySelector('summary').focus();
    };
    const chooseView = value => {
        setPreference('diff-view', value ? 'split' : 'unified');
        setSplit(value);
        closeSettings();
    };
    // The diff of the displayed code reloads, and the banner of a code change stays; the box and the preference follow once it shows.
    const chooseWhitespace = value => {
        closeSettings();
        load(value, diff).then(fresh => { if (fresh) setPreference('hide-whitespace', String(value)); }, error => setFlash(error.message));
    };
    // A Pending message of a Resolved thread waits for its Unresolve, which an Approve gives up.
    const pending = session.threads.some(thread => !thread.resolved && thread.messages.some(message => !message.date));
    const approve = () => {
        const open = session.threads.filter(thread => !thread.resolved).length;
        const lost = typed ? ' The text typed and not added will be lost.' : '';
        if (confirm(`Approve this session with ${open} open thread${open === 1 ? "" : "s"}?${lost}`)) act('/approve', {});
    };
    // A file out of the diff still shows its threads, while one is not Resolved; without any code shown, all of them.
    const changedPaths = new Set(diff.files.map(file => file.path));
    const files = [...diff.files, ...[...new Set(session.threads.filter(thread => !thread.resolved || !diff.tree).map(thread => thread.anchor.path))].filter(path => !changedPaths.has(path))
        .map(path => ({ path, status: 'unchanged', binary: false, collapsed: false, additions: 0, deletions: 0, hunks: [] }))];
    // The answer placed on the displayed tree keeps only the files whose content did not change since they were marked.
    const isViewed = path => Object.hasOwn(session.viewed ?? {}, path);
    const viewedCount = diff.files.filter(file => isViewed(file.path)).length;
    // The threads not Resolved, file by file in the order of the page, then by line: what j and k go through.
    const conversations = files.flatMap(file => session.threads.filter(thread => thread.anchor.path === file.path && !thread.resolved)
        .sort((a, b) => (a.at ?? a.anchor).start - (b.at ?? b.anchor).start));
    // Before any Send, Claude replied to nothing.
    const replied = thread => !!session.sentAt && thread.messages.some(message => message.author === 'claude' && message.date && message.date >= session.sentAt);
    const go = thread => {
        setCurrent(thread.id);
        setReveal({ path: thread.anchor.path, id: thread.id, at: Date.now() });
        history.replaceState(null, '', `#thread-${thread.id}`);
    };
    navigate.current = step => {
        const i = conversations.findIndex(thread => thread.id === current);
        const next = conversations[i === -1 ? (step > 0 ? 0 : conversations.length - 1) : Math.min(Math.max(i + step, 0), conversations.length - 1)];
        if (next) go(next);
    };
    const copyThreads = () => navigator.clipboard.writeText(threadsMarkdown(session.threads)).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, error => setFlash(error.message));
    const toggleFileTree = () => {
        setPreference('file-tree', fileTreeOpen ? 'collapsed' : 'open');
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
                    <h1 class="h4 flex-1 min-width-0 d-flex flex-items-baseline">
                        <span class="flex-shrink-0">${diff.files.length} files changed</span>
                        <span class="worktree-path text-mono text-normal color-fg-muted f6 ml-2" title=${session.worktree}>${session.worktree}</span>
                    </h1>
                    ${conversations.length > 0 && html`
                        <div class="BtnGroup mr-2">
                            <button class="btn btn-sm BtnGroup-item" aria-label="Previous thread" title="Previous thread (k)" onClick=${() => navigate.current(-1)}>${octicon('chevron-up')}</button>
                            <button class="btn btn-sm BtnGroup-item" aria-label="Next thread" title="Next thread (j)" onClick=${() => navigate.current(1)}>${octicon('chevron-down')}</button>
                        </div>
                        <details class="details-reset details-overlay position-relative mr-3">
                            <summary class="btn btn-sm" role="button">${conversations.length} conversation${conversations.length === 1 ? '' : 's'}</summary>
                            <div class="dropdown-menu dropdown-menu-sw conversations">
                                ${conversations.map(thread => html`
                                    <button class="dropdown-item btn-link width-full text-left" onClick=${event => { event.target.closest('details').open = false; go(thread); }}>
                                        <span class="text-mono">${thread.anchor.path}</span> <span class="color-fg-muted">${where(thread)}</span>
                                        ${thread.status === 'waiting-for-claude' && html`<span class="Label Label--attention ml-2">Waiting for Claude</span>`}
                                        ${replied(thread) && html`<span class="Label Label--accent ml-2">Replied</span>`}
                                    </button>`)}
                            </div>
                        </details>`}
                    <button class="btn btn-sm mr-3" onClick=${copyThreads}>${copied ? 'Copied' : 'Copy threads'}</button>
                    <details ref=${settings} class="details-reset details-overlay position-relative mr-3" onKeyDown=${event => { if (event.key === 'Escape') closeSettings(); }}>
                        <summary class="btn-octicon" role="button" aria-label="Diff view settings">${octicon('gear')}</summary>
                        <div class="dropdown-menu dropdown-menu-sw diff-settings">
                            <div class="dropdown-header">Layout</div>
                            ${[['Unified', false], ['Split', true]].map(([name, value]) => html`
                                <label class="dropdown-item"><input type="radio" name="diff-view" class="mr-2" checked=${split === value} onChange=${() => chooseView(value)} />${name}</label>`)}
                            <div class="dropdown-divider"></div>
                            <label class="dropdown-item"><input type="checkbox" class="mr-2" checked=${!!diff.hideWhitespace} disabled=${busy} onChange=${event => chooseWhitespace(event.target.checked)} />Hide whitespace</label>
                        </div>
                    </details>
                    ${diff.files.length > 0 && html`
                        <span class="d-flex flex-items-center mr-3 f6 color-fg-muted">${progress(viewedCount, diff.files.length)}${viewedCount} / ${diff.files.length} viewed</span>`}
                    <select aria-label="Base" class=${`form-select mr-2${forward ? ' color-border-accent-emphasis color-bg-accent' : ''}`} disabled=${busy || review.readOnly}
                        value=${diff.ref} onChange=${event => choose(event.target.value)}>
                        ${grouped(bases).map(([group, choices]) => {
                            const options = choices.map(base => html`
                                <option value=${base.ref} disabled=${base.disabled}
                                    class=${forward && base.ref === 'last-review' ? 'text-bold' : ''}>${base.name}${forward && base.ref === 'last-review' ? ' (new changes)' : ''}</option>`);
                            return group ? html`<optgroup label=${group}>${options}</optgroup>` : options;
                        })}
                    </select>
                    ${review.readOnly ? html`<span class="Label Label--done">${session.closedBecause ? 'Closed' : 'Approved'}</span>` : html`
                        <button class="btn mr-2" disabled=${busy} onClick=${() => act('/send', { tree: diff.tree })}>Send</button>
                        <button class="btn btn-primary" disabled=${busy || pending} onClick=${approve}>Approve</button>`}
                </div>
                ${flash && html`<div class="flash flash-error mb-3">${flash}</div>`}
                ${!review.readOnly && !session.claudeSession && html`
                    <div class="flash flash-warn mb-3">No Claude session runs in this worktree: a Send wakes no one until one starts, with <code>cd ${shell(session.worktree)} && claude</code>.</div>`}
                ${!review.readOnly && session.claudeBlocked && html`
                    <div class="flash flash-warn mb-3">Claude is waiting for your answer in its session, to a permission or a question, before it replies in the threads.</div>`}
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
    const { readOnly, busy, act, diff, selection, setSelection, draft } = review;
    // The thread j or k goes to unfolds its file, and loads its diff.
    useEffect(() => {
        if (review.reveal?.path !== file.path) return;
        setFolded(false);
        setOpen(true);
    }, [review.reveal]);
    const { openThread, cancel } = newThread(review);
    // Lines the diff hid, shown by Expand: context lines, until another diff loads.
    const [expanded, setExpanded] = useState({ diff, lines: [] });
    // The gaps whose lines are on their way, by their range: their buttons wait, so a double click asks once.
    const [asking, setAsking] = useState(() => new Set());
    const expand = async (gap, from, to) => {
        const key = `${gap.from}-${gap.to}`;
        setAsking(all => new Set(all).add(key));
        const text = await review.lines(file.path, from, to);
        setAsking(all => new Set([...all].filter(other => other !== key)));
        if (!text) return;
        const lines = text.map((text, i) => ({ type: 'context', oldNo: from + i + gap.offset, newNo: from + i, text }));
        setExpanded(all => ({ diff, lines: [...all.diff === diff ? all.lines : [], ...lines] }));
    };
    const hunks = withContext(file.hunks, [...threads.flatMap(thread => thread.at?.context ?? []), ...expanded.diff === diff ? expanded.lines : []]);
    // The sides whose numbers show on a single column of code: both in Unified, none in the two halves of Split.
    // As on GitHub, an added or deleted file would leave a half empty in Split: it takes the whole width, with the numbers of its only side.
    const sides = !review.split ? ['old', 'new'] : { added: ['new'], deleted: ['old'] }[file.status] ?? null;
    // Folded, or its diff not loaded, a file still tells it holds threads.
    const unresolved = threads.filter(thread => !thread.resolved).length;
    return html`
        <section id=${id} data-path=${file.path} class="Box mb-3">
            <div class=${`Box-header file-header py-2 pl-2 d-flex flex-items-center${folded ? ' border-bottom-0 rounded-2' : ''}`}>
                <button class="btn-octicon ml-0 mr-1" aria-label=${folded ? 'Expand file' : 'Collapse file'} aria-expanded=${!folded} onClick=${() => setFolded(!folded)}>
                    ${octicon(folded ? 'chevron-right' : 'chevron-down')}
                </button>
                <span class="text-mono text-bold">${file.path}</span>
                ${unresolved > 0 && html`<span class="Counter ml-2">${unresolved} thread${unresolved === 1 ? '' : 's'}</span>`}
                <button class="btn-octicon ml-1" aria-label="Copy file path"
                    onClick=${() => Promise.resolve().then(() => navigator.clipboard.writeText(file.path)).catch(() => {})}>${octicon('copy')}</button>
                ${!readOnly && html`
                    <button class="btn-octicon ml-1" aria-label="Comment on file" onClick=${() => {
                        setFolded(false);
                        setSelection({ path: file.path, side: file.status === 'deleted' ? 'old' : 'new', from: 0, start: 0, end: 0 });
                    }}>${octicon('comment')}</button>`}
                <span class="mr-auto"></span>
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
                ${threads.filter(thread => !thread.at || !open || thread.at.end === 0).map(thread => html`<div key=${thread.id}>${threadBox(thread, review)}</div>`)}
                ${!readOnly && selection?.path === file.path && selection.end === 0 && html`
                    <div class="Box m-2 p-2"><${Composer} draft=${draft} busy=${busy} onSubmit=${openThread} onSend=${body => openThread(body, true)} onCancel=${cancel} /></div>`}
                ${file.binary ? html`<div class="Box-body color-fg-muted">Binary file not shown</div>`
                    : hunks.length === 0 ? file.status !== 'unchanged' && html`<div class="Box-body color-fg-muted">${file.status === 'modified' ? 'File mode changed' : 'Empty file'}</div>`
                    : !open ? html`<div class="Box-body text-center"><button class="btn-link" onClick=${() => setOpen(true)}>Load diff</button></div>`
                    : html`
                        <table class=${`diff-table${sides ? '' : ' diff-split'}`}>
                            ${!sides && html`<colgroup><col style=${numbers(hunks)} /><col /><col style=${numbers(hunks)} /><col /></colgroup>`}
                            <tbody>${rows({ ...file, hunks }, threads, { ...review, sides, expand, asking })}</tbody>
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

/** The file's hunks, and context lines out of them (around threads, or expanded) as hunks of their own, in the order of the file. */
function withContext(hunks, lines) {
    const around = new Map(lines.map(line => [line.newNo, line]));
    const runs = [];
    for (const line of [...around.values()].sort((a, b) => a.newNo - b.newNo)) {
        if (runs.at(-1)?.at(-1).newNo === line.newNo - 1) runs.at(-1).push(line);
        else runs.push([line]);
    }
    return [...hunks, ...runs.map(run => ({ header: `@@ -${run[0].oldNo},${run.length} +${run[0].newNo},${run.length} @@`, lines: run }))]
        .sort((a, b) => span(a).start - span(b).start);
}

/**
 * Where a hunk starts on the new side, and the first line after it on each side, from its header:
 * a count of 0 places the hunk after its start line (diff.context=0).
 */
function span({ header }) {
    const [a, b, c, d] = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/).slice(1).map(n => Number(n ?? 1));
    return { start: d ? c : c + 1, old: a + Math.max(b, 1), new: c + Math.max(d, 1) };
}

/**
 * The lines hidden before each hunk, then after the last one, on the new side: from `from` to `to`, numbered `offset` further on the old side,
 * which an unchanged line keeps between two hunks.
 */
function gaps(hunks, lineCount) {
    const spans = hunks.map(span);
    return [...spans, { start: lineCount + 1 }].map(({ start }, h) => {
        const above = spans[h - 1];
        return { from: above?.new ?? 1, to: start - 1, offset: above ? above.old - above.new : 0 };
    });
}

function threadBox(thread, { message, fold, readOnly, busy, act, sendThread, avatar, diff, current }) {
    // Outdated says the lines are gone from the code shown: a session without code shows none.
    return html`<${Thread} thread=${thread} draft=${message(thread.id)} fold=${fold(thread)} readOnly=${readOnly} busy=${busy} act=${act} sendThread=${sendThread} avatar=${avatar}
        tree=${diff.tree}
        outdated=${!thread.at && !!diff.tree} current=${current === thread.id} />`;
}

/** Opens a thread of mine on the selection, or drops it; text typed or a selection made while it opens stays, with the selection and its draft. */
function newThread({ selection, setSelection, draft, act, sendThread, diff, now }) {
    return {
        // With `send`, sends it at once: the thread just opened has the largest id of the session.
        openThread: async (body, send) => {
            const sent = selection;
            const { path, side, start, end } = sent;
            const done = await act('/threads', { author: 'me', path, side, start, end, body, base: diff.base, tree: diff.tree },
                send && (answer => sendThread(Math.max(...answer.threads.map(thread => thread.id)))))
                && now.current.selection === sent && now.current.text === body;
            if (done) setSelection(null);
            return done;
        },
        cancel: () => {
            setSelection(null);
            draft[1]('');
        },
    };
}

/** The text of line `no` on `side` of the file at `path` in the hunks of a diff; undefined when they do not show it. */
function lineText(diff, { path, side }, no) {
    const key = side === 'new' ? 'newNo' : 'oldNo';
    return diff.files.find(file => file.path === path)?.hunks.flatMap(hunk => hunk.lines).find(line => line[key] === no)?.text;
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
    const { readOnly, busy, selection, setSelection, draft, act, diff, now, sides, expand, asking } = review;
    const split = !sides;
    const lang = language(file.path);
    const selected = (side, no) => selection?.path === file.path && selection.side === side && no >= selection.start && no <= selection.end;
    // A click selects a line, a Shift+click extends the selection from the line clicked first, on the same side of the same file.
    const select = (side, no) => event => {
        if (readOnly || no === null) return;
        const from = event.shiftKey && selection?.path === file.path && selection.side === side ? selection.from : no;
        setSelection({ path: file.path, side, from, start: Math.min(from, no), end: Math.max(from, no) });
    };
    const { openThread, cancel } = newThread(review);
    // The lines of a selection on the new side, for a suggestion; none when one of them is not shown.
    const shownLines = selection?.path === file.path && selection.side === 'new' && selection.end > 0
        && [...Array(selection.end - selection.start + 1)].map((_, i) => file.hunks.flatMap(hunk => hunk.lines).find(line => line.newNo === selection.start + i)?.text);
    const suggest = shownLines && shownLines.every(text => text !== undefined) ? shownLines : null;
    const code = line => ({ __html: highlight(line.text, line.type === 'note' ? null : lang) });
    // The threads that end on a line, then the box of the selection that ends there: on one side in Split, on either in Unified.
    const under = (line, side) => {
        const ends = range => range?.path === file.path && (!side || range.side === side) && (range.side === 'new' ? line.newNo : line.oldNo) === range.end;
        return line ? [
            ...threads.filter(thread => thread.at && ends({ ...thread.anchor, ...thread.at })).map(thread => html`<div key=${`t${thread.id}`}>${threadBox(thread, review)}</div>`),
            !readOnly && ends(selection) && html`
                <div key="selection" class="Box m-2 p-2">
                    <${Composer} draft=${draft} busy=${busy} onSubmit=${openThread} onSend=${body => openThread(body, true)} onCancel=${cancel} suggest=${suggest} />
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
    const hidden = gaps(file.hunks, file.lineCount ?? 0);
    /** The row of the lines hidden above a hunk, or after the last one, as GitHub's: 20 more lines a click, or all of fewer. */
    const expander = (gap, h, header) => {
        const size = gap.to - gap.from + 1;
        const button = (label, icon, from, to) => html`
            <button class="btn-octicon diff-expand" aria-label=${label} disabled=${asking.has(`${gap.from}-${gap.to}`)} onClick=${() => expand(gap, from, to)}>${octicon(icon)}</button>`;
        // A hunk shows its header unless it follows the lines above it; the first one always does.
        // /lines refuses a path with a newline: such a file gets no Expand.
        if (size < 1 && h > 0) return [];
        return [html`
            <tr key=${`h${header}`} class="diff-hunk">
                <td colspan=${split ? 1 : sides.length}>
                    ${size > 0 && !file.path.includes('\n') && (size <= 20 ? button('Expand all', 'unfold', gap.from, gap.to) : [
                        h > 0 && button('Expand down', 'fold-down', gap.from, gap.from + 19),
                        header !== null && button('Expand up', 'fold-up', gap.to - 19, gap.to),
                    ])}
                </td>
                <td colspan=${split ? 3 : 1}>${header}</td>
            </tr>`];
    };
    return file.hunks.flatMap((hunk, h) => [
        ...expander(hidden[h], h, hunk.header),
        ...split ? pairs(hunk.lines).flatMap(([left, right], r) => {
            const [old, added] = [under(left, 'old'), under(right, 'new')];
            return [
                html`<tr key=${`${hunk.header}-${r}`}>${half(left, 'old')}${half(right, 'new')}</tr>`,
                (old.length > 0 || added.length > 0) && html`<tr key=${`u${hunk.header}-${r}`}><td colspan="2">${old}</td><td colspan="2">${added}</td></tr>`,
            ];
        }) : hunk.lines.flatMap((line, l) => {
            const items = under(line);
            return [
                html`
                    <tr key=${`${hunk.header}-${l}`} class=${`diff-line-${line.type}${selected('old', line.oldNo) || selected('new', line.newNo) ? ' selected' : ''}`}>
                        ${sides.map(side => {
                            const no = side === 'old' ? line.oldNo : line.newNo;
                            return html`<td class="diff-num" onClick=${select(side, no)}>${no}</td>`;
                        })}
                        <td class="diff-code" dangerouslySetInnerHTML=${code(line)}></td>
                    </tr>`,
                items.length > 0 && html`<tr key=${`u${hunk.header}-${l}`}><td colspan=${sides.length + 1}>${items}</td></tr>`,
            ];
        }),
    ]).concat(file.hunks.length ? expander(hidden.at(-1), file.hunks.length, null) : [])
    // Preact matches keyed rows only among real children: a false left here rebuilds the rows after it, and their drafts.
        .filter(Boolean);
}

function Thread({ thread, draft, fold: [open, setOpen], readOnly, busy, act, sendThread, avatar, tree, outdated, current }) {
    const [label, color] = STATUS[thread.status] ?? [];
    const whole = thread.anchor.end === 0;
    // The Pending message of mine being edited, by its rank, and its text.
    const [editing, setEditing] = useState(null);
    const edit = useState('');
    const save = async body => {
        const done = await act(`/threads/${thread.id}/messages/${editing}`, { body });
        if (done) setEditing(null);
        return done;
    };
    const remove = i => {
        if (confirm('Delete this pending message?')) act(`/threads/${thread.id}/messages/${i}/delete`, {});
    };
    // A Resolved thread arrives folded; a fold by hand holds through polls and changes of view, until the status changes.
    return html`
        <details id=${`thread-${thread.id}`} class=${`Box m-2 thread${current ? ' thread-current' : ''}`} open=${open} onToggle=${event => setOpen(event.target.open)}>
            <summary class="Box-header py-2">
                <span class="text-bold">${whole ? 'File' : where(thread).replace(/^l/, 'L')}</span>
                ${label && html`<span class=${`Label ${color} ml-2`}>${label}</span>`}
                ${outdated && html`<span class="Label Label--secondary ml-2">Outdated</span>`}
            </summary>
            ${!thread.at && !whole && html`<${Excerpt} anchor=${thread.anchor} />`}
            ${thread.messages.map((message, i) => html`
                <div class="Box-row d-flex">
                    ${message.author === 'claude' ? CLAUDE_AVATAR : myAvatar(avatar)}
                    <div class="flex-auto min-width-0">
                        <div class="mb-1">
                            <span class="text-bold mr-2">${message.author === 'me' ? 'You' : 'Claude'}</span>
                            ${message.date ? html`<span class="color-fg-muted f6">${new Date(message.date).toLocaleString()}</span>`
                                : html`<span class="Label Label--attention">Pending</span>`}
                            ${!readOnly && !message.date && message.author === 'me' && editing === null && html`
                                <button class="btn-link f6 ml-2" disabled=${busy} onClick=${() => { edit[1](message.body); setEditing(i); }}>Edit</button>
                                <button class="btn-link f6 ml-2 color-fg-danger" disabled=${busy} onClick=${() => remove(i)}>Delete</button>`}
                        </div>
                        ${editing === i
                            ? html`<${Composer} draft=${edit} busy=${busy} label="Save" onSubmit=${save} onCancel=${() => setEditing(null)} />`
                            : html`<div class="markdown-body" dangerouslySetInnerHTML=${{ __html: markdown(message.body, thread.anchor.lines) }}></div>`}
                    </div>
                </div>`)}
            ${!readOnly && editing === null && html`
                <div class="Box-footer">
                    ${thread.resolved
                        // A Resolved thread takes no message until its Unresolve.
                        ? html`<button class="btn btn-sm" disabled=${busy} onClick=${() => act(`/threads/${thread.id}/unresolve`, {})}>Unresolve</button>`
                        : html`
                            <${Composer} draft=${draft} busy=${busy} onSubmit=${body => act(`/threads/${thread.id}/messages`, { author: 'me', body })}
                                onSend=${body => body.trim() ? act(`/threads/${thread.id}/messages`, { author: 'me', body }, () => sendThread(thread.id))
                                    : act('/send', { tree, threads: [thread.id] })}
                                pending=${thread.messages.some(message => !message.date)}
                                suggest=${thread.anchor.side === 'new' && !whole ? thread.anchor.lines : null} />
                            <button class="btn btn-sm mt-2" disabled=${busy} onClick=${() => act(`/threads/${thread.id}/resolve`, {})}>Resolve</button>`}
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

/**
 * A message being written, kept across polls, and cleared once the server took it, unless typed on meanwhile.
 * Send adds it then sends its thread alone, or sends the `pending` messages of the thread with nothing typed.
 */
function Composer({ draft, busy, onSubmit, onSend, pending, onCancel, label = 'Add message', suggest }) {
    const [text, setText] = draft;
    // A suggestion block with the lines it replaces, to change in place: Claude applies it.
    const insert = () => setText(text => `${text}${text && !text.endsWith('\n') ? '\n' : ''}\`\`\`suggestion\n${suggest.join('\n')}\n\`\`\`\n`);
    const submit = async (event, write = onSubmit) => {
        event.preventDefault();
        const sent = text;
        if (await write(sent)) setText(current => current === sent ? '' : current);
    };
    return html`
        <form onSubmit=${submit}>
            <textarea class="form-control width-full mb-2" aria-label="Message" placeholder="Leave a message (markdown)" value=${text} onInput=${event => setText(event.target.value)}></textarea>
            <button class="btn btn-sm btn-primary" type="submit" disabled=${busy || !text.trim()}>${label}</button>
            ${onSend && html`
                <button class="btn btn-sm ml-2" type="button" aria-label="Send thread" title="Add the message, then send this thread alone to Claude"
                    disabled=${busy || (!text.trim() && !pending)} onClick=${event => submit(event, onSend)}>Send</button>`}
            ${suggest && html`<button class="btn btn-sm ml-2" type="button" onClick=${insert}>Suggest change</button>`}
            ${onCancel && html`<button class="btn btn-sm ml-2" type="button" onClick=${onCancel}>Cancel</button>`}
        </form>`;
}

// ponytail: line by line, a token spanning lines (block comment, template string) is miscolored; highlight whole files if it bothers.
function highlight(text, language) {
    return language ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escape(text);
}

/** The open sessions of all worktrees, the ones that wait for me first; or the closed ones, the latest first. */
function Reviews() {
    const [tab, setTab] = useState('open');
    const [sessions, setSessions] = useState();
    const [error, setError] = useState();
    useEffect(() => {
        setSessions(undefined);
        api(tab === 'open' ? '/api/sessions' : '/api/sessions?closed').then(setSessions, error => setError(error.message));
    }, [tab]);
    if (error) return html`<div class="flash flash-error m-3">${error}</div>`;
    return html`
        <main class="p-3">
            <h1 class="h4 mb-3">Reviews</h1>
            <nav class="UnderlineNav mb-3">
                <div class="UnderlineNav-body" role="tablist">
                    ${[['open', 'Open'], ['closed', 'Closed']].map(([key, name]) => html`
                        <button class="UnderlineNav-item" role="tab" aria-selected=${tab === key} aria-current=${tab === key ? 'page' : null} onClick=${() => setTab(key)}>${name}</button>`)}
                </div>
            </nav>
            ${!sessions ? html`<p class="color-fg-muted">Loading…</p>`
                : sessions.length === 0 ? html`<p class="color-fg-muted">${tab === 'open'
                    ? html`No open session. Open one with <code>/review-local</code>, or <code>?worktree=/path/to/worktree</code>.` : 'No closed session.'}</p>`
                : html`
                <div class="Box">
                    ${sessions.map(session => html`
                        <a key=${session.id} href=${`/s/${session.id}`} class="Box-row d-flex flex-items-center Link--primary no-underline">
                            <span class="text-bold mr-2">${session.repo}</span>
                            ${tab === 'open' && html`<span class="text-mono mr-2">${session.branch}</span>`}
                            <span class="flex-1 text-mono f6 color-fg-muted">${session.worktree}</span>
                            ${tab === 'open'
                                ? html`<span class="Label Label--attention">${session.waitingForClaude} Waiting for Claude</span>`
                                : html`<span class="color-fg-muted f6 mr-2">${new Date(session.approvedAt).toLocaleString()}</span>
                                    <span class="Label Label--done">${session.closedBecause ? 'Closed' : 'Approved'}</span>`}
                        </a>`)}
                </div>`}
        </main>`;
}

render(worktree || sessionId ? html`<${App} />` : html`<${Reviews} />`, document.getElementById('app'));
