import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants';
import type { EditorSettings, NoteSummary } from '@shared/types';
import type { PasteLinkProbe } from './paste-link';
import { useNotes } from '../store/notes';
import { useSession } from '../store/session';
import { pasteEventHandlers } from './paste';
import { useUi } from '../store/ui';
import {
    applyPasteLink,
    destinationSpanAt,
    formatDestination,
    isPastedAddress,
    ownNoteIdOf,
    pasteAsLinkFromClipboard,
    resolvePasteLink,
    runAtCaret,
    stripSurroundingQuotes,
} from './paste-link';

const LABEL = '\u9009\u4e2d';
const DEEP = '\u6df1\u5ea6\u7814\u7a76';
const PIC = '\u56fe';
const NOTE = '\u7b14\u8bb0';

function settings(patch: Partial<EditorSettings> = {}): EditorSettings {
    return { ...DEFAULT_SETTINGS.editor, ...patch };
}

function probe(patch: Partial<PasteLinkProbe> = {}): PasteLinkProbe {
    return { clipboard: '', selection: '', before: '', after: '', ...patch };
}

function setEditor(patch: Record<string, unknown>): void {
    useSession.setState({ settings: mergeSettings({ editor: patch }) });
}

describe('isPastedAddress', () => {
    const on = settings();
    const off = settings({ pasteLinkBareAddress: false });

    it('reads a scheme the browser can follow', () => {
        for (const value of ['https://example.com/a', 'http://x.cn', 'ftp://host/f', 'mailto:a@b.cn', 'tel:+15551234', 'HTTPS://X.COM'])
            expect(isPastedAddress(value, on), value).toBe(true);
    });

    it('refuses the schemes that carry their own bytes', () => {
        for (const value of ['javascript:alert(1)', 'data:text/html;base64,PHgxPg==', 'blob:https://x/y', 'vbscript:x', 'file:///etc/passwd'])
            expect(isPastedAddress(value, on), value).toBe(false);
    });

    it('refuses a scheme it cannot parse, and text that is not one address', () => {
        for (const value of ['http://', 'https://', 'localhost:3000', '1.2', 'e.g', 'hello world', 'https://a.cn/x y', '', 'Note'])
            expect(isPastedAddress(value, on), value).toBe(false);
    });

    it('reads a host without a scheme only while the setting allows it', () => {
        expect(isPastedAddress('example.com/a', on)).toBe(true);
        expect(isPastedAddress('example.com/a', off)).toBe(false);
        expect(isPastedAddress('sub.domain.io:8443/p?q=1', on)).toBe(true);
        for (const value of ['example.c', 'a.b.c.', 'see.', '\u770b note.md'])
            expect(isPastedAddress(value, on), value).toBe(false);
        expect(isPastedAddress('note.md', on)).toBe(true);
    });

    it('counts a wiki link as an address to place', () => {
        expect(isPastedAddress(`[[${DEEP}]]`, on)).toBe(true);
        expect(isPastedAddress(`![[${NOTE}]]`, on)).toBe(true);
    });
});

describe('stripSurroundingQuotes', () => {
    it('takes matching quotes off and leaves the rest alone', () => {
        expect(stripSurroundingQuotes('"a b"')).toBe('a b');
        expect(stripSurroundingQuotes("'x'")).toBe('x');
        expect(stripSurroundingQuotes('"a b\'')).toBe('"a b\'');
        expect(stripSurroundingQuotes('"')).toBe('"');
        expect(stripSurroundingQuotes('a"b')).toBe('a"b');
    });
});

describe('destinationSpanAt', () => {
    it('reports the destination the range stands in', () => {
        expect(destinationSpanAt('[a](bc)', 5, 5)).toEqual({ from: 4, to: 6 });
        expect(destinationSpanAt('[a](b) and [c](d)', 15, 15)).toEqual({ from: 15, to: 16 });
    });

    it('reports the inside of an angle-wrapped destination', () => {
        expect(destinationSpanAt('[a](<b c>)', 6, 6)).toEqual({ from: 5, to: 8 });
    });

    it('keeps a destination holding its own parentheses', () => {
        expect(destinationSpanAt('[a](b(c))', 6, 6)).toEqual({ from: 4, to: 8 });
    });

    it('does not give up at a parenthesis the address itself carries', () => {
        expect(destinationSpanAt('[a](https://x.dev/a(b)/c)', 23, 23)).toEqual({ from: 4, to: 24 });
    });

    it('reads an angle-wrapped destination past the parentheses inside it', () => {
        expect(destinationSpanAt('[a](<p(b)c>)', 9, 9)).toEqual({ from: 5, to: 10 });
    });

    it('is not fooled by a parenthesis that is not a destination', () => {
        const cases: [string, number][] = [['a(b)c', 2], ['[a](b)', 2], ['[a](b)', 6], ['[a](b', 5], ['[a(b)c', 3]];
        for (const [line, at] of cases)
            expect(destinationSpanAt(line, at, at), `${line} @${at}`).toBeNull();
    });

    it('refuses a range that reaches past the closing parenthesis', () => {
        expect(destinationSpanAt('[a](b) tail', 4, 8)).toBeNull();
    });
});

describe('runAtCaret', () => {
    const line = '\u770b https://a.cn/x \u91cc';

    it('takes a whole address, punctuation included', () => {
        expect(runAtCaret(line, line.indexOf('//') + 3, settings())).toEqual({ from: 2, to: 16, text: 'https://a.cn/x' });
    });

    it('takes only the word when the run is not an address', () => {
        expect(runAtCaret('hello world', 3, settings())).toEqual({ from: 0, to: 5, text: 'hello' });
    });

    it('reads a Han run as one word', () => {
        expect(runAtCaret(`${DEEP}${NOTE}`, DEEP.length, settings({ pasteLinkBareAddress: false })))
            .toEqual({ from: 0, to: 6, text: `${DEEP}${NOTE}` });
    });

    it('returns nothing on a space', () => {
        expect(runAtCaret(' () ', 2, settings())).toEqual({ from: 2, to: 2, text: '' });
    });
});

describe('formatDestination', () => {
    it('wraps only what cannot sit bare inside parentheses', () => {
        expect(formatDestination('https://a.cn/x')).toBe('https://a.cn/x');
        expect(formatDestination('https://a.cn/a(b)')).toBe('<https://a.cn/a(b)>');
        expect(formatDestination('https://a.cn/a b')).toBe('https://a.cn/a%20b');
        expect(formatDestination('https://a.cn/a<b>c')).toBe('https://a.cn/a%3Cb%3Ec');
    });
});

describe('resolvePasteLink', () => {
    it('wraps the selected words with the pasted address', () => {
        const plan = resolvePasteLink(probe({ clipboard: 'https://a.cn/x', selection: LABEL }), settings());
        expect(plan).toEqual({ insert: `[${LABEL}](https://a.cn/x)`, cursor: null, scope: 'selection' });
    });

    it('pastes the address as plain text while the master switch is off', () => {
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/x', selection: LABEL }), settings({ pasteLink: false })))
            .toEqual({ insert: 'https://a.cn/x', cursor: null, scope: 'selection' });
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/x' }), settings({ pasteLink: false }))).toBeNull();
        expect(resolvePasteLink(probe({ clipboard: 'not an address', selection: LABEL }), settings({ pasteLink: false }))).toBeNull();
    });

    it('takes the clipboard as the words when the selection is the address', () => {
        const plan = resolvePasteLink(probe({ clipboard: NOTE, selection: 'https://a.cn/x' }), settings());
        expect(plan?.insert).toBe(`[${NOTE}](https://a.cn/x)`);
        expect(plan?.scope).toBe('selection');
    });

    it('leaves the reverse swap to its own switch', () => {
        expect(resolvePasteLink(probe({ clipboard: NOTE, selection: 'https://a.cn/x' }), settings({ pasteLinkReverse: false }))).toBeNull();
    });

    it('keeps the clipboard as the destination when both sides are addresses', () => {
        const plan = resolvePasteLink(probe({ clipboard: 'https://new.cn/a', selection: 'https://old.cn/b' }), settings());
        expect(plan?.insert).toBe('[https://old.cn/b](https://new.cn/a)');
    });

    it('embeds an address that names a picture, and only while the switch is on', () => {
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/pic.png', selection: LABEL }), settings())?.insert)
            .toBe(`![${LABEL}](https://a.cn/pic.png)`);
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/pic.png', selection: LABEL }), settings({ pasteLinkImageEmbed: false }))?.insert)
            .toBe(`[${LABEL}](https://a.cn/pic.png)`);
    });

    it('reads the picture from the address, whichever side it came from', () => {
        const plan = resolvePasteLink(probe({ clipboard: PIC, selection: 'https://a.cn/pic.png' }), settings());
        expect(plan?.insert).toBe(`![${PIC}](https://a.cn/pic.png)`);
    });

    it('escapes the words it puts inside brackets', () => {
        const plan = resolvePasteLink(probe({ clipboard: 'https://a.cn/x', selection: 'a[b]c\\d' }), settings());
        expect(plan?.insert).toBe('[a\\[b\\]c\\\\d](https://a.cn/x)');
    });

    it('keeps a multi-line selection on one line', () => {
        const plan = resolvePasteLink(probe({ clipboard: 'https://a.cn/x', selection: '\u4e00\n\u4e8c' }), settings());
        expect(plan?.insert).toBe('[\u4e00 \u4e8c](https://a.cn/x)');
    });

    it('pastes as it always did when nothing is selected and the mode is plain', () => {
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/x' }), settings())).toBeNull();
    });

    it('writes an empty link with the caret waiting inside the brackets', () => {
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/x' }), settings({ pasteLinkNothing: 'inline' })))
            .toEqual({ insert: '[](https://a.cn/x)', cursor: 1, scope: 'caret' });
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/x.png' }), settings({ pasteLinkNothing: 'inline' })))
            .toEqual({ insert: '![](https://a.cn/x.png)', cursor: 2, scope: 'caret' });
    });

    it('writes a bare autolink when that is the mode', () => {
        expect(resolvePasteLink(probe({ clipboard: 'https://a.cn/x' }), settings({ pasteLinkNothing: 'bare' })))
            .toEqual({ insert: '<https://a.cn/x>', cursor: null, scope: 'caret' });
    });

    it('links the run the caret stands on when asked to', () => {
        const line = '\u770b https://a.cn/x \u91cc';
        const at = line.indexOf('//') + 3;
        const plan = resolvePasteLink(probe({
            clipboard: 'https://new.cn/y',
            before: line.slice(0, at),
            after: line.slice(at),
        }), settings({ pasteLinkNothing: 'word' }));
        expect(plan).toEqual({ insert: '[https://a.cn/x](https://new.cn/y)', cursor: null, scope: 'word' });
    });

    it('refuses to wrap a run that is already a link', () => {
        const line = `[[${DEEP}]]`;
        const at = DEEP.length;
        const plan = resolvePasteLink(probe({
            clipboard: 'https://new.cn/y',
            before: line.slice(0, at),
            after: line.slice(at),
        }), settings({ pasteLinkNothing: 'word' }));
        expect(plan).toBeNull();
    });

    it('replaces the destination the caret stands in instead of nesting', () => {
        const line = `[${LABEL}](https://a.cn/x)`;
        const at = LABEL.length + 5;
        const plan = resolvePasteLink(probe({
            clipboard: 'https://new.cn/y',
            before: line.slice(0, at),
            after: line.slice(at),
        }), settings());
        expect(plan).toEqual({ insert: 'https://new.cn/y', cursor: null, scope: 'destination' });
    });

    it('retargets a link whose own address carries parentheses', () => {
        const line = `[${LABEL}](https://x.dev/a(b)/c)`;
        const at = line.length - 2;
        const plan = resolvePasteLink(probe({
            clipboard: 'https://new.cn/y',
            before: line.slice(0, at),
            after: line.slice(at),
        }), settings());
        expect(plan).toEqual({ insert: 'https://new.cn/y', cursor: null, scope: 'destination' });
    });

    it('leaves a destination alone when the retarget switch is off', () => {
        const line = `[${LABEL}](https://a.cn/x)`;
        const at = LABEL.length + 5;
        const plan = resolvePasteLink(probe({
            clipboard: 'https://new.cn/y',
            before: line.slice(0, at),
            after: line.slice(at),
        }), settings({ pasteLinkRetarget: false, pasteLinkNothing: 'inline' }));
        expect(plan).toEqual({ insert: '[](https://new.cn/y)', cursor: 1, scope: 'caret' });
    });

    it('writes a link to a note of this notebook as a wiki link', () => {
        const url = 'https://app.inkstone.dev/n/abc123';
        const plan = resolvePasteLink(probe({ clipboard: url, selection: LABEL, noteTitleFor: () => DEEP }), settings());
        expect(plan?.insert).toBe(`[[${DEEP}|${LABEL}]]`);
    });

    it('drops the alias when the words already are the note', () => {
        const plan = resolvePasteLink(probe({
            clipboard: 'https://app.inkstone.dev/n/abc123',
            selection: DEEP,
            noteTitleFor: () => DEEP,
        }), settings());
        expect(plan?.insert).toBe(`[[${DEEP}]]`);
    });

    it('keeps the address when the note title cannot live in a wiki link', () => {
        const url = 'https://app.inkstone.dev/n/abc123';
        const plan = resolvePasteLink(probe({ clipboard: url, selection: LABEL, noteTitleFor: () => 'a[b' }), settings());
        expect(plan?.insert).toBe(`[${LABEL}](${url})`);
    });

    it('leaves a note address as an address when the switch is off', () => {
        const url = 'https://app.inkstone.dev/n/abc123';
        const plan = resolvePasteLink(probe({ clipboard: url, selection: LABEL, noteTitleFor: () => DEEP }), settings({ pasteLinkInternalNote: false }));
        expect(plan?.insert).toBe(`[${LABEL}](${url})`);
    });

    it('carries the alias of a wiki link copied from elsewhere', () => {
        expect(resolvePasteLink(probe({ clipboard: `[[${DEEP}]]`, selection: LABEL }), settings())?.insert)
            .toBe(`[[${DEEP}|${LABEL}]]`);
        expect(resolvePasteLink(probe({ clipboard: `![[${DEEP}]]`, selection: LABEL }), settings())?.insert)
            .toBe(`![[${DEEP}|${LABEL}]]`);
        expect(resolvePasteLink(probe({ clipboard: `[[${DEEP}|${NOTE}]]` }), settings({ pasteLinkNothing: 'inline' }))?.insert)
            .toBe(`[[${DEEP}|${NOTE}]]`);
    });

    it('takes a quoted address off its quotes', () => {
        const plan = resolvePasteLink(probe({ clipboard: '"https://a.cn/x" ', selection: LABEL }), settings());
        expect(plan?.insert).toBe(`[${LABEL}](https://a.cn/x)`);
    });

    it('leaves an empty clipboard to the plain paste', () => {
        expect(resolvePasteLink(probe({ clipboard: '   ', selection: LABEL }), settings())).toBeNull();
    });
});

describe('ownNoteIdOf', () => {
    const origin = 'https://app.inkstone.dev';

    it('reads the id out of this deployment\'s own direct link', () => {
        expect(ownNoteIdOf(`${origin}/n/abc123`, origin)).toBe('abc123');
        expect(ownNoteIdOf(`${origin}/n/abc123?x=1`, origin)).toBe('abc123');
    });

    it('is silent about every other address', () => {
        expect(ownNoteIdOf('https://elsewhere.dev/n/abc123', origin)).toBeNull();
        expect(ownNoteIdOf(`${origin}/s/abc123`, origin)).toBeNull();
        expect(ownNoteIdOf(`${origin}/notes/abc123`, origin)).toBeNull();
        expect(ownNoteIdOf(`${origin}/n/`, origin)).toBeNull();
        expect(ownNoteIdOf('https://a.cn/n/x(y', origin)).toBeNull();
    });
});

describe('applyPasteLink', () => {
    function viewWith(doc: string, from: number, to = from): EditorView {
        return new EditorView({ state: EditorState.create({ doc, selection: { anchor: from, head: to } }) });
    }

    beforeEach(() => {
        setEditor({});
    });

    it('wraps the selection and reports that it handled the paste', () => {
        const view = viewWith(`\u5199${LABEL}\u5728\u8fd9\u91cc`, 1, 1 + LABEL.length);
        expect(applyPasteLink(view, 'https://a.cn/x')).toBe(true);
        expect(view.state.doc.toString()).toBe(`\u5199[${LABEL}](https://a.cn/x)\u5728\u8fd9\u91cc`);
        view.destroy();
    });

    it('replaces the whole destination, not the characters under the caret', () => {
        setEditor({ pasteLinkNothing: 'word' });
        const view = viewWith(`[${LABEL}](https://a.cn/x)`, LABEL.length + 5);
        expect(applyPasteLink(view, 'https://new.cn/y')).toBe(true);
        expect(view.state.doc.toString()).toBe(`[${LABEL}](https://new.cn/y)`);
        view.destroy();
    });

    it('replaces exactly the run the word mode measured', () => {
        setEditor({ pasteLinkNothing: 'word' });
        const doc = '\u770b https://a.cn/x \u91cc';
        const view = viewWith(doc, doc.indexOf('//') + 3);
        expect(applyPasteLink(view, 'https://new.cn/y')).toBe(true);
        expect(view.state.doc.toString()).toBe('\u770b [https://a.cn/x](https://new.cn/y) \u91cc');
        view.destroy();
    });

    it('leaves the note untouched and declines the paste when the rules do not apply', () => {
        const view = viewWith('nothing selected', 7);
        expect(applyPasteLink(view, 'just words')).toBe(false);
        expect(view.state.doc.toString()).toBe('nothing selected');
        view.destroy();
    });

    it('writes a backlink for a direct link copied from this notebook', () => {
        setEditor({ pasteLinkNothing: 'inline' });
        useNotes.setState({ notes: { abc123: { id: 'abc123', title: DEEP, deletedAt: null } as NoteSummary } });
        const view = viewWith('\u672b\u5c3e', 2);
        expect(applyPasteLink(view, `${window.location.origin}/n/abc123`)).toBe(true);
        expect(view.state.doc.toString()).toBe(`\u672b\u5c3e[[${DEEP}]]`);
        view.destroy();
    });

    it('leaves a deleted note as the address it was copied as', () => {
        setEditor({ pasteLinkNothing: 'bare' });
        useNotes.setState({ notes: { gone456: { id: 'gone456', title: DEEP, deletedAt: 1 } as NoteSummary } });
        const view = viewWith('\u672b\u5c3e', 2);
        expect(applyPasteLink(view, `${window.location.origin}/n/gone456`)).toBe(true);
        expect(view.state.doc.toString()).toBe(`\u672b\u5c3e<${window.location.origin}/n/gone456>`);
        view.destroy();
    });
});

describe('pasteAsLinkFromClipboard', () => {
    async function runWith(doc: string, clip: string, from: number, to = from): Promise<string> {
        const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: from, head: to } }) });
        Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => clip }, configurable: true });
        pasteAsLinkFromClipboard(view);
        await Promise.resolve();
        await Promise.resolve();
        const text = view.state.doc.toString();
        view.destroy();
        return text;
    }

    beforeEach(() => {
        setEditor({});
    });

    it('wraps the selection with an address off the clipboard', async () => {
        expect(await runWith(`\u5199${LABEL}\u5728\u8fd9\u91cc`, 'https://a.cn/x', 1, 1 + LABEL.length))
            .toBe(`\u5199[${LABEL}](https://a.cn/x)\u5728\u8fd9\u91cc`);
    });

    it('pastes the text as it is when the clipboard holds no address', async () => {
        expect(await runWith('\u672b\u5c3e', '\u4e00\u6bb5\u6587\u5b57', 2)).toBe('\u672b\u5c3e\u4e00\u6bb5\u6587\u5b57');
    });

    it('says so when the clipboard cannot be read', async () => {
        const toast = vi.fn();
        useSession.setState({ settings: mergeSettings({}) });
        const view = new EditorView({ state: EditorState.create({ doc: '\u672b\u5c3e', selection: { anchor: 2, head: 2 } }) });
        Object.defineProperty(navigator, 'clipboard', { value: { readText: () => Promise.reject(new Error('denied')) }, configurable: true });
        useUi.setState({ toast });
        pasteAsLinkFromClipboard(view);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(toast).toHaveBeenCalledTimes(1);
        expect(view.state.doc.toString()).toBe('\u672b\u5c3e');
        view.destroy();
    });
});

describe('pasteExtension', () => {
    function withPaste(doc: string, clip: string, from: number, to = from): { text: string, prevented: boolean, handled: boolean } {
        const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: from, head: to } }) });
        const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
        Object.defineProperty(event, 'clipboardData', {
            value: { files: [], types: ['text/plain'], getData: (kind: string) => (kind === 'text/plain' ? clip : '') },
        });
        const handled = pasteEventHandlers({ uploadFile: async () => null }).paste!.call(view, event, view);
        const result = { text: view.state.doc.toString(), prevented: event.defaultPrevented, handled: handled === true };
        view.destroy();
        return result;
    }

    beforeEach(() => {
        setEditor({});
    });

    it('turns the paste of an address over a selection into a link', () => {
        const doc = `\u5199${LABEL}\u5728\u8fd9\u91cc`;
        const { text, prevented, handled } = withPaste(doc, 'https://a.cn/x', 1, 1 + LABEL.length);
        expect([handled, prevented]).toEqual([true, true]);
        expect(text).toBe(`\u5199[${LABEL}](https://a.cn/x)\u5728\u8fd9\u91cc`);
    });

    it('leaves an ordinary paste to the editor', () => {
        const { text, prevented, handled } = withPaste('\u672b\u5c3e', '\u666e\u901a\u53e5\u5b50', 2);
        expect([handled, prevented]).toEqual([false, false]);
        expect(text).toBe('\u672b\u5c3e');
    });

    it('pastes the address itself while the master switch is off', () => {
        setEditor({ pasteLink: false });
        const doc = `\u5199${LABEL}\u5728\u8fd9\u91cc`;
        const { text, prevented, handled } = withPaste(doc, 'https://a.cn/x', 1, 1 + LABEL.length);
        expect([handled, prevented]).toEqual([true, true]);
        expect(text).toBe(`\u5199https://a.cn/x\u5728\u8fd9\u91cc`);
    });

    it('takes the file branch before the address branch', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const view = new EditorView({ state: EditorState.create({ doc: '\u672b\u5c3e' }), parent: host });
        const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
        Object.defineProperty(event, 'clipboardData', {
            value: {
                files: [new File(['x'], 'shot.png', { type: 'image/png' })],
                types: ['Files'],
                getData: () => 'https://a.cn/x',
            },
        });
        const handlers = {
            uploadFile: async () => ({ url: 'https://cdn/shot.png', filename: 'shot.png', isImage: true }),
        };
        expect(pasteEventHandlers(handlers).paste!.call(view, event, view)).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(view.state.doc.toString()).toContain('<!-- inkstone-upload:');
        expect(view.state.doc.toString()).not.toContain('https://a.cn/x');
        for (let round = 0; round < 6 && !view.state.doc.toString().includes('cdn/shot.png'); round++)
            await new Promise((resolve) => setTimeout(resolve, 0));
        expect(view.state.doc.toString()).toContain('![shot](https://cdn/shot.png)');
        view.destroy();
        host.remove();
    });
});
