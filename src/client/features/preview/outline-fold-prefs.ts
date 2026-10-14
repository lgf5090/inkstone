import { IS_DEMO_MODE } from '../../lib/runtime';

/**
 * The outline's folded rows, kept per note on this device.
 *
 * A folded heading is a reading position, not a property of the note: it says what *this* reader closed
 * to get at the part they wanted, the way the sidebar's open folders say which parts of the library they
 * work in. So it belongs to the device, like `expandedFolders` does, and not to the account — and losing
 * it on every navigation is why folding a long outline back to one chapter was a thing readers had to
 * redo each time they came back to a note.
 *
 * The shape is the app's existing one for device-local UI state (see `lib/emoji-prefs.ts` and
 * `lib/folder-prefs.ts`): a versioned key, a validator that refuses anything the storage did not get
 * from this module, and a best-effort write that cannot fail a render. It lives next to the rail rather
 * than in `store/ui.ts` because the store's persisted set is a closed list of keys — adding one there
 * is that module's decision, not this panel's.
 */
export const OUTLINE_FOLD_STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.outlineFolds' : 'inkstone.outlineFolds';

/** How many notes keep their folds. Beyond it the least recently folded note is dropped whole. */
export const OUTLINE_FOLD_NOTES_MAX = 50;

/** How many folded rows one note keeps. The rail runs out of headings long before it runs out of room. */
export const OUTLINE_FOLD_SLUGS_MAX = 400;

/** A slug is a heading anchor; nothing real is this long, and a stored value this long is not real. */
const SLUG_MAX_CHARS = 200;

/** `outlineDefaultLevel` is clamped to 1…6 by the settings merge; a stored level outside it is garbage. */
const LEVEL_MIN = 1;
const LEVEL_MAX = 6;

export interface OutlineFold {
    /**
     * The level this fold was taken against. A stored fold is the reader's override of the default
     * *only while that default is the one they saw*: when the app-wide level changes underneath a note,
     * the setting wins and the stale override is dropped rather than kept forever.
     */
    level: number;
    /** The slugs the reader folded away. Empty is a real answer — it means they opened everything. */
    slugs: string[];
}

function storage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

function readLevel(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value))
        return null;
    return value >= LEVEL_MIN && value <= LEVEL_MAX ? value : null;
}

function readSlugs(value: unknown): string[] {
    if (!Array.isArray(value))
        return [];
    const kept = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string' || !item || item.length > SLUG_MAX_CHARS)
            continue;
        kept.add(item);
        if (kept.size === OUTLINE_FOLD_SLUGS_MAX)
            break;
    }
    return [...kept];
}

function readFold(value: unknown): OutlineFold | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const record = value as Record<string, unknown>;
    const level = readLevel(record.level);
    if (level === null)
        return null;
    return { level, slugs: readSlugs(record.slugs) };
}

/**
 * The whole map, or `null` when the key holds nothing readable.
 *
 * A torn write or a hand-edited value is answered with `null` — every note then takes the level default
 * — rather than a partial map, because a fold that came from somewhere else is exactly the surprise this
 * module is meant to remove. Insertion order is recency, so the oldest note is the one a new fold drops.
 */
function readFolds(source: Storage | null): Map<string, OutlineFold> | null {
    if (!source)
        return null;
    let raw: string | null;
    try {
        raw = source.getItem(OUTLINE_FOLD_STORAGE_KEY);
    }
    catch {
        return null;
    }
    if (!raw)
        return new Map();
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        const folds = new Map<string, OutlineFold>();
        for (const [noteId, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!noteId || noteId.length > SLUG_MAX_CHARS)
                continue;
            const fold = readFold(value);
            if (fold)
                folds.set(noteId, fold);
        }
        return folds;
    }
    catch {
        return null;
    }
}

export function outlineFoldFor(noteId: string, source = storage()): OutlineFold | null {
    if (!noteId)
        return null;
    return readFolds(source)?.get(noteId) ?? null;
}

/**
 * Records one note's fold, making it the most recent entry.
 *
 * Best-effort by design: a full or blocked storage costs the reader their fold on the next visit and
 * nothing else, so a failure here must not surface as a failed fold — the rail keeps the set in React
 * state either way, which is what makes the click answer immediately.
 */
export function saveOutlineFold(noteId: string, fold: OutlineFold, source = storage()): void {
    if (!noteId || !source)
        return;
    const folds = readFolds(source) ?? new Map<string, OutlineFold>();
    folds.delete(noteId);
    folds.set(noteId, { level: fold.level, slugs: readSlugs(fold.slugs) });
    while (folds.size > OUTLINE_FOLD_NOTES_MAX) {
        const oldest = folds.keys().next();
        if (oldest.done)
            break;
        folds.delete(oldest.value);
    }
    try {
        source.setItem(OUTLINE_FOLD_STORAGE_KEY, JSON.stringify(Object.fromEntries(folds)));
    }
    catch {
        // Swallowed on purpose: see the note above — the fold is already applied in memory.
    }
}

/** Drops every stored fold. For the surfaces that clear local state, and for tests. */
export function clearOutlineFolds(source = storage()): void {
    try {
        source?.removeItem(OUTLINE_FOLD_STORAGE_KEY);
    }
    catch {
        // Nothing to report: an unreadable store is already holding nothing this module can restore.
    }
}
