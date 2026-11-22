/** What the mod remembers of its worktree's sessions, to wake Claude on a Send and relaunch him once per Send. */
export type Watch = {
    /** The session of the last look: undefined before the first one, null when the worktree had none. */
    session?: string | null;
    /** Per session seen, its last Send seen and the Send whose relaunch opened a turn: a session seen again never starts over. */
    sessions: Record<string, { sends: number; relaunched: number }>;
    /** The threads Waiting for Claude at the last look, and the readonly ones among them. */
    waiting: number;
    readonly: number;
    /** The review message of a Send that no prompt gave the main conversation yet, null without one: never a fork's, nor a relaunch's once given. */
    review: Review | null;
    /** A prompt still to submit for the threads waiting: the wake of a Send, or the relaunch at the end of a turn. */
    owed: 'wake' | 'relaunch' | null;
    /** The prompt submitted, with the review message it carries, until it opens a turn or is dropped. */
    submitting: { owed: 'wake' | 'relaunch' | null; session: string; sends: number; review: Review | null } | null;
    /** The last prompt was dropped: it is retried at the next prompt or turn start, not at every poll. */
    dropped: boolean;
    /** The session whose wake or relaunch opened a turn: the end of the last turn it owes notifies it. */
    notify: string | null;
    /** Whether the main loop is in a turn. */
    busy: boolean;
    /** The last turn of the main loop ended interrupted or on an error: a relaunch the end of a fork then owes waits for the next prompt. */
    halted: boolean;
    /** The fork answering a Send in the background while Claude works, with its agent once spawned: one at a time. */
    forking: { owed: 'wake' | 'relaunch'; session: string; sends: number; agent?: string } | null;
};

export type Review = { body: string; readonly: boolean };

/** The open session of the worktree as the mod sees it, or null without one; `review`, the review message of its last Send. */
export type Seen = { id: string; sends: number; waiting: number; readonly?: number; review?: Review | null } | null;

export const start: Watch = { sessions: {}, waiting: 0, readonly: 0, review: null, owed: null, submitting: null, dropped: false, notify: null, busy: false, halted: false, forking: null };

/** The text of a wake, a relaunch and the first message alike: the worktree, the threads waiting, the readonly ones among them, `aside`, then the review message. */
export function prompt(worktree: string, waiting: number, readonly = 0, review: Review | null = null, aside = ''): string {
    const threads = waiting > 1 ? `${waiting} threads are waiting for you` : `${waiting} thread is waiting for you`;
    let text = waiting
        ? `claude-reviews: ${threads} in the worktree ${worktree}${readonly ? `, ${readonly} of them readonly` : ''}. Read them with list_open_threads, reply in each with reply_to_thread, `
            + `and change the code when a thread asks for it${readonly ? ', but answer a readonly thread without changing any file' : ''}.`
        : `claude-reviews: a review message is waiting for you in the worktree ${worktree}: answer it here${review?.readonly ? ', without changing any file' : ''}.`;
    text += aside;
    if (!review) return text;
    return waiting ? `${text}\n\nThe review message${review.readonly ? ', to answer without changing any file' : ''}:\n\n${review.body}` : `${text}\n\n${review.body}`;
}

/** The prompt of a fork, which answers the threads while the main conversation works: it must neither take over its task nor collide with its edits; the review message is the conversation's. */
export function forkPrompt(worktree: string, waiting: number, readonly = 0): string {
    return prompt(worktree, waiting, readonly, null, ' You are a fork answering them in the background: the main conversation keeps working in this same worktree at the same time. '
        + 'Do not go on with its task, and do not edit the files it is working on: when a thread asks for a change there, say so in the thread instead.');
}

/** The status line: the threads waiting for Claude, and what a drop holds, a wake, a relaunch or a review message; undefined when nothing waits. */
export function status(watch: Watch): string | undefined {
    const what = watch.owed ?? (watch.review && 'review message');
    const held = watch.dropped && what ? ` · ${what} held until the next prompt` : '';
    if (!watch.waiting) return held ? `claude-reviews${held}` : undefined;
    const threads = watch.waiting > 1 ? `${watch.waiting} threads` : '1 thread';
    return `claude-reviews · ${threads} waiting for Claude${watch.forking ? ' · a fork answers in the background' : held}`;
}

/** A look at the session: a new Send wakes Claude if threads wait for him, or if it carries a review message; neither, nothing is owed. */
export function look(watch: Watch, seen: Seen): Watch {
    if (!seen) return { ...watch, session: null, waiting: 0, readonly: 0, review: null, owed: null };
    // Sends made before the mod first looked are for the first message, not for a wake.
    const known = watch.sessions[seen.id] ?? { sends: watch.session === undefined ? seen.sends : 0, relaunched: 0 };
    // A late look may have read an older Send: the count of Sends never goes back.
    const sends = Math.max(known.sends, seen.sends);
    const fresh = seen.sends > known.sends;
    // A review message stays until a prompt gives it, though a later Send carries none: Claude answers it in the conversation, where nothing tells it answered.
    const review = (fresh && seen.review) || watch.review;
    const next = { ...watch, session: seen.id, waiting: seen.waiting, readonly: seen.readonly ?? 0, review, sessions: { ...watch.sessions, [seen.id]: { ...known, sends } } };
    if (!seen.waiting) return { ...next, owed: null };
    return fresh ? { ...next, owed: 'wake' } : next;
}

/** The end of a turn: threads still waiting relaunch Claude, once per Send, unless a fork answers that Send. */
export function turnEnded(watch: Watch, seen: Seen): Watch {
    const next = look(watch, seen);
    const known = seen && next.sessions[seen.id];
    const forked = next.forking?.session === seen?.id && next.forking?.sends === known?.sends;
    return known && next.waiting && !next.owed && !forked && known.relaunched !== known.sends ? { ...next, owed: 'relaunch' } : next;
}

/** Whether a prompt is to be submitted now. */
export function due(watch: Watch): boolean {
    // A review message alone during a turn of Claude's own has no fork to go to: queued now, it would hold the wake of the next Send until the turn ends.
    const held = watch.busy && !watch.notify && !watch.owed;
    return (watch.owed !== null || watch.review !== null) && !watch.submitting && !watch.forking && !watch.dropped && !held;
}

/** Whether the due prompt goes to a fork: Claude works on a turn of its own, which a prompt would wait for; a turn a wake, a relaunch or the first prompt opened answers threads already. */
export function forks(watch: Watch): boolean {
    // A fork answers the threads alone: a review message waits for the end of the turn, and goes to the conversation.
    return watch.busy && !watch.notify && watch.waiting > 0;
}

/** The first prompt entered with the threads waiting and the review message of `seen` as context: no prompt gives them again, and its turn answers them as a wake's does. */
export function greet(watch: Watch, seen: NonNullable<Seen>): Watch {
    return { ...look(watch, seen), owed: null, review: null, notify: seen.id };
}

/** The main conversation read the review message with list_open_threads: no prompt gives it again. */
export function delivered(watch: Watch): Watch {
    return { ...watch, review: null };
}

/** The due prompt for the threads is going to a fork, for the Send of the session seen last; the review message stays for a prompt. */
export function forking(watch: Watch): Watch {
    const session = watch.session!;
    return { ...watch, owed: null, forking: { owed: watch.owed!, session, sends: watch.sessions[session].sends } };
}

/** The fork started as `agent`; denied, the prompt it took is owed again, to submit instead. */
export function forked(watch: Watch, agent?: string): Watch {
    const fork = watch.forking!;
    return agent ? { ...watch, forking: { ...fork, agent } } : { ...watch, forking: null, owed: watch.owed ?? fork.owed };
}

/**
 * The end of the fork: answered, it spends the relaunch of its Send, and notifies its session if no prompt is owed after it.
 * Interrupted or on an error, Claude may not have replied: the end of its turn relaunches it, or at once if it is idle, or at the next prompt if its turn was stopped too.
 */
export function forkEnded(watch: Watch, answered: boolean): { watch: Watch; session: string | null } {
    const fork = watch.forking!;
    const next = { ...watch, forking: null };
    if (answered) {
        // A fork of a worktree left since spends nothing here, and notifies its session whatever this one owes.
        const known = next.sessions[fork.session];
        const sessions = known ? { ...next.sessions, [fork.session]: { ...known, relaunched: fork.sends } } : next.sessions;
        const owed = next.session === fork.session && (next.owed || next.review);
        return { watch: { ...next, sessions }, session: owed ? null : fork.session };
    }
    const relaunch = !next.busy && !next.owed && next.waiting > 0 && next.session === fork.session;
    // After a main turn interrupted or ended on an error, a relaunch at once would override the person who stopped Claude.
    return { watch: relaunch ? { ...next, owed: 'relaunch', dropped: next.halted } : next, session: null };
}

/** The due prompt is being submitted, for the Send of the session seen last. */
export function sending(watch: Watch): Watch {
    const session = watch.session!;
    return { ...watch, submitting: { owed: watch.owed, session, sends: watch.sessions[session].sends, review: watch.review } };
}

/**
 * The submitted prompt opened a turn, or was dropped; a relaunch counts only once it opened its turn.
 * A Send seen since keeps the prompt it is owed, and a review message it brought, which the frozen text did not carry.
 */
export function submitted(watch: Watch, dropped: boolean): Watch {
    const sent = watch.submitting!;
    if (dropped) return { ...watch, submitting: null, dropped: true };
    const known = watch.sessions[sent.session];
    const sessions = sent.owed === 'relaunch' ? { ...watch.sessions, [sent.session]: { ...known, relaunched: sent.sends } } : watch.sessions;
    const later = known.sends > sent.sends;
    return { ...watch, submitting: null, owed: later ? watch.owed : null, review: watch.review === sent.review ? null : watch.review, sessions, notify: sent.session };
}

/**
 * The end of a turn: the session to notify, if a wake or relaunch opened the turn and no prompt is owed after it.
 * Each end spends it: the owed prompt notifies again once it opens its turn, and a prompt no longer owed, never.
 */
export function notified(watch: Watch): { watch: Watch; session: string | null } {
    return { watch: { ...watch, notify: null }, session: watch.owed || watch.review ? null : watch.notify };
}

/** A turn of the main loop starts: a dropped prompt may be submitted again, to a fork. */
export function turnStarted(watch: Watch): Watch {
    return { ...resumed(watch), busy: true };
}

/** A turn of the main loop ends, `answered` or interrupted, or on an error. */
export function idle(watch: Watch, answered = true): Watch {
    return { ...watch, busy: false, halted: !answered };
}

/** A prompt or a turn starts: a dropped prompt may be submitted again. */
export function resumed(watch: Watch): Watch {
    // ponytail: the retry trusts the last look rather than reading the session again; the next poll corrects it within 2 s.
    return { ...watch, dropped: false };
}

/**
 * The directory a call of the main loop leads the mod to: the folder of the file Edit, Write or NotebookEdit wrote, a relative path read from `cwd`,
 * or `cwd`, the shell's directory after a Bash call, once it differs from `shell`, the one before; undefined for any other call.
 * `home` is the folder the shell returns to after a cd it does not keep, `failed` whether the call ended on an error.
 */
export function touched(e: { tool: string; [argument: string]: unknown }, { shell, cwd, home, failed }: { shell: string; cwd: string; home: string; failed: boolean }): string | undefined {
    // `cd x && make` leaves the shell where it was, or brings it back home, outside the working directories: only a cd it keeps leads there, even if the command then fails.
    // ponytail: a cd Claude keeps back to home leads nowhere either; the next write there moves the review.
    if (e.tool === 'Bash') return cwd !== shell && cwd !== home ? cwd : undefined;
    const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : undefined;
    if (failed || typeof file !== 'string') return undefined;
    const path = file.startsWith('/') ? file : `${cwd}/${file}`;
    return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** The uids of the sockets listening on `port`, from the text of /proc/net/tcp and /proc/net/tcp6. */
export function listeners(text: string, port: number): number[] {
    const local = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    // Each line: sl, local address:port, remote address:port, state (0A when listening), queues, timer, retransmits, uid…
    return text.split('\n').map(line => line.trim().split(/\s+/))
        .filter(fields => fields[1]?.endsWith(local) && fields[3] === '0A')
        .map(fields => Number(fields[7]));
}
