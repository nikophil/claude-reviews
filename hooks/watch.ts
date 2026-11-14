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
};

/** The open session of the worktree as the mod sees it, or null without one. */
export type Seen = { id: string; sends: number; waiting: number } | null;

export const start: Watch = { sessions: {}, waiting: 0, owed: null, submitting: null, dropped: false };

/** The text of a wake, a relaunch and the first message alike. */
export function prompt(waiting: number): string {
    const threads = waiting > 1 ? `${waiting} threads t'attendent` : `${waiting} thread t'attend`;
    return `claude-reviews : ${threads}. Lis-les avec list_open_threads, réponds dans chacun avec reply_to_thread, et modifie le code quand un thread le demande.`;
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

/** The end of a turn: threads still waiting relaunch Claude, once per Send. */
export function turnEnded(watch: Watch, seen: Seen): Watch {
    const next = look(watch, seen);
    const known = seen && next.sessions[seen.id];
    return known && next.waiting && !next.owed && known.relaunched !== known.sends ? { ...next, owed: 'relaunch' } : next;
}

/** Whether a prompt is to be submitted now. */
export function due(watch: Watch): boolean {
    return watch.owed !== null && !watch.submitting && !watch.dropped;
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
    return { ...watch, submitting: null, owed: null, sessions };
}

/** A prompt or a turn starts: a dropped prompt may be submitted again. */
export function resumed(watch: Watch): Watch {
    // ponytail: the retry trusts the last look rather than reading the session again; the next poll corrects it within 2 s.
    return { ...watch, dropped: false };
}
