/** A letter or a digit: an empty line or a lone brace proves nothing. */
const significant = (line: string) => /[\p{L}\p{N}]/u.test(line);

/**
 * Where an Anchor's lines are now in `target`, the file's lines on its side in the code looked at (null without a file at its path),
 * or null when the thread is Outdated (#8).
 * Every place where the range is found whole, unchanged and in order, scores the significant neighbours found around it;
 * the best scored wins, then the nearest to the Anchor's original position, never to the last position found.
 * Without any neighbour found, only a significant range alone in the file is followed.
 */
export function reanchor(anchor: { start: number; lines: string[]; before: string[]; after: string[] }, target: string[] | null): { start: number; end: number } | null {
    if (!target) return null;
    const { lines, before, after } = anchor;
    const places: { start: number; score: number; distance: number }[] = [];
    for (let s = 0; s + lines.length <= target.length; s++) {
        if (!lines.every((line, i) => target[s + i] === line)) continue;
        const score = before.filter((line, i) => significant(line) && target[s - before.length + i] === line).length
            + after.filter((line, i) => significant(line) && target[s + lines.length + i] === line).length;
        places.push({ start: s + 1, score, distance: Math.abs(s + 1 - anchor.start) });
    }
    places.sort((x, y) => y.score - x.score || x.distance - y.distance || x.start - y.start);
    const best = places[0];
    if (!best || (best.score === 0 && (places.length > 1 || !lines.some(significant)))) return null;
    return { start: best.start, end: best.start + lines.length - 1 };
}
