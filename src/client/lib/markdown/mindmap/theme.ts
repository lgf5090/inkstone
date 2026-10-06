/**
 * What a ```mindmap body may say about its own palette, and how that meets the
 * app's light/dark setting.
 *
 * Precedence: the body wins. A document that names a theme keeps it — the note is
 * the more specific statement, and the map was written that way on purpose — while
 * the app's appearance setting is what a body that names nothing draws with
 * (`"auto"`, or no `theme` field at all). Switching the app theme therefore
 * repaints the maps that follow it and leaves the pinned ones alone, and the same
 * rule holds everywhere a map is drawn: the preview, the full screen view, the
 * share page and every export all resolve one of these choices.
 *
 * The field is JSON-only, and that is why the fence's info string carries the same
 * statement for the formats that cannot hold it: ` ```mindmap theme=dark ` is read by
 * the same reader the JSON field goes through, so the two cannot drift apart.
 */

/**
 * The palette a block draws with: one of the app's two, or the body's own theme
 * object used as written (mind-elixir's own shape — `name`, `type`, `palette`,
 * `cssVar` — which is what the library's data files carry, so pasting one keeps
 * its palette). Leaving fields out is fine: the object is laid over the base its
 * `type` names, which is what keeps a theme without a `palette` from throwing.
 */
export type MindmapPalette =
    | { kind: 'light' }
    | { kind: 'dark' }
    | { kind: 'custom'; theme: unknown };

/** What a body asks for: its own palette, or `app` to follow the appearance setting. */
export type MindmapThemeChoice = { kind: 'app' } | MindmapPalette;

/** What a body draws with when it names no palette: the app's own setting. */
export const APP_THEME_CHOICE: MindmapThemeChoice = { kind: 'app' };

/** The name a note may use for the default, spelled out where a reader will look for it. */
const FOLLOW_APP_NAMES = ['auto', 'app'];

function themeFieldError(): string {
    return '"theme" must be "light", "dark", "auto" or a theme object';
}

/**
 * Reads the body's `theme` field. A name it does not know is reported rather than
 * ignored: the block shows its source and says what to write instead, which is
 * what an unrecognised value deserves — a map drawn in the wrong palette silently
 * would be worse than one that says why it did not draw.
 */
export function readThemeChoice(value: unknown): { choice: MindmapThemeChoice } | { error: string } {
    if (value === undefined || value === null)
        return { choice: APP_THEME_CHOICE };
    if (typeof value === 'string') {
        const name = value.trim().toLowerCase();
        if (name === 'light')
            return { choice: { kind: 'light' } };
        if (name === 'dark')
            return { choice: { kind: 'dark' } };
        if (FOLLOW_APP_NAMES.includes(name))
            return { choice: APP_THEME_CHOICE };
        return { error: themeFieldError() };
    }
    if (typeof value === 'object' && !Array.isArray(value))
        return { choice: { kind: 'custom', theme: value } };
    return { error: themeFieldError() };
}

/** The name the annotation goes by in a fence's info string, next to the language. */
export const THEME_ANNOTATION_KEY = 'theme';

/**
 * Where the renderer carries the annotation out of the fence and onto the block, for the
 * registry — the only layer that interprets it — to read back (see view.ts).
 */
export const MINDMAP_THEME_ATTR = 'data-mindmap-theme';

const ANNOTATION_RE = /(?:^|\s)theme=(?:"([^"]*)"|'([^']*)'|([^\s{}]+))/i;
/** The same shape, matching the whole annotation so it can be taken out of a line. */
const ANNOTATION_WHOLE_RE = /(?:^|\s)theme=(?:"[^"]*"|'[^']*'|[^\s{}]+)/gi;

/**
 * The raw `theme=` value a fence's info string carries, or null when it names none. The
 * value is handed on as written: it goes through `readThemeChoice` like the JSON body's
 * field, so what a note may write is in one place and an unknown name reports itself.
 */
export function readFenceAnnotation(info: string): string | null {
    const match = ANNOTATION_RE.exec(info);
    if (!match)
        return null;
    return (match[1] ?? match[2] ?? match[3] ?? '').slice(0, 64);
}

/**
 * The same info string with its `theme=` annotation set to `raw`, or removed when `raw`
 * is null. Everything else in the line is left untouched, so the language, a title and
 * any other metadata survive a palette change.
 */
export function withFenceAnnotation(info: string, raw: string | null): string {
    // The match swallows the space before the annotation, so taking it out leaves the
    // rest of the line's spacing alone.
    const without = info.replace(ANNOTATION_WHOLE_RE, '').trim();
    return raw === null ? without : `${without} ${THEME_ANNOTATION_KEY}=${raw}`.trim();
}

/**
 * The palette a fence asks for: the field in its own body when it names one, the
 * annotation beside it otherwise. `auto` counts as naming nothing, which is what makes
 * the annotation a fallback rather than a second opinion — and it is the only home the
 * outline format has.
 */
export function fenceThemeChoice(body: MindmapThemeChoice, annotation: string | null): { choice: MindmapThemeChoice } | { error: string } {
    if (body.kind !== 'app' || annotation === null)
        return { choice: body };
    return readThemeChoice(annotation);
}

/**
 * The palette to draw with: the body's own when it named one, the app's setting
 * otherwise. This is the whole rule, in one place — the vendor only maps the
 * result onto the library's theme objects.
 */
export function resolveThemeChoice(choice: MindmapThemeChoice, appDark: boolean): MindmapPalette {
    if (choice.kind === 'app')
        return { kind: appDark ? 'dark' : 'light' };
    return choice;
}
