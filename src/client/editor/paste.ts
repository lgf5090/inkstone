import { EditorSelection } from '@codemirror/state';
import { EditorView, type DOMEventHandlers } from '@codemirror/view';
import { truncateText } from '@shared/text-utils';
import { t } from "../lib/i18n";
import { randomLocalId } from '../lib/random-id';
import { useSession } from '../store/session';
import { pasteRulesAreOn } from '../lib/linter/rule-search-index';
import { applyPasteLink, escapeMarkdownLabel, markdownLink } from './paste-link';


export interface PasteHandlers {
    uploadFile: (file: File) => Promise<{
        url: string;
        filename: string;
        isImage: boolean;
    } | null>;
    replaceDetachedUpload?: (placeholder: string, replacement: string) => void;
}
export function pasteEventHandlers(handlers: PasteHandlers): DOMEventHandlers<EditorView> {
    return {
        paste(event: ClipboardEvent, view: EditorView) {
            const clipboard = event.clipboardData;
            if (!clipboard)
                return false;

            const files = [...clipboard.files];
            if (!files.length) {
                const types = clipboard.types ? Array.from(clipboard.types) : [];
                const hasRichText = types.includes('text/html') || types.includes('text/plain');
                if (!hasRichText && clipboard.items) {
                    for (const item of [...clipboard.items]) {
                        if (item.kind === 'file' && item.type.startsWith('image/')) {
                            const file = item.getAsFile();
                            if (file) files.push(file);
                        }
                    }
                }
            }
            if (files.length) {
                event.preventDefault();
                void insertFiles(view, files, handlers);
                return true;
            }
            const text = clipboard.getData('text/plain')?.trim();

            if (text && applyPasteLink(view, text)) {
                event.preventDefault();
                return true;
            }

            const html = clipboard.getData('text/html');
            if (html && !looksLikeMarkdown(text)) {
                const markdown = htmlToMarkdown(html);
                if (markdown && markdown !== text) {
                    event.preventDefault();
                    const range = view.state.selection.main;
                    view.dispatch({
                        changes: { from: range.from, to: range.to, insert: markdown },
                        selection: EditorSelection.cursor(range.from + markdown.length),
                        userEvent: 'input.paste',
                    });
                    return true;
                }
            }
            if (text && wantsPasteLint() && !isBareLink(text)) {
                // The paste rules live behind a dynamic import, so the event is claimed here and the
                // text lands when that import answers. If it cannot answer, the reader still gets the
                // text they copied.
                event.preventDefault();
                void lintPastedText(view, text).then((next) => insertText(view, next), () => insertText(view, text));
                return true;
            }
            return false;
        },
        drop(event: DragEvent, view: EditorView) {
            const files = [...(event.dataTransfer?.files ?? [])];
            if (!files.length)
                return false;
            event.preventDefault();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos != null)
                view.dispatch({ selection: EditorSelection.cursor(pos) });
            void insertFiles(view, files, handlers);
            return true;
        },
        dragover(event: DragEvent) {
            if (event.dataTransfer?.types.includes('Files'))
                event.preventDefault();
            return false;
        },
    };
}

export function pasteExtension(handlers: PasteHandlers) {
    // The paste rules are a dynamic import, and a paste that claims the event has to wait for that
    // import. Asking for it while the editor is being built is what keeps the reader's first paste
    // from being the one that pays for it.
    if (wantsPasteLint()) {
        void import('../lib/linter/runner');
    }
    return EditorView.domEventHandlers(pasteEventHandlers(handlers));
}

/** Whether the reader asked for the paste rules to run on what they paste. */
function wantsPasteLint(): boolean {
    const linter = useSession.getState().settings.linter;
    return linter.enabled && linter.lintOnPaste && pasteRulesAreOn(linter.ruleConfigs);
}

/**
 * A lone address is left for the link features to deal with, the way the reference plugin gives up
 * on a clipboard that holds a link — linting it would fight whatever turns it into a card.
 */
function isBareLink(text: string): boolean {
    return /^(?:https?:\/\/|www\.|mailto:|file:)/i.test(text.trim());
}

function insertText(view: EditorView, text: string): void {
    const range = view.state.selection.main;
    view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        userEvent: 'input.paste',
    });
}

/** The paste-time rules, over the text about to land, with the line and selection they apply to. */
async function lintPastedText(view: EditorView, text: string): Promise<string> {
    const range = view.state.selection.main;
    const { lintPaste } = await import('../lib/linter');
    return lintPaste({
        text,
        currentLine: view.state.doc.lineAt(range.head).text,
        selectedText: view.state.sliceDoc(range.from, range.to),
        settings: useSession.getState().settings.linter,
    });
}
export async function insertFiles(view: EditorView, files: File[], handlers: PasteHandlers): Promise<void> {
    // Two or more pictures pasted together become one layout block, each upload sitting on its own row line
    // inside it. The block is written first and each placeholder keeps the marker the replacement looks for,
    // so bundling changes nothing about how an individual upload lands or what a failure says.
    const bundled = shouldBundleUploads(files);
    if (bundled) {
        const range = view.state.selection.main;
        const line = view.state.doc.lineAt(range.head);
        const breakBefore = line.text.trim() ? '\n\n' : '';
        const body = files
            .map((file) => `${t("editor.uploading_value0", { value0: escapeMarkdownLabel(file.name) })}${uploadMarker()}`)
            .join('\n');
        const insert = `${breakBefore}${mediaBundleHeader()}\n${body}\n:::\n`;
        view.dispatch({
            changes: { from: range.from, to: range.to, insert },
            selection: EditorSelection.cursor(range.from + insert.length),
            userEvent: 'input.paste',
        });
        const pending = files.map((file, index) => ({
            file,
            placeholder: body.split('\n')[index]!,
        }));
        await settleUploads(view, pending, handlers);
        return;
    }

    const pending = files.map((file) => {
        const range = view.state.selection.main;
        const placeholder = `${t("editor.uploading_value0", { value0: escapeMarkdownLabel(file.name) })}${uploadMarker()}`;
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: placeholder },
            selection: EditorSelection.cursor(range.from + placeholder.length),
            userEvent: 'input.paste',
        });
        return { file, placeholder };
    });
    await settleUploads(view, pending, handlers);
}

/** The anchor a finished upload is found by, spelled in the one place both paths write it. */
function uploadMarker(): string {
    return `<!-- inkstone-upload:${uploadId()} -->`;
}

/** A bundle is two or more *pictures*; a stray file or a single drop stays an ordinary line. */
function shouldBundleUploads(files: File[]): boolean {
    if (files.length < 2) return false;
    if (!files.every((file) => file.type.startsWith('image/'))) return false;
    return useSession.getState().settings.preview.mediaAutoBundle;
}

function mediaBundleHeader(): string {
    return useSession.getState().settings.preview.mediaAutoBundleWrap ? '::: media wrap=left width=40%' : '::: media';
}

/** Every upload's own replacement pass: the marker is the anchor, so a re-ordered note still resolves. */
async function settleUploads(
    view: EditorView,
    pending: Array<{ file: File, placeholder: string }>,
    handlers: PasteHandlers,
): Promise<void> {
    await Promise.all(pending.map(async ({ file, placeholder }) => {
        let result: Awaited<ReturnType<PasteHandlers['uploadFile']>> = null;
        try {
            result = await handlers.uploadFile(file);
        }
        catch {
        }
        const markdown = result
            ? uploadedFileMarkdown(result)
            : t("editor.upload_failed_value0", { value0: safeHtmlComment(file.name) });
        if (!view.dom.isConnected) {
            handlers.replaceDetachedUpload?.(placeholder, markdown);
            return;
        }
        const doc = view.state.doc.toString();
        const at = doc.indexOf(placeholder);
        if (at < 0) {
            handlers.replaceDetachedUpload?.(placeholder, markdown);
            return;
        }
        view.dispatch({
            changes: { from: at, to: at + placeholder.length, insert: markdown },
            userEvent: 'input.paste',
        });
    }));
}
export function uploadedFileMarkdown(result: {
    url: string;
    filename: string;
    isImage: boolean;
}): string {
    return markdownLink(result.isImage ? stripExt(result.filename) : result.filename, result.url, result.isImage);
}
function stripExt(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}
function safeHtmlComment(value: string): string {
    return truncateText(value.replace(/[\r\n<>]+/g, ' ').replace(/--+/g, '\u2014'), 240);
}
function uploadId(): string {
    return randomLocalId();
}
function looksLikeMarkdown(text: string | undefined): boolean {
    if (!text)
        return false;
    return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|)/m.test(text) || /\[[^\]]*\]\([^)]*\)/.test(text);
}


export function htmlToMarkdown(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, meta, link, noscript').forEach((el) => el.remove());
    const walk = (node: Node, listIndent = ''): string => {
        if (node.nodeType === Node.TEXT_NODE) {
            return (node.textContent ?? '').replace(/\s+/g, ' ');
        }
        if (node.nodeType !== Node.ELEMENT_NODE)
            return '';
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const children = () => [...el.childNodes].map((child) => walk(child, listIndent)).join('');
        switch (tag) {
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6':
                return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
            case 'p':
                return `\n\n${children().trim()}\n\n`;
            case 'br':
                return '\n';
            case 'hr':
                return '\n\n---\n\n';
            case 'strong':
            case 'b': {
                const text = children().trim();
                return text ? `**${text}**` : '';
            }
            case 'em':
            case 'i': {
                const text = children().trim();
                return text ? `*${text}*` : '';
            }
            case 'del':
            case 's':
            case 'strike': {
                const text = children().trim();
                return text ? `~~${text}~~` : '';
            }
            case 'code':
                if (el.closest('pre'))
                    return el.textContent ?? '';
                return inlineCode(el.textContent ?? '');
            case 'pre': {
                const code = el.textContent ?? '';
                const lang = /language-([a-z0-9+#-]+)/i.exec(el.querySelector('code')?.className ?? '')?.[1] ?? '';
                const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
                return `\n\n${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}\n\n`;
            }
            case 'blockquote':
                return `\n\n${children()
                    .trim()
                    .split('\n')
                    .map((line) => `> ${line}`)
                    .join('\n')}\n\n`;
            case 'a': {
                const href = safePastedHref(el.getAttribute('href') ?? '', false);
                const label = children().trim() || href || '';

                return href ? markdownLink(label, href) : label;
            }
            case 'img': {
                const src = safePastedHref(el.getAttribute('src') ?? '', true);
                const alt = el.getAttribute('alt') ?? '';
                return src ? markdownLink(alt, src, true) : '';
            }
            case 'ul':
            case 'ol':
                return `\n\n${renderList(el, listIndent)}\n\n`;
            case 'li':
                return children();
            case 'table': {
                const rows = [...el.querySelectorAll('tr')];
                if (!rows.length)
                    return children();
                const cells = (row: Element) => [...row.querySelectorAll('th, td')].map((c) => (c.textContent ?? '').trim().replace(/\|/g, '\\|'));
                const header = cells(rows[0]!);
                const lines = [
                    `| ${header.join(' | ')} |`,
                    `| ${header.map(() => '---').join(' | ')} |`,
                    ...rows.slice(1).map((row) => `| ${cells(row).join(' | ')} |`),
                ];
                return `\n\n${lines.join('\n')}\n\n`;
            }
            default:
                return children();
        }
    };
    return walk(doc.body)
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();

    function renderList(list: HTMLElement, indent: string): string {
        const ordered = list.tagName.toLowerCase() === 'ol';
        const parsedStart = Number.parseInt(list.getAttribute('start') ?? '1', 10);
        const start = Number.isFinite(parsedStart) ? parsedStart : 1;
        const items = [...list.children].filter((child) => child.tagName.toLowerCase() === 'li');
        const lines: string[] = [];
        items.forEach((item, index) => {
            const explicit = Number.parseInt(item.getAttribute('value') ?? '', 10);
            const number = Number.isFinite(explicit) ? explicit : start + index;
            const marker = ordered ? `${number}. ` : '- ';
            const nested: HTMLElement[] = [];
            const content = [...item.childNodes]
                .map((child) => {
                if (child.nodeType === Node.ELEMENT_NODE && /^(?:ul|ol)$/i.test((child as Element).tagName)) {
                    nested.push(child as HTMLElement);
                    return '';
                }
                return walk(child, indent + ' '.repeat(marker.length));
            })
                .join('')
                .trim()
                .replace(/\n{2,}/g, '\n');
            const contentLines = content ? content.split('\n') : [''];
            lines.push(`${indent}${marker}${contentLines[0]}`);
            for (const continuation of contentLines.slice(1)) {
                lines.push(`${indent}${' '.repeat(marker.length)}${continuation}`);
            }
            for (const childList of nested) {
                lines.push(renderList(childList, indent + ' '.repeat(marker.length)));
            }
        });
        return lines.join('\n');
    }
}

function safePastedHref(value: string, image: boolean): string | null {
    const href = value.trim();
    if (!href)
        return null;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
    if (scheme && !(image ? ['http', 'https'] : ['http', 'https', 'mailto', 'tel']).includes(scheme))
        return null;
    return href;
}

function inlineCode(value: string): string {
    const content = value.replace(/[\r\n]+/g, ' ');
    const fence = '`'.repeat(Math.max(1, longestRun(content, '`') + 1));
    const pad = /^(?:\s|`)|(?:\s|`)$/.test(content) ? ' ' : '';
    return `${fence}${pad}${content}${pad}${fence}`;
}

function longestRun(value: string, character: string): number {
    return Math.max(0, ...[...value.matchAll(new RegExp(`${character}+`, 'g'))].map((match) => match[0].length));
}
