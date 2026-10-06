/**
 * The `style=` annotation a chart fence may carry: `style=json` for a body made of data (a chart.js
 * config), `style=table` for a chart table body.
 *
 * The body already says which of the two it is, so this is not how a format is *discovered* — it is how
 * the note states one, and stating one changes what the block says when the body is not readable. A
 * table whose `--- |` row has a typo in it is recognisable as a table but not parseable as one, and a
 * block that has to guess then answers a JSON question about a table. With the format stated the right
 * reader runs, and its message is the one about the row. A value that names neither is reported rather
 * than ignored, because `style=tabel` asks for something no block draws, and redrawing as though the
 * note said nothing would hide the typo.
 */
export type DeclaredStyle = 'json' | 'table';

/** What a block reads off its own mark: the format it states, and a value that states nothing legible. */
export interface StyleRead {
    style: DeclaredStyle | null
    invalid: string | null
}

/** A fence that states nothing, which is what a surface without a chart block's mark reports. */
export const NO_DECLARED_STYLE: StyleRead = { style: null, invalid: null };

const STYLE_KEY = 'style';
const STYLES: Record<string, DeclaredStyle> = { json: 'json', table: 'table' };
const INFO_TOKEN_RE = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;

/**
 * The info line cut into option tokens. A leading `{…}` brace group is one token even when it holds
 * spaces, because that is how the fork's own `{ts title="x"}` fences are written.
 */
function infoTokens(info: string): string[] {
    const trimmed = info.trim();
    const leading = /^(\{[^{}]*\})\s*/.exec(trimmed);
    if (!leading)
        return trimmed.match(INFO_TOKEN_RE) ?? [];
    return [leading[1]!, ...(trimmed.slice(leading[0].length).match(INFO_TOKEN_RE) ?? [])];
}

/** `key=value` split out of a token, with either side's surrounding quotes dropped. */
function infoOption(token: string): { key: string, value: string } | null {
    const clean = token.replace(/^["']|["']$/g, '').trim();
    const separator = clean.indexOf('=');
    if (separator === -1)
        return null;
    return {
        key: clean.slice(0, separator).toLowerCase().trim(),
        value: clean.slice(separator + 1).trim().replace(/^["']|["']$/g, ''),
    };
}

/** The `style=` value on a fence's info line, as written, or null when the fence states none. */
export function readFenceStyle(info: string): string | null {
    for (const token of infoTokens(info)) {
        const option = infoOption(token);
        if (option?.key === STYLE_KEY)
            return option.value.slice(0, 32);
    }
    return null;
}

/** The stated format checked against the two names a note may use; anything else is reported. */
export function parseStyleValue(raw: string | null): StyleRead {
    const value = raw?.trim();
    if (!value)
        return NO_DECLARED_STYLE;
    const style = STYLES[value.toLowerCase()];
    return style ? { style, invalid: null } : { style: null, invalid: value };
}

/**
 * The stated format in a form that can be compared between draws. Which reader runs is not written
 * anywhere in the body's text, so a note that only changed `style=` has to look changed here or the
 * block would keep the picture its old format drew.
 */
export function styleSignature(style: StyleRead): string {
    return style.invalid === null ? style.style ?? '' : `!${style.invalid}`;
}

/**
 * The same info line with its `style=` put at the end. Everything the line carries besides the
 * format — the language, a title — is left where it was.
 */
export function withFenceStyle(info: string, style: DeclaredStyle): string {
    const kept = infoTokens(info).filter((token) => infoOption(token)?.key !== STYLE_KEY);
    return [...kept, `${STYLE_KEY}=${style}`].join(' ');
}
