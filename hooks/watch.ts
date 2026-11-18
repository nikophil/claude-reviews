/** What the mod remembers of its worktree's sessions, to wake Claude on a Send and relaunch him once per Send. */
export type Watch = {
    /** The session of the last look: undefined before the first one, null when the worktree had none. */
    session?: string | null;
    /** Per session seen, its last Send seen and the Send whose relaunch opened a turn: a session seen again never starts over. */
    sessions: Record<string, { sends: number; relaunched: number }>;
    /** The threads Waiting for Claude at the last look. */
    waiting: number;
    /** A prompt still to submit: the wake of a Send, or the relaunch at the end of a turn. */
    owed: 'wake' | 'relaunch' | null;
    /** The prompt submitted, until it opens a turn or is dropped. */
    submitting: { owed: 'wake' | 'relaunch'; session: string; sends: number } | null;
    /** The last prompt was dropped: it is retried at the next prompt or turn start, not at every poll. */
    dropped: boolean;
    /** The session whose wake or relaunch opened a turn: the end of the last turn it owes notifies it. */
    notify: string | null;
    /** Whether the main loop is in a turn. */
    busy: boolean;
    /** The fork answering a Send in the background while Claude works, with its agent once spawned: one at a time. */
    forking: { owed: 'wake' | 'relaunch'; session: string; sends: number; agent?: string } | null;
};

/** The open session of the worktree as the mod sees it, or null without one. */
export type Seen = { id: string; sends: number; waiting: number } | null;

export const start: Watch = { sessions: {}, waiting: 0, owed: null, submitting: null, dropped: false, notify: null, busy: false, forking: null };

/** The text of a wake, a relaunch and the first message alike. */
export function prompt(waiting: number): string {
    const threads = waiting > 1 ? `${waiting} threads are waiting for you` : `${waiting} thread is waiting for you`;
    return `claude-reviews: ${threads}. Read them with list_open_threads, reply in each with reply_to_thread, and change the code when a thread asks for it.`;
}

/** The prompt of a fork, which answers while the main conversation works: it must neither take over its task nor collide with its edits. */
export function forkPrompt(waiting: number): string {
    return `${prompt(waiting)} You are a fork answering them in the background: the main conversation keeps working in this same worktree at the same time. `
        + 'Do not go on with its task, and do not edit the files it is working on: when a thread asks for a change there, say so in the thread instead.';
}

/** The status line: the threads waiting for Claude, and a wake a drop holds; undefined when none waits. */
export function status(watch: Watch): string | undefined {
    if (!watch.waiting) return undefined;
    const threads = watch.waiting > 1 ? `${watch.waiting} threads` : '1 thread';
    const held = watch.forking ? ' · a fork answers in the background' : watch.dropped && watch.owed ? ' · wake held until the next prompt' : '';
    return `claude-reviews · ${threads} waiting for Claude${held}`;
}

/** A look at the session: a new Send wakes Claude if threads wait for him; nothing waiting, nothing is owed. */
export function look(watch: Watch, seen: Seen): Watch {
    if (!seen) return { ...watch, session: null, waiting: 0, owed: null };
    // Sends made before the mod first looked are for the first message, not for a wake.
    const known = watch.sessions[seen.id] ?? { sends: watch.session === undefined ? seen.sends : 0, relaunched: 0 };
    // A late look may have read an older Send: the count of Sends never goes back.
    const sends = Math.max(known.sends, seen.sends);
    const next = { ...watch, session: seen.id, waiting: seen.waiting, sessions: { ...watch.sessions, [seen.id]: { ...known, sends } } };
    if (!seen.waiting) return { ...next, owed: null };
    return seen.sends > known.sends ? { ...next, owed: 'wake' } : next;
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
    return watch.owed !== null && !watch.submitting && !watch.forking && !watch.dropped;
}

/** Whether the due prompt goes to a fork: Claude works on a turn of its own, which a prompt would wait for; a turn a wake or relaunch opened answers threads already. */
export function forks(watch: Watch): boolean {
    return watch.busy && !watch.notify;
}

/** The due prompt is going to a fork, for the Send of the session seen last. */
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
 * Interrupted or on an error, Claude may not have replied: the end of its turn relaunches it, or at once if it is idle.
 */
export function forkEnded(watch: Watch, answered: boolean): { watch: Watch; session: string | null } {
    const fork = watch.forking!;
    const next = { ...watch, forking: null };
    if (answered) {
        const sessions = { ...next.sessions, [fork.session]: { ...next.sessions[fork.session], relaunched: fork.sends } };
        return { watch: { ...next, sessions }, session: next.owed ? null : fork.session };
    }
    const relaunch = !next.busy && !next.owed && next.waiting > 0 && next.session === fork.session;
    return { watch: relaunch ? { ...next, owed: 'relaunch' } : next, session: null };
}

/** The due prompt is being submitted, for the Send of the session seen last. */
export function sending(watch: Watch): Watch {
    const session = watch.session!;
    return { ...watch, submitting: { owed: watch.owed!, session, sends: watch.sessions[session].sends } };
}

/** The submitted prompt opened a turn, or was dropped; a relaunch counts only once it opened its turn. */
export function submitted(watch: Watch, dropped: boolean): Watch {
    const sent = watch.submitting!;
    if (dropped) return { ...watch, submitting: null, dropped: true };
    const known = watch.sessions[sent.session];
    const sessions = sent.owed === 'relaunch' ? { ...watch.sessions, [sent.session]: { ...known, relaunched: sent.sends } } : watch.sessions;
    return { ...watch, submitting: null, owed: null, sessions, notify: sent.session };
}

/**
 * The end of a turn: the session to notify, if a wake or relaunch opened the turn and no prompt is owed after it.
 * Each end spends it: the owed prompt notifies again once it opens its turn, and a prompt no longer owed, never.
 */
export function notified(watch: Watch): { watch: Watch; session: string | null } {
    return { watch: { ...watch, notify: null }, session: watch.owed ? null : watch.notify };
}

/** A turn of the main loop starts: a dropped prompt may be submitted again, to a fork. */
export function turnStarted(watch: Watch): Watch {
    return { ...resumed(watch), busy: true };
}

/** A turn of the main loop ends, whatever its reason. */
export function idle(watch: Watch): Watch {
    return { ...watch, busy: false };
}

/** A prompt or a turn starts: a dropped prompt may be submitted again. */
export function resumed(watch: Watch): Watch {
    // ponytail: the retry trusts the last look rather than reading the session again; the next poll corrects it within 2 s.
    return { ...watch, dropped: false };
}

/** The uids of the sockets listening on `port`, from the text of /proc/net/tcp and /proc/net/tcp6. */
export function listeners(text: string, port: number): number[] {
    const local = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    // Each line: sl, local address:port, remote address:port, state (0A when listening), queues, timer, retransmits, uid…
    return text.split('\n').map(line => line.trim().split(/\s+/))
        .filter(fields => fields[1]?.endsWith(local) && fields[3] === '0A')
        .map(fields => Number(fields[7]));
}
