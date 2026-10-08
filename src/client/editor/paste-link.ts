import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { EditorSettings } from '@shared/types';
import { t } from '../lib/i18n';
import { isImageTarget, isWikiSafeTarget, wikiLink } from '../features/links/link-syntax';
import { noteById } from '../store/notes';
import { useSession } from '../store/session';
import { useUi } from '../store/ui';

/**
 * What a paste needs to decide, spelled without a document so every rule can be asked of a pair of
 * strings. `before` and `after` are the text on either side of the range *within its line*, which is what
 * lets a rule see the link the caret is standing in.
 */
export interface PasteLinkProbe {
    clipboard: string;
    selection: string;
    before: string;
    after: string;
    /** The note an address of this notebook names, or null when it names nothing the reader can reach. */
    noteTitleFor?: (url: string) => string | null;
}

/** Which part of the note the written text replaces. */
export type PasteLinkScope = 'selection' | 'word' | 'caret' | 'destination';

export interface PasteLinkPlan {
    insert: string;
    /** Offset within `insert` where the caret goes, or null to park after it. */
    cursor: number | null;
    scope: PasteLinkScope;
}

const WIKI_SHAPE_RE = /^(!?)\[\[([^[\]\n]{1,200})\]\]$/;
/**
 * The addresses a browser can follow. `data:` and `blob:` are deliberately absent: an address that
 * carries its own bytes is how a payload slips past a check that only reads the scheme.
 */
const FOLLOWABLE_PREFIXES = ['http://', 'https://', 'ftp://', 'ftps://', 'mailto:', 'tel:'];
const BARE_ADDRESS_RE = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*\.[a-z]{2,}(?::\d{2,5})?(?:[/?#]\S*)?$/i;

/**
 * Whether a piece of text is one address rather than a sentence holding one, so any internal space
 * disqualifies it. A scheme is checked against the six above and then handed to `new URL`; the
 * scheme-less form is only read as an address when the setting allows it, and then only as
 * `host.tld` with an optional port and path, so `1.2` and `e.g` stay plain words.
 */
export function isPastedAddress(value: string, editor: EditorSettings): boolean {
    if (!value || /\s/.test(value)) return false;
    if (WIKI_SHAPE_RE.test(value)) return true;
    const lower = value.toLowerCase();
    if (FOLLOWABLE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        try {
            new URL(value);
            return true;
        }
        catch {
            return false;
        }
    }
    return editor.pasteLinkBareAddress && BARE_ADDRESS_RE.test(value);
}

/** A file manager hands over a quoted path; the quotes are not part of the name. */
export function stripSurroundingQuotes(value: string): string {
    if (value.length < 2) return value;
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) return value.slice(1, -1);
    return value;
}

/**
 * The destination a range is standing inside, as offsets into `lineText`, or null. Every `](` behind the
 * range is tried, nearest first, because a destination can itself hold a closing parenthesis: a Wikipedia
 * address like `https://x.dev/a(b)/c` keeps its own `)`, and giving up at the first one found is what
 * made a paste there glue two addresses together instead of swapping one out.
 */
export function destinationSpanAt(lineText: string, from: number, to: number): { from: number, to: number } | null {
    for (const open of destinationOpeners(lineText, from)) {
        const span = closedDestinationAt(lineText, open);
        if (span && span.from <= from && span.to >= to) return { from: span.from, to: span.to };
    }
    return null;
}

/** How far back a destination is worth looking for, and how many candidates are worth checking. */
const DESTINATION_LOOKBACK = 4000;
const DESTINATION_CANDIDATES = 12;

function destinationOpeners(lineText: string, from: number): number[] {
    const found: number[] = [];
    for (let index = from; index > Math.max(0, from - DESTINATION_LOOKBACK) && found.length < DESTINATION_CANDIDATES; index--) {
        if (lineText.charAt(index - 1) === '(' && lineText.charAt(index - 2) === ']') found.push(index - 1);
    }
    return found;
}

function closedDestinationAt(lineText: string, open: number): { from: number, to: number } | null {
    if (lineText.charAt(open + 1) === '<') {
        const wrapped = lineText.indexOf('>', open + 2);
        if (wrapped > 0 && lineText.charAt(wrapped + 1) === ')') return { from: open + 2, to: wrapped };
    }
    let depth = 0;
    for (let index = open; index < Math.min(lineText.length, open + DESTINATION_LOOKBACK); index++) {
        const character = lineText.charAt(index);
        if (character === '(') depth++;
        else if (character === ')') {
            depth--;
            if (depth === 0) return { from: open + 1, to: index };
        }
    }
    return null;
}

/**
 * The text a caret stands on, as a span of `lineText`. A run without spaces is taken whole, because an
 * address is one run full of characters a word rule would cut through; anything else falls back to the
 * word itself, so a caret in `hello world` never swallows `world`.
 */
export function runAtCaret(lineText: string, offset: number, editor: EditorSettings): { from: number, to: number, text: string } {
    const before = lineText.slice(0, offset);
    const after = lineText.slice(offset);
    const leftRun = /[^\s]*$/.exec(before)?.[0] ?? '';
    const rightRun = /^[^\s]*/.exec(after)?.[0] ?? '';
    const address = `${leftRun}${rightRun}`;
    if (address && isPastedAddress(address, editor)) {
        return { from: offset - leftRun.length, to: offset + rightRun.length, text: address };
    }
    const head = /[\p{L}\p{N}_]*$/u.exec(before)?.[0] ?? '';
    const tail = /^[\p{L}\p{N}_]*/u.exec(after)?.[0] ?? '';
    return { from: offset - head.length, to: offset + tail.length, text: `${head}${tail}` };
}

function isWholeLink(text: string): boolean {
    return WIKI_SHAPE_RE.test(text) || /^!?\[[^[\]]*\]\([^()]*\)$/.test(text);
}

/**
 * The shape the note is written in: a wiki link for anything the notebook itself holds, markdown for an
 * address. A note title carrying brackets cannot live in a wiki link, so it keeps the markdown shape and
 * the address it came from, rather than writing a link that resolves to nothing.
 */
function buildLink(url: string, label: string, editor: EditorSettings, internal: string | null): { insert: string, cursor: number | null } {
    const clipboardWiki = WIKI_SHAPE_RE.exec(url);
    if (internal && isWikiSafeTarget(internal)) {
        return { insert: wikiLink(internal, label.trim()), cursor: null };
    }
    if (clipboardWiki) {
        const target = (clipboardWiki[2] ?? '').split('|')[0]!.trim();
        if (isWikiSafeTarget(target)) {
            const alias = label.trim() || aliasOf(clipboardWiki[2] ?? '');
            return { insert: wikiLink(target, alias, clipboardWiki[1] === '!'), cursor: null };
        }
    }
    const image = editor.pasteLinkImageEmbed && isImageTarget(url);
    if (!label && !internal && editor.pasteLinkNothing === 'bare') {
        return { insert: `<${formatDestination(url)}>`, cursor: null };
    }
    const insert = markdownLink(label, url, image);
    return { insert, cursor: label ? null : insert.indexOf('[') + 1 };
}

function aliasOf(inner: string): string {
    const pipe = inner.indexOf('|');
    return pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
}

/**
 * With the rules switched off the paste still has to be answered, because the markdown language wraps a
 * selected run around a pasted address on its own: writing the clipboard back as plain text is what
 * turning the switch off promises, and declining would let that wrap happen anyway.
 */
function plainPasteWhenOff(probe: PasteLinkProbe, editor: EditorSettings): PasteLinkPlan | null {
    const clipboard = probe.clipboard.trim();
    if (!probe.selection || !isPastedAddress(clipboard, editor)) return null;
    return { insert: clipboard, cursor: null, scope: 'selection' };
}

/**
 * The one decision table. A caret inside a link's destination is asked first, because wrapping there
 * would nest a link inside a link and inserting bare text would glue two addresses together; then the
 * two directions of the swap; then what to do when nothing was selected at all.
 */
export function resolvePasteLink(probe: PasteLinkProbe, editor: EditorSettings): PasteLinkPlan | null {
    if (!editor.pasteLink) return plainPasteWhenOff(probe, editor);
    const clipboard = stripSurroundingQuotes(probe.clipboard.trim());
    if (!clipboard) return null;
    const selected = probe.selection.trim();
    const line = `${probe.before}${probe.selection}${probe.after}`;
    const start = probe.before.length;
    const end = start + probe.selection.length;
    const clipboardIsAddress = isPastedAddress(clipboard, editor);

    if (editor.pasteLinkRetarget && !/[\r\n]/.test(probe.selection)
        && clipboardIsAddress && destinationSpanAt(line, start, end)) {
        return { insert: formatDestination(clipboard), cursor: null, scope: 'destination' };
    }

    let url = clipboard;
    let label = probe.selection;
    let scope: PasteLinkScope = probe.selection ? 'selection' : 'caret';
    if (!clipboardIsAddress) {
        if (!editor.pasteLinkReverse || !isPastedAddress(selected, editor)) return null;
        url = selected;
        label = probe.clipboard.trim();
    }

    if (!probe.selection) {
        if (editor.pasteLinkNothing === 'plain') return null;
        if (editor.pasteLinkNothing === 'word') {
            const run = runAtCaret(line, start, editor);
            if (!run.text || isWholeLink(run.text)) return null;
            label = run.text;
            scope = 'word';
        }
    }

    const internal = editor.pasteLinkInternalNote && probe.noteTitleFor && /^https?:\/\//i.test(url)
        ? probe.noteTitleFor(url)
        : null;
    return { ...buildLink(url, label, editor, internal), scope };
}

/** The note id a copied direct link of this deployment points at, or null for any other address. */
export function ownNoteIdOf(url: string, origin: string): string | null {
    if (!/^https?:\/\//i.test(url)) return null;
    try {
        const parsed = new URL(url);
        if (parsed.origin !== origin) return null;
        const match = /^\/n\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(parsed.pathname);
        return match ? match[1]! : null;
    }
    catch {
        return null;
    }
}

function ownNoteTitle(url: string): string | null {
    const id = ownNoteIdOf(url, window.location.origin);
    if (!id) return null;
    const note = noteById(id);
    return note && !note.deletedAt ? note.title : null;
}

/** The text a destination may hold: control characters and angle brackets encoded, parentheses kept
 * inside an angle wrap, which is what lets `https://x.dev/a(b)` survive as one destination. */
export function formatDestination(url: string): string {
    const encoded = url.replace(/[\u0000-\u0020<>]/g, (value) => encodeURIComponent(value));
    return /[()]/.test(encoded) ? `<${encoded}>` : encoded;
}

export function markdownLink(label: string, url: string, image = false): string {
    return `${image ? '!' : ''}[${escapeMarkdownLabel(label)}](${formatDestination(url)})`;
}

export function escapeMarkdownLabel(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&');
}

/**
 * Where the plan's text goes. A word or a destination is re-measured against the real line, so the range
 * the label was taken from and the range that is replaced cannot drift apart.
 */
function targetRange(view: EditorView, plan: PasteLinkPlan, editor: EditorSettings): { from: number, to: number } {
    const range = view.state.selection.main;
    if (plan.scope === 'destination') {
        const line = view.state.doc.lineAt(range.from);
        if (line.to !== view.state.doc.lineAt(range.to).to) return { from: range.from, to: range.to };
        const span = destinationSpanAt(line.text, range.from - line.from, range.to - line.from);
        return span ? { from: line.from + span.from, to: line.from + span.to } : { from: range.from, to: range.to };
    }
    if (plan.scope === 'word') {
        const line = view.state.doc.lineAt(range.head);
        const run = runAtCaret(line.text, range.head - line.from, editor);
        return { from: line.from + run.from, to: line.from + run.to };
    }
    return { from: range.from, to: range.to };
}

/**
 * One paste, one decision. Returns false when the paste should go the way it always did, which is every
 * case the table above refuses rather than guessing about.
 */
export function applyPasteLink(view: EditorView, clipboard: string): boolean {
    const editor = useSession.getState().settings.editor;
    const range = view.state.selection.main;
    const fromLine = view.state.doc.lineAt(range.from);
    const toLine = view.state.doc.lineAt(range.to);
    const plan = resolvePasteLink({
        clipboard,
        selection: view.state.sliceDoc(range.from, range.to),
        before: fromLine.text.slice(0, range.from - fromLine.from),
        after: toLine.text.slice(range.to - toLine.from),
        noteTitleFor: ownNoteTitle,
    }, editor);
    if (!plan) return false;
    const target = targetRange(view, plan, editor);
    const caret = target.from + (plan.cursor ?? plan.insert.length);
    view.dispatch({
        changes: { from: target.from, to: target.to, insert: plan.insert },
        selection: EditorSelection.cursor(Math.min(caret, target.from + plan.insert.length)),
        scrollIntoView: true,
        userEvent: 'input.paste',
    });
    return true;
}

/**
 * The keyboard route, for an author who copied an address and wants it wrapped now rather than at the
 * moment they press paste. The keystroke is always consumed: a clipboard that holds no address falls
 * back to a plain paste, so the key never types nothing.
 */
export function pasteAsLinkFromClipboard(view: EditorView): boolean {
    const clipboard = navigator.clipboard;
    if (!clipboard?.readText) {
        useUi.getState().toast({ title: t('editor.clipboard_read_failed'), tone: 'danger' });
        return true;
    }
    void clipboard.readText()
        .then((text) => {
            if (applyPasteLink(view, text)) return;
            const range = view.state.selection.main;
            view.dispatch({
                changes: { from: range.from, to: range.to, insert: text },
                selection: EditorSelection.cursor(range.from + text.length),
                scrollIntoView: true,
                userEvent: 'input.paste',
            });
        })
        .catch(() => {
            useUi.getState().toast({ title: t('editor.clipboard_read_failed'), tone: 'danger' });
        });
    return true;
};
