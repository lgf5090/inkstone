import { EditorSelection, type StateCommand } from '@codemirror/state';
import { expandToWord, selectedLineBounds, toggleWrap } from './commands';

const HEX = '#[0-9a-fA-F]{3,8}';

/**
 * The two colour channels a note can carry. Each is one HTML tag pair, so the markup survives the
 * share page and any other markdown reader, and each is written per line rather than around a whole
 * multi-line selection: that is what stops a tag opening in one paragraph and closing in the next.
 */
export interface ColorFamily {
    wrap: (color: string, text: string) => string;
    scan: () => RegExp;
    /** How a normalised `#rrggbb` actually lands inside the tag, which is what a re-press is read back as. */
    inTag: (color: string) => string;
}

/**
 * A highlight is a wash, not a block: the alpha is what keeps the theme's own text colour readable on
 * top of it, which a solid background does not — a light pastel under light theme text is invisible.
 */
export const HIGHLIGHT_ALPHA = '59';

const FONT_SCAN = new RegExp(`<font\\s+color=["']?(${HEX})["']?>([\\s\\S]+?)</font>`, 'gi');
const MARK_SCAN = new RegExp(`<mark\\s+style=["']?background:\\s*(${HEX});?["']?>([\\s\\S]+?)</mark>`, 'gi');

export const FONT_COLOR: ColorFamily = {
    wrap: (color, text) => `<font color="${color}">${text}</font>`,
    // One shared global regex per family: `replace` and `matchAll` both start at zero, so building a
    // fresh one would cost a compile for every line the selection touches.
    scan: () => FONT_SCAN,
    inTag: color => color,
};

export const MARK_COLOR: ColorFamily = {
    wrap: (color, text) => `<mark style="background:${color}${HIGHLIGHT_ALPHA}">${text}</mark>`,
    scan: () => MARK_SCAN,
    inTag: color => `${color}${HIGHLIGHT_ALPHA}`,
};

/** `#abc`, `abc` and `#AABBCC` all resolve to the one lower-case six-digit form written to a note. */
export function normalizeHexColor(value: string): string | null {
    const match = /^#?([0-9a-fA-F]+)$/.exec(value.trim());
    const digits = match?.[1] ?? '';
    if (digits.length !== 3 && digits.length !== 4 && digits.length !== 6 && digits.length !== 8)
        return null;
    const expanded = digits.length === 3 || digits.length === 4
        ? digits.split('').map((digit) => digit + digit).join('')
        : digits;
    return `#${expanded.slice(0, 6).toLocaleLowerCase()}`;
}

/** The `- ` / `> ` / `## ` a line starts with: a wrapper has to sit behind it, not around it. */
const BLOCK_PREFIX = /^(?:[ \t]*(?:>[ \t]*)+|[ \t]*#{1,6}[ \t]+|[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|[ \t]*::[ \t]+)?/;

function lineParts(line: string): { head: string; core: string; tail: string } {
    const block = BLOCK_PREFIX.exec(line)?.[0] ?? '';
    const rest = line.slice(block.length);
    const lead = /^[ \t]*/.exec(rest)?.[0] ?? '';
    const body = rest.slice(lead.length);
    const trail = /[ \t]*$/.exec(body)?.[0] ?? '';
    return { head: block + lead, core: body.slice(0, body.length - trail.length), tail: trail };
}

const PROTECTED_SPANS = /(`+[\s\S]*?`+)|(\$\$[\s\S]+?\$\$)|(\$[^$\n]+\$)|(%%[\s\S]+?%%)|((?:https?|ftp):\/\/[^\s<>"'）。，、；：！？]+)|(!?\[\[[^[\]\n]*\]\])|(!?\[[^[\]\n]*\]\([^()\n]*\))/g;

/** A character rewriter must not re-case or re-width the markup itself. */
const HTML_TAG = /<\/?[A-Za-z][\w-]*(?:\s[^<>\n]*)?>/g;
const PROTECTED_AND_TAGS = new RegExp(`${PROTECTED_SPANS.source}|${HTML_TAG.source}`, 'g');

/**
 * Code, maths, comments, URLs and link targets, lifted out of a line so a transform cannot see them
 * and put back afterwards. They are taken out rather than skipped span by span because a wrapper can
 * sit *around* one — `**[site](https://ex.com)**` has to lose its asterisks on both sides at once.
 * `keepTags` adds the markup itself, which the case and width rewriters must not rewrite either.
 */
function maskProtected(text: string, keepTags: boolean): { masked: string; restore: (value: string) => string } {
    const sentinel = ['\u0000', '\u0001', '\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '\u0007'].find(control => !text.includes(control));
    const kept: string[] = [];
    if (!sentinel)
        return { masked: text, restore: value => value };
    const pattern = keepTags ? PROTECTED_AND_TAGS : PROTECTED_SPANS;
    const masked = text.replace(pattern, (match) => {
        kept.push(match);
        return `${sentinel}${kept.length - 1}${sentinel}`;
    });
    const back = new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g');
    return {
        masked,
        restore: value => value.replace(back, (whole, index: string) => kept[Number(index)] ?? whole),
    };
}

function mapProtected(core: string, transform: (text: string) => string, keepTags = false): string {
    const { masked, restore } = maskProtected(core, keepTags);
    return restore(transform(masked));
}

function stripColor(text: string, family: ColorFamily): string {
    let current = text;
    let previous: string;
    do {
        previous = current;
        current = current.replace(family.scan(), (_match, _color: string, inner: string) => inner);
    }
    while (current !== previous);
    return current;
}

function recolorLine(line: string, family: ColorFamily, color: string | null): string {
    const { head, core, tail } = lineParts(line);
    if (!core)
        return line;
    const bare = stripColor(core, family);
    if (color === null)
        return bare === core ? line : head + bare + tail;
    if (!bare.trim())
        return line;
    const tags = [...core.matchAll(family.scan())];
    const wanted = family.inTag(color);
    const already = tags.length === 1 && tags[0][1]!.toLocaleLowerCase() === wanted && tags[0][2] === bare;
    if (already)
        return head + bare + tail;
    return head + family.wrap(color, bare) + tail;
}

/**
 * One edit per line the selection touches, and the caret's own line when it touches none.
 */
function perLineCommand(build: (line: string) => string): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => {
            const line = state.doc.lineAt(range.head);
            const from = range.empty ? line.from : range.from;
            const to = range.empty ? line.to : range.to;
            const text = state.sliceDoc(from, to);
            const insert = build(text);
            if (insert === text)
                return { range: EditorSelection.range(range.anchor, range.head) };
            return { changes: { from, to, insert }, range: EditorSelection.range(from, from + insert.length) };
        });
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
        return true;
    };
}

export const toggleUnderline = toggleWrap('<u>', '</u>');
export const toggleSuperscript = toggleWrap('<sup>', '</sup>');
export const toggleSubscript = toggleWrap('<sub>', '</sub>');

function colorCommand(family: ColorFamily, color: string | null): StateCommand {
    return perLineCommand(text => text.split('\n').map(line => recolorLine(line, family, color)).join('\n'));
}

export function setFontColor(color: string | null): StateCommand {
    const hex = color === null ? null : normalizeHexColor(color);
    return color !== null && hex === null ? () => false : colorCommand(FONT_COLOR, hex);
}

export function setHighlightColor(color: string | null): StateCommand {
    const hex = color === null ? null : normalizeHexColor(color);
    return color !== null && hex === null ? () => false : colorCommand(MARK_COLOR, hex);
}

/** Pairs whose inside survives: the marker goes, the words stay. Each has exactly one capture. */
const CLEAR_PAIRS: RegExp[] = [
    /<font\s+color=["']?#[0-9a-fA-F]{3,8}["']?>([\s\S]+?)<\/font>/gi,
    /<mark\s+style=["']?background:\s*#[0-9a-fA-F]{3,8};?["']?>([\s\S]+?)<\/mark>/gi,
    /\*\*([\s\S]+?)\*\*/g,
    /~~([\s\S]+?)~~/g,
    /==([\s\S]+?)==/g,
    /\*([^*\n]+)\*/g,
];

/** Bare tags go on their own, so an unbalanced one left behind cannot strand its partner. */
const CLEAR_TAGS = /<\/?(?:u|b|i|em|strong|small|sup|sub|del|ins|s|mark|font|kbd|samp|var|abbr|cite)\b[^>]*>/gi;

function stripRuns(text: string): string {
    let current = text;
    for (let pass = 0; pass < 6; pass++) {
        const before = current;
        for (const rule of CLEAR_PAIRS)
            current = current.replace(rule, (_match, inner: string) => inner);
        current = current.replace(CLEAR_TAGS, '');
        if (current === before)
            break;
    }
    return current;
}

/**
 * Inline decoration only. Code spans, maths and `%%` comments keep their own markers: dropping the
 * backticks of `` `a*b` `` would hand the asterisks to the emphasis rules and change what the text
 * says, and a comment is content the author chose to hide.
 */
export const clearInlineFormatting: StateCommand = perLineCommand(text => text.split('\n').map(line => mapProtected(line, stripRuns)).join('\n'));

export type CaseMode = 'upper' | 'lower' | 'title' | 'sentence' | 'inverse';

function applyCase(mode: CaseMode, text: string): string {
    if (mode === 'upper')
        return text.toLocaleUpperCase();
    if (mode === 'lower')
        return text.toLocaleLowerCase();
    if (mode === 'inverse')
        return [...text].map(character => (character === character.toLocaleUpperCase() ? character.toLocaleLowerCase() : character.toLocaleUpperCase())).join('');
    if (mode === 'title')
        return text.replace(/\b\p{Ll}/gu, letter => letter.toLocaleUpperCase());
    return text.replace(/(^\s*|\n\s*|[.!?…]+["'”’)\]]?\s+)(\p{Ll})/gu, (_match, lead: string, letter: string) => `${lead}${letter.toLocaleUpperCase()}`);
}

export function convertCase(mode: CaseMode): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => {
            const { from, to } = range.empty ? expandToWord(state, range) : { from: range.from, to: range.to };
            const text = state.sliceDoc(from, to);
            const insert = text.split('\n').map(line => mapProtected(line, part => applyCase(mode, part), true)).join('\n');
            if (insert === text)
                return { range: EditorSelection.range(range.anchor, range.head) };
            return { changes: { from, to, insert }, range: EditorSelection.range(from, from + insert.length) };
        });
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
        return true;
    };
}

const HALF_TO_FULL: Record<string, string> = { ',': '，', '.': '。', ';': '；', ':': '：', '?': '？', '!': '！', '(': '（', ')': '）' };
const FULL_TO_HALF: Record<string, string> = { '。': '.', '、': ',', '〈': '<', '〉': '>', '【': '[', '】': ']', '「': '"', '」': '"', '『': "'", '』': "'", '…': '...' };

function convertWidthText(text: string, mode: 'full' | 'half'): string {
    if (mode === 'full')
        return [...text].map(character => HALF_TO_FULL[character] ?? character).join('');
    return [...text].map((character) => {
        const code = character.charCodeAt(0);
        if (code >= 0xff01 && code <= 0xff5e)
            return String.fromCharCode(code - 0xfee0);
        if (code === 0x3000)
            return ' ';
        return FULL_TO_HALF[character] ?? character;
    }).join('');
}

/**
 * Width, not typography: the reference plugin's converter also guesses the language from the
 * selection's CJK ratio and rewrites every full stop it finds, which turns an ordered list marker
 * into a sentence terminator. These two commands only swap a character for its counterpart at the
 * other width.
 */
export function convertWidth(mode: 'full' | 'half'): StateCommand {
    return perLineCommand((text) => {
        return text.split('\n').map((line) => {
            const { head, core, tail } = lineParts(line);
            return core ? head + mapProtected(core, part => convertWidthText(part, mode), true) + tail : line;
        }).join('\n');
    });
}

function linesCommand(build: (lines: string[]) => string[]): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => {
            const { startLine, endLine } = selectedLineBounds(state, range);
            const lines: string[] = [];
            for (let n = startLine; n <= endLine; n++)
                lines.push(state.doc.line(n).text);
            const insert = build(lines).join('\n');
            const from = state.doc.line(startLine).from;
            const to = state.doc.line(endLine).to;
            if (insert === state.sliceDoc(from, to))
                return { range: EditorSelection.range(range.anchor, range.head) };
            return { changes: { from, to, insert }, range: EditorSelection.cursor(from + insert.length) };
        });
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
        return true;
    };
}

export type LineTool = 'trim-end' | 'trim-lines' | 'compress-spaces' | 'join-lines' | 'remove-blank-lines' | 'blank-lines-between' | 'dedupe-lines';

export function lineTool(tool: LineTool): StateCommand {
    if (tool === 'trim-end')
        return linesCommand(lines => lines.map(line => line.replace(/[ \t]+$/, '')));
    if (tool === 'trim-lines')
        return linesCommand(lines => lines.map(line => line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')));
    if (tool === 'compress-spaces')
        return linesCommand(lines => lines.map((line) => {
            const { head, core, tail } = lineParts(line);
            return core ? head + mapProtected(core, part => part.replace(/ {2,}/g, ' ')) + tail : line;
        }));
    if (tool === 'join-lines')
        return linesCommand((lines) => {
            const kept = lines.filter(line => line.trim().length > 0).map(line => line.trim());
            return kept.length > 1 ? [kept.join(' ')] : lines;
        });
    if (tool === 'remove-blank-lines')
        return linesCommand((lines) => {
            const kept = lines.filter(line => line.trim().length > 0);
            return kept.length > 0 && kept.length < lines.length ? kept : lines;
        });
    if (tool === 'blank-lines-between')
        return linesCommand(lines => lines.flatMap((line, index) => (index === 0 || !line.trim() || !lines[index - 1]!.trim() ? [line] : ['', line])));
    return linesCommand((lines) => {
        const seen = new Set<string>();
        return lines.filter((line) => {
            if (seen.has(line.trim()))
                return false;
            seen.add(line.trim());
            return true;
        });
    });
}

const NUMBER_TOKEN = '{n}';

/** `template` fronts every line; `{n}` stands for the running number, which a blank line never spends. */
export function numberLines(template: string, start: number = 1): StateCommand {
    let index = start;
    return linesCommand((lines) => {
        index = start;
        return lines.map((line) => {
            const { head, core, tail } = lineParts(line);
            if (!core)
                return line;
            const number = String(index++);
            const prefix = template.includes(NUMBER_TOKEN) ? template.replaceAll(NUMBER_TOKEN, number) : `${template}${number}`;
            return `${head}${prefix}${core}${tail}`;
        });
    });
}

export function wrapLines(prefix: string, suffix: string): StateCommand {
    return linesCommand((lines) => {
        return lines.map((line) => {
            const { head, core, tail } = lineParts(line);
            return core ? `${head}${prefix}${core}${suffix}${tail}` : line;
        });
    });
}
