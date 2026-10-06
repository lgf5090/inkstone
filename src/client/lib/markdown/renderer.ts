/** Builds the sanitized Markdown rendering pipeline and its Inkstone-specific syntax extensions. */
import MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import anchor from 'markdown-it-anchor';
import mark from 'markdown-it-mark';
import DOMPurify from 'dompurify';
import { parseFrontMatter, slugifyHeading } from '@shared/markdown-utils';
import { getLocale, t, type MessageKey } from '../i18n';
import { parseEmbedSize, splitAltSize } from './attachments';
import { encodeDataValue } from './data-attr';
import { parseFenceInfo } from './fence-info';
import { readCodeOptions } from './code-options';
import { EXAMPLE_SPLIT_DEFAULTS, exampleRatioLabel, parseExampleSplit, type ExampleFamily } from './example-split';
import { isTimelineDateTime, parseTimelineItem, splitTimelineInfo } from './timeline-options';
import type { TimelineItem, TimelineOptions, TimelineStatus } from './timeline-options';
import { readFenceStyle } from './chart/style';
import { CHART_LANGUAGES } from './chart/body';
import { detectMindmapMode, MINDMAP_LANGUAGES } from './mindmap/body';
import { MINDMAP_THEME_ATTR, readFenceAnnotation } from './mindmap/theme';
export interface Heading {
    level: number;
    text: string;
    slug: string;
    line: number;
}
export interface RenderResult {
    html: string;
    headings: Heading[];
    hasMath: boolean;
    hasMermaid: boolean;
    hasEmbeds: boolean;
    frontMatter: Record<string, unknown>;
    frontMatterErrors: string[];
}
interface RenderEnvironment {
    headings: Heading[];
    hasMath: boolean;
    hasMermaid: boolean;
    hasEmbeds: boolean;
    frontMatter: Record<string, unknown>;
    frontMatterErrors: string[];
    taskNonce: string;
    tabSequence: number;
    exampleSequence: number;
    /** Counts the mind map blocks in this document, so each one can name itself. */
    mindmapSequence: number;
    docId: string;
    hideFrontMatter?: boolean;
}
export interface WikiTarget {
    raw: string;
    noteTitle: string;
    heading: string | null;
    blockId: string | null;
    alias: string | null;
}
const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
    langPrefix: 'language-',
});
md.use(taskLists, { enabled: true, label: false })
    .use(footnote)
    .use(mark)
    .use(anchor, {
    slugify: slugifyHeading,

    permalink: anchor.permalink.linkInsideHeader({
        symbol: '',
        placement: 'before',
        class: 'heading-anchor',
        ariaHidden: true,
    }),
});

md.block.ruler.before('hr', 'front_matter', (state, startLine, _endLine, silent) => {
    if (startLine !== 0)
        return false;
    const parsed = parseFrontMatter(state.src);
    if (!parsed.lineOffset)
        return false;
    if (silent)
        return true;
    const token = state.push('front_matter', 'section', 0);
    token.block = true;
    token.map = [0, parsed.lineOffset];
    token.meta = { data: parsed.data, errors: parsed.errors };
    const env = renderEnv(state.env);
    env.frontMatter = parsed.data;
    env.frontMatterErrors = parsed.errors;
    state.line = parsed.lineOffset;
    return true;
});
md.renderer.rules.front_matter = (tokens, index, _options, env) => {
    const meta = tokens[index]!.meta as {
        data: Record<string, unknown>;
        errors: string[];
    };
    if (meta.errors.length) {
        const details = meta.errors.map((error) => `<li>${escapeHtml(localizeFrontMatterError(error))}</li>`).join('');
        return `<aside class="frontmatter-error" data-line="0"><strong>${escapeHtml(t("markdown.invalid_front_matter"))}</strong><ul>${details}</ul></aside>`;
    }
    const entries = Object.entries(meta.data);
    if (!entries.length || renderEnv(env).hideFrontMatter)
        return '';
    const rows = entries
        .map(([key, value]) => `<div class="frontmatter-row"><dt>${escapeHtml(key)}</dt><dd>${renderFrontMatterValue(value)}</dd></div>`)
        .join('');
    return `<details class="frontmatter-properties" data-line="0"><summary>${escapeHtml(t("markdown.properties"))}</summary><dl>${rows}</dl></details>`;
};
const COLON_CONTAINER_OPEN = /^(:{3,})[ \t]*(details|tabs|timeline)\b(?:[ \t]+(.*))?$/;
const COLON_CONTAINER_BODY = /^[ \t]*(?:\{(?:tab-set|tab-item)\}|(?:details|tabs|tab-item|timeline)\b)/;
const TAB_ITEM_OPEN = /^(:{3,})(?:\{tab-item\}|[ \t]*tab-item)(?:[ \t]+(.*?))?[ \t]*$/;
const TIMELINE_NODE_MARK = /^::(?!:)[ \t]*(.*)$/;
const INTERRUPTS_CONTAINER_CHAIN = { alt: ['paragraph', 'blockquote', 'list'] };
md.block.ruler.before('fence', 'modern_container', (state, startLine, endLine, silent) => {
    const source = blockLine(state, startLine);
    const legacyMatch = COLON_CONTAINER_OPEN.exec(source);
    const directiveMatch = /^(:{3,})\{(tab-set)\}[ \t]*(.*)$/.exec(source);
    if (!legacyMatch && !directiveMatch)
        return false;
    const markerLength = (legacyMatch?.[1] ?? directiveMatch![1]!).length;
    const fenceEnd = findColonFenceEnd(state, startLine + 1, endLine, markerLength);
    // Like an unclosed ``` fence, an unclosed container claims the rest of its own context
    // instead of throwing the author's text away.
    const end = fenceEnd < 0 ? endLine : fenceEnd;
    const nextLine = fenceEnd < 0 ? endLine : fenceEnd + 1;
    if (silent)
        return true;
    const kind = legacyMatch?.[2] ?? directiveMatch![2]!;
    if (kind === 'timeline') {
        renderTimelineContainer(state, startLine, end, nextLine, legacyMatch?.[3] ?? '');
    }
    else if (kind === 'details') {
        const rawInfo = (legacyMatch?.[3] ?? directiveMatch?.[3] ?? '').trim();
        const fold = /^(open|[+-])(?:[ \t]|$)/.exec(rawInfo);
        const open = fold?.[1] === 'open' || fold?.[1] === '+';
        const title = stripBracketTitle(rawInfo.slice(fold ? fold[0].length : 0)) || t("markdown.details");
        const openToken = state.push('details_open', 'details', 1);
        openToken.block = true;
        openToken.map = [startLine, nextLine];
        openToken.meta = { open };
        const summary = state.push('details_summary', 'summary', 0);
        summary.content = title;
        state.md.block.tokenize(state, startLine + 1, end);
        state.push('details_close', 'details', -1).block = true;
    }
    else {
        const tabs = findTabSegments(state, startLine + 1, end);
        if (!tabs.length) {
            // A tab set without any tab-item still holds the author's content, so render
            // the body as ordinary blocks instead of consuming it.
            state.md.block.tokenize(state, startLine + 1, end);
            state.line = nextLine;
            return true;
        }
        const env = renderEnv(state.env);
        const id = `${env.docId}-tabs-${++env.tabSequence}`;
        const selectedIndex = Math.max(0, tabs.findIndex((tab) => tab.selected));
        const openToken = state.push('tabs_open', 'div', 1);
        openToken.block = true;
        openToken.map = [startLine, nextLine];
        openToken.meta = { id, titles: tabs.map((tab) => tab.title), selectedIndex };
        tabs.forEach((tab, tabIndex) => {
            const panelOpen = state.push('tab_panel_open', 'section', 1);
            panelOpen.block = true;
            panelOpen.meta = { id, tabIndex, selected: tabIndex === selectedIndex };
            state.md.block.tokenize(state, tab.start, tab.end);
            const panelClose = state.push('tab_panel_close', 'section', -1);
            panelClose.block = true;
            panelClose.meta = { id, tabIndex };
        });
        state.push('tabs_close', 'div', -1).block = true;
    }
    state.line = nextLine;
    return true;
}, INTERRUPTS_CONTAINER_CHAIN);
md.renderer.rules.details_open = (tokens, index) => {
    const sourceLine = tokens[index]!.map?.[0];
    const open = Boolean((tokens[index]!.meta as {
        open?: boolean;
    })?.open);
    return `<details class="markdown-details"${sourceLine === undefined ? '' : ` data-line="${sourceLine}"`}${open ? ' open' : ''}>`;
};
md.renderer.rules.details_summary = (tokens, index, _options, env) => `<summary>${md.renderInline(tokens[index]!.content, env)}</summary>`;
md.renderer.rules.details_close = () => '</details>';
md.renderer.rules.tabs_open = (tokens, index) => {
    const sourceLine = tokens[index]!.map?.[0];
    const { id, titles, selectedIndex } = tokens[index]!.meta as {
        id: string;
        titles: string[];
        selectedIndex: number;
    };
    const buttons = titles
        .map((title, tabIndex) => `<button type="button" role="tab" id="${id}-tab-${tabIndex}" aria-controls="${id}-panel-${tabIndex}" aria-selected="${tabIndex === selectedIndex ? 'true' : 'false'}" tabindex="${tabIndex === selectedIndex ? '0' : '-1'}" data-tab-button="${tabIndex}">${escapeHtml(title)}</button>`)
        .join('');
    return `<div class="markdown-tabs" data-tabs${sourceLine === undefined ? '' : ` data-line="${sourceLine}"`}><div class="tab-list" role="tablist" aria-label="${escapeAttr(t("common.tabs"))}">${buttons}</div>`;
};
md.renderer.rules.tabs_close = () => '</div>';
md.renderer.rules.tab_panel_open = (tokens, index) => {
    const { id, tabIndex, selected } = tokens[index]!.meta as {
        id: string;
        tabIndex: number;
        selected: boolean;
    };
    return `<section class="tab-panel" role="tabpanel" id="${id}-panel-${tabIndex}" aria-labelledby="${id}-tab-${tabIndex}" data-tab-panel="${tabIndex}"${selected ? '' : ' hidden'}>`;
};
md.renderer.rules.tab_panel_close = () => '</section>';
const TIMELINE_STATUS_KEYS: Record<TimelineStatus, MessageKey> = {
    todo: 'markdown.todo',
    doing: 'markdown.timeline_doing',
    done: 'markdown.timeline_done',
    milestone: 'markdown.timeline_milestone',
    error: 'markdown.timeline_error',
};
md.renderer.rules.timeline_open = (tokens, index, _options, env) => {
    const token = tokens[index]!;
    const { title, options } = token.meta as { title: string, options: TimelineOptions };
    const attrs = [
        sourceLineAttribute(token.map?.[0]),
        options.dense ? ' data-timeline-dense="true"' : '',
        options.status ? '' : ' data-timeline-status="off"',
        options.marker === 'number' ? ' data-timeline-marker="number"' : '',
    ].join('');
    const caption = title ? `<div class="markdown-timeline-caption">${md.renderInline(title, env)}</div>` : '';
    return `<div class="markdown-timeline-block"${attrs}>${caption}`;
};
md.renderer.rules.timeline_close = () => '</div>';
md.renderer.rules.timeline_item_open = (tokens, index, _options, env) => {
    const { item, sourceLine } = tokens[index]!.meta as { item: TimelineItem, sourceLine: number };
    const datetime = isTimelineDateTime(item.time) ? ` data-datetime="${escapeAttr(item.time)}"` : '';
    const time = item.time ? `<span class="markdown-timeline-time"${datetime}>${escapeHtml(item.time)}</span>` : '';
    const title = item.title ? `<span class="markdown-timeline-title">${md.renderInline(item.title, env)}</span>` : '';
    const status = `<span class="markdown-timeline-status">${escapeHtml(t(TIMELINE_STATUS_KEYS[item.status]))}</span>`;
    return `<li class="markdown-timeline-item" data-status="${escapeAttr(item.status)}"${sourceLineAttribute(sourceLine)}><span class="markdown-timeline-node" aria-hidden="true"></span><div class="markdown-timeline-body"><div class="markdown-timeline-head">${time}${title}${status}</div>`;
};
md.renderer.rules.timeline_item_close = () => '</div></li>';
const MATH_INLINE = /^\$(?!\s)((?:[^$\\]|\\.)+?)(?<!\s)\$/;
md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    if (state.src[state.pos] !== '$')
        return false;
    const match = MATH_INLINE.exec(state.src.slice(state.pos));
    if (!match)
        return false;
    if (!silent) {
        const token = state.push('math_inline', 'span', 0);
        token.content = match[1]!;
        token.markup = '$';
        renderEnv(state.env).hasMath = true;
    }
    state.pos += match[0].length;
    return true;
});
md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const line = blockLine(state, startLine);
    if (!/^\$\$/.test(line))
        return false;
    const firstLine = line.slice(2);
    let content = '';
    let next = startLine;
    let found = false;
    if (firstLine.trim().endsWith('$$')) {
        content = firstLine.trim().slice(0, -2);
        found = true;
    }
    else {
        while (!found && ++next < endLine) {
            const text = blockLine(state, next);
            if (text.trim().endsWith('$$')) {
                content += text.slice(0, text.lastIndexOf('$$'));
                found = true;
            }
            else {
                content += `${text}\n`;
            }
        }
        if (firstLine.trim())
            content = `${firstLine}\n${content}`;
    }
    if (!found)
        return false;
    if (silent)
        return true;
    const token = state.push('math_block', 'div', 0);
    token.content = content.trim();
    token.map = [startLine, next + 1];
    token.markup = '$$';
    renderEnv(state.env).hasMath = true;
    state.line = next + 1;
    return true;
}, INTERRUPTS_CONTAINER_CHAIN);
md.renderer.rules.math_inline = (tokens, index) => `<span class="math-inline" data-math="${escapeAttr(encodeDataValue(tokens[index]!.content))}"></span>`;
md.renderer.rules.math_block = (tokens, index) => {
    const token = tokens[index]!;
    const line = token.map ? ` data-line="${token.map[0]}"` : '';
    return `<div class="math-block"${line} data-math="${escapeAttr(encodeDataValue(token.content))}"></div>`;
};
const WIKI_RE = /^\[\[([^\[\]\n]{1,400})\]\]/;
const EMBED_RE = /^!\[\[([^\[\]\n]{1,400})\]\]/;
const BLOCK_REF_RE = /^\(\(([A-Za-z0-9][A-Za-z0-9_-]{0,63})\)\)/;
const TAG_RE = /^#([\p{L}\p{N}_\-/·]{1,60})(?![\p{L}\p{N}_\-/·])/u;
md.inline.ruler.before('image', 'note_embed', (state, silent) => {
    if (!state.src.startsWith('![[', state.pos))
        return false;
    const match = EMBED_RE.exec(state.src.slice(state.pos));
    // An empty target would render a box that resolves to nothing and shows nothing, so the
    // author's text stays visible instead.
    if (!match || !match[1]!.trim())
        return false;
    if (!silent) {
        const token = state.push('note_embed', 'div', 0);
        token.content = match[1]!.trim();
        renderEnv(state.env).hasEmbeds = true;
    }
    state.pos += match[0].length;
    return true;
});
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    if (!state.src.startsWith('[[', state.pos))
        return false;
    const match = WIKI_RE.exec(state.src.slice(state.pos));
    if (!match || !match[1]!.trim())
        return false;
    if (!silent) {
        const token = state.push('wikilink', 'a', 0);
        token.content = match[1]!.trim();
    }
    state.pos += match[0].length;
    return true;
});
md.inline.ruler.before('text', 'block_reference', (state, silent) => {
    if (!state.src.startsWith('((', state.pos))
        return false;
    const match = BLOCK_REF_RE.exec(state.src.slice(state.pos));
    if (!match)
        return false;
    if (!silent) {
        const token = state.push('block_reference', 'a', 0);
        token.content = match[1]!;
    }
    state.pos += match[0].length;
    return true;
});
md.inline.ruler.before('text', 'inline_tag', (state, silent) => {
    if (state.src[state.pos] !== '#')
        return false;
    const previous = state.pos > 0 ? state.src[state.pos - 1]! : ' ';
    if (!/[\s(\uff08[\u3010>\u300c\u300e\uff0c,\u3001;\uff1b]/.test(previous) && state.pos !== 0)
        return false;
    const match = TAG_RE.exec(state.src.slice(state.pos));
    if (!match)
        return false;
    if (!silent) {
        const token = state.push('inline_tag', 'span', 0);
        token.content = match[1]!;
    }
    state.pos += match[0].length;
    return true;
});
md.renderer.rules.note_embed = (tokens, index) => {
    const source = tokens[index]!.content.trim();
    // The whole target goes into the attribute, alias included: an attachment embed reads its
    // `|600x400` size back out of it, and stripping it here would lose the size and turn the
    // label into a bare number.
    const parsed = parseWikiTarget(source);
    const label = parsed.alias && parseEmbedSize(parsed.alias) ? parsed.noteTitle || parsed.raw : parsed.alias || parsed.raw;
    return `<div class="note-embed loading" data-embed-target="${escapeAttr(encodeDataValue(source))}"><span class="note-embed-head">${escapeHtml(label)}</span><div class="note-embed-body" aria-busy="true">${escapeHtml(t("common.loading"))}</div></div>`;
};
md.renderer.rules.wikilink = (tokens, index) => {
    const parsed = parseWikiTarget(tokens[index]!.content);
    const label = parsed.alias || parsed.raw;
    return `<a class="wikilink" data-wikilink="${escapeAttr(encodeDataValue(parsed.raw))}" href="#">${escapeHtml(label)}</a>`;
};
md.renderer.rules.block_reference = (tokens, index) => {
    const id = tokens[index]!.content;
    return `<a class="block-reference" data-block-ref="${escapeAttr(id)}" href="#%5E${escapeAttr(id)}">((${escapeHtml(id)}))</a>`;
};
md.renderer.rules.inline_tag = (tokens, index) => `<span class="inline-tag" data-tag="${escapeAttr(encodeDataValue(tokens[index]!.content))}" role="link" tabindex="0" draggable="true">#${escapeHtml(tokens[index]!.content)}</span>`;
md.core.ruler.before('github-task-lists', 'obsidian_blocks', (state) => {
    const seenBlockIds = new Set<string>();
    for (let index = 0; index < state.tokens.length; index++) {
        const inline = state.tokens[index]!;
        if (inline.type !== 'inline')
            continue;
        expandBlockReferences(inline, state.Token);
        const opening = findOpeningToken(state.tokens, index);
        if (!opening)
            continue;
        let content = inline.content;
        const block = /(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*$/.exec(content);
        if (block) {
            let id = block[1]!;
            const original = id;
            let suffix = 2;
            while (seenBlockIds.has(id))
                id = `${original}-${suffix++}`;
            seenBlockIds.add(id);
            setTokenAttribute(opening, 'id', `^${id}`);
            setTokenAttribute(opening, 'data-block-id', id);
            content = content.slice(0, block.index).trimEnd();
        }
        if (content !== inline.content)
            reparseInline(inline, content, state.md, state.env);
    }
    return true;
});
md.core.ruler.after('github-task-lists', 'obsidian_callouts', (state) => {
    for (let index = 0; index < state.tokens.length; index++) {
        const open = state.tokens[index]!;
        if (open.type !== 'blockquote_open')
            continue;
        const paragraphOpen = state.tokens[index + 1];
        const inline = state.tokens[index + 2];
        if (paragraphOpen?.type !== 'paragraph_open' || inline?.type !== 'inline')
            continue;
        const firstBreak = inline.content.indexOf('\n');
        const firstLine = firstBreak >= 0 ? inline.content.slice(0, firstBreak) : inline.content;
        const marker = /^\[!([A-Za-z][A-Za-z0-9_-]{0,31})\]([+-])?(?:[ \t]+(.+?))?[ \t]*$/.exec(firstLine);
        if (!marker)
            continue;
        const closeIndex = matchingClose(state.tokens, index, 'blockquote_open', 'blockquote_close');
        if (closeIndex < 0)
            continue;
        const type = normalizeCalloutType(marker[1]!);
        const fold = marker[2] ?? '';
        const title = marker[3]?.trim() || calloutDefaultTitle(type);
        open.type = 'callout_open';
        open.tag = fold ? 'details' : 'aside';
        open.meta = { type, title, fold };
        const close = state.tokens[closeIndex]!;
        close.type = 'callout_close';
        close.tag = open.tag;
        close.meta = { fold };
        const remaining = firstBreak >= 0 ? inline.content.slice(firstBreak + 1) : '';
        if (remaining.trim()) {
            reparseInline(inline, remaining, state.md, state.env);
        }
        else {
            const paragraphClose = state.tokens[index + 3];
            if (paragraphClose?.type === 'paragraph_close')
                state.tokens.splice(index + 1, 3);
        }
    }
    return true;
});
md.renderer.rules.callout_open = (tokens, index, _options, env) => {
    const sourceLine = tokens[index]!.map?.[0];
    const line = sourceLine === undefined ? '' : ` data-line="${sourceLine}"`;
    const { type, title, fold } = tokens[index]!.meta as {
        type: string;
        title: string;
        fold: string;
    };
    const heading = md.renderInline(title, env);
    if (fold) {
        return `<details class="callout callout-${escapeAttr(type)}" data-callout="${escapeAttr(type)}"${line}${fold === '+' ? ' open' : ''}><summary class="callout-title">${heading}</summary><div class="callout-content">`;
    }
    return `<aside class="callout callout-${escapeAttr(type)}" data-callout="${escapeAttr(type)}"${line}><div class="callout-title">${heading}</div><div class="callout-content">`;
};
md.renderer.rules.callout_close = (tokens, index) => `</div>${(tokens[index]!.meta as {
    fold: string;
}).fold ? '</details>' : '</aside>'}`;
md.core.ruler.after('github-task-lists', 'trusted_task_placeholders', (state) => {
    const env = renderEnv(state.env);
    for (let index = 2; index < state.tokens.length; index++) {
        const inline = state.tokens[index]!;
        const paragraph = state.tokens[index - 1]!;
        const item = state.tokens[index - 2]!;
        if (inline.type !== 'inline' ||
            paragraph.type !== 'paragraph_open' ||
            item.type !== 'list_item_open' ||
            !inline.children?.length) {
            continue;
        }
        const checkboxIndex = inline.children.findIndex((child) => child.type === 'html_inline' && /task-list-item-checkbox/.test(child.content));
        if (checkboxIndex < 0)
            continue;
        const checkbox = inline.children[checkboxIndex]!;
        const checked = /\schecked(?:=|\s|>)/.test(checkbox.content);
        const sourceLine = item.map?.[0];
        if (sourceLine == null)
            continue;
        checkbox.content = `<span class="task-checkbox-placeholder" data-task-placeholder="${env.taskNonce}" data-task-line="${sourceLine}" data-task-checked="${checked ? '1' : '0'}"></span>`;
        const labelOpen = new state.Token('html_inline', '', 0);
        labelOpen.content = '<span class="task-label">';
        const labelClose = new state.Token('html_inline', '', 0);
        labelClose.content = '</span>';
        inline.children.splice(checkboxIndex + 1, 0, labelOpen);
        inline.children.push(labelClose);
        setTokenAttribute(item, 'data-task-line', String(sourceLine));
        if (checked)
            appendTokenClass(item, 'done');
    }
    return true;
});
md.core.ruler.after('trusted_task_placeholders', 'block_note_embeds', (state) => {
    for (let index = 1; index < state.tokens.length - 1; index++) {
        const inline = state.tokens[index]!;
        const open = state.tokens[index - 1]!;
        const close = state.tokens[index + 1]!;
        if (inline.type !== 'inline' || open.type !== 'paragraph_open' || close.type !== 'paragraph_close' ||
            !inline.children?.some((child) => child.type === 'note_embed')) {
            continue;
        }
        open.type = 'note_embed_paragraph_open';
        open.tag = 'div';
        open.attrJoin('class', 'note-embed-paragraph');
        close.type = 'note_embed_paragraph_close';
        close.tag = 'div';
    }
    return true;
});
function exampleSplitAttrs(family: ExampleFamily, info: string): string {
    const split = parseExampleSplit(info, EXAMPLE_SPLIT_DEFAULTS[family]);
    return ` data-example-layout="${escapeAttr(split.layout)}" data-example-ratio="${escapeAttr(exampleRatioLabel(split.ratio))}"`;
}

/**
 * The runnable block. Its controls are deliberately absent: the markup is what a share page or an
 * export draws, and only the editing preview injects the switch and the run button (see
 * `features/preview/js-runner`). An output panel with nothing in it is the honest state elsewhere.
 */
function renderJavaScriptExample(title: string, line: string, info: string, body: string): string {
    return [
        `<section class="markdown-example js-example-block" data-example-family="js"${line}>`,
        `<div class="markdown-example-head js-example-head">`,
        `<span class="markdown-example-title js-example-title">`,
        `<span class="js-example-badge">JS</span>`,
        `<span>${escapeHtml(title)}</span>`,
        `</span>`,
        `</div>`,
        `<div class="markdown-example-grid js-example-grid"${exampleSplitAttrs('js', info)}>`,
        `<section class="markdown-example-source js-example-source" aria-label="JavaScript">`,
        `<div class="code-block markdown-example-code has-line-numbers" data-lang="javascript" data-code-start="1" data-line-numbers="true">`,
        `<button class="code-copy markdown-example-copy" data-copy type="button" aria-label="${escapeAttr(t("markdown.copy_code"))}">${escapeHtml(t("common.copy"))}</button>`,
        `<pre><code class="language-javascript">${escapeHtml(body)}</code></pre>`,
        `</div>`,
        `</section>`,
        `<section class="markdown-example-preview js-example-output" aria-label="${escapeAttr(t("workspace.execution_result"))}">`,
        `<div class="js-example-output-head">`,
        `<span class="js-example-output-title">${escapeHtml(t("workspace.execution_result"))}</span>`,
        `<span class="js-example-output-status"></span>`,
        `</div>`,
        `<div class="js-example-output-body" data-js-example-output></div>`,
        `</section>`,
        `</div>`,
        `</section>`,
    ].join('');
}
md.renderer.rules.fence = (tokens, index, _options, rendererEnv) => {
    const token = tokens[index]!;
    const info = parseFenceInfo(token.info);
    const line = token.map ? ` data-line="${token.map[0]}"` : '';
    if (info.language === 'md-example' || info.language === 'markdown-example') {
        const parentEnv = renderEnv(rendererEnv);
        const exampleId = ++parentEnv.exampleSequence;
        const childEnv = emptyEnvironment();
        childEnv.taskNonce = parentEnv.taskNonce;
        childEnv.tabSequence = parentEnv.tabSequence;
        childEnv.exampleSequence = parentEnv.exampleSequence;
        childEnv.mindmapSequence = parentEnv.mindmapSequence;
        childEnv.docId = `${parentEnv.docId}-example-${exampleId}`;
        const preview = md.render(stripObsidianComments(token.content), childEnv).replace(/ data-line="\d+"/g, '');
        parentEnv.hasMath ||= childEnv.hasMath;
        parentEnv.hasMermaid ||= childEnv.hasMermaid;
        parentEnv.hasEmbeds ||= childEnv.hasEmbeds;
        parentEnv.tabSequence = childEnv.tabSequence;
        parentEnv.exampleSequence = Math.max(parentEnv.exampleSequence, childEnv.exampleSequence);
        parentEnv.mindmapSequence = Math.max(parentEnv.mindmapSequence, childEnv.mindmapSequence);
        const title = info.title || t("markdown.markdown_example");
        const titleId = `${parentEnv.docId}-markdown-example-${exampleId}`;
        return [
            `<section class="markdown-example" data-example-family="md"${line} aria-labelledby="${titleId}">`,
            `<div class="markdown-example-head"><span class="markdown-example-title" id="${titleId}">${escapeHtml(title)}</span></div>`,
            `<div class="markdown-example-grid"${exampleSplitAttrs('md', token.info)}>`,
            `<section class="markdown-example-preview" aria-label="${escapeAttr(t("common.preview"))}" data-markdown-example-id="${exampleId}" data-markdown-example="${escapeAttr(encodeDataValue(token.content))}">`,
            `<div class="markdown-example-preview-body">${preview}</div>`,
            `</section>`,
            `<section class="markdown-example-source" aria-label="Markdown">`,
            `<div class="code-block markdown-example-code" data-lang="markdown" data-code-start="1">`,
            `<button class="code-copy markdown-example-copy" data-copy type="button" aria-label="${escapeAttr(t("markdown.copy_code"))}">${escapeHtml(t("common.copy"))}</button>`,
            `<pre><code>${escapeHtml(token.content)}</code></pre>`,
            `</div>`,
            `</section>`,
            `</div>`,
            `</section>`,
        ].join('');
    }
    if (info.language === 'javascript-example' || info.language === 'js-example')
        return renderJavaScriptExample(info.title || t("workspace.runnable_javascript_code"), line, token.info, token.content);
    if (info.language === 'mermaid') {
        renderEnv(rendererEnv).hasMermaid = true;
        return `<div class="mermaid-block loading"${line} data-mermaid="${escapeAttr(encodeDataValue(token.content))}" aria-busy="true">${escapeHtml(t("markdown.rendering_diagram"))}</div>`;
    }
    if ((CHART_LANGUAGES as readonly string[]).includes(info.language)) {
        // The body rides along encoded because a chart table's own pipes and braces would otherwise be
        // read back out of markup the sanitizer has already rewritten. `data-line` is how the block finds
        // the fence again when the toolbar writes the note.
        const style = readFenceStyle(token.info);
        return `<div class="chart-block loading"${line}${style === null ? '' : ` data-chart-style="${escapeAttr(style)}"`} data-chart="${escapeAttr(encodeDataValue(token.content))}" aria-busy="true">${escapeHtml(t("markdown.rendering_chart"))}</div>`;
    }
    if ((MINDMAP_LANGUAGES as readonly string[]).includes(info.language))
        return renderMindmapBlock(token, line, rendererEnv);
    const title = info.title || info.language || t("markdown.code");
    const code = readCodeOptions(token.info);
    const optionAttrs = [
        info.lineNumbers ? ' data-line-numbers="true"' : '',
        info.highlightedLines.length ? ` data-highlight-lines="${info.highlightedLines.join(',')}"` : '',
        code.title ? ` data-code-title="${escapeAttr(code.title)}"` : '',
        code.wrap ? ' data-code-wrap="true"' : '',
        code.collapse === null ? '' : ` data-code-collapse-at="${code.collapse}"`,
        code.theme === 'auto' ? '' : ` data-code-theme="${code.theme}"`,
    ].join('');
    return [
        `<div class="code-block${info.lineNumbers ? ' has-line-numbers' : ''}"${line} data-lang="${escapeAttr(info.language)}" data-code-start="${info.startLine}"${optionAttrs}>`,
        `<div class="code-block-head">`,
        `<span class="code-title">${escapeHtml(title)}</span>`,
        info.title && info.language ? `<span class="code-lang">${escapeHtml(info.language)}</span>` : '',
        `<button class="code-copy" data-copy type="button" aria-label="${escapeAttr(t("markdown.copy_code"))}">${escapeHtml(t("common.copy"))}</button>`,
        `</div>`,
        `<pre><code>${escapeHtml(token.content)}</code></pre>`,
        `</div>`,
    ].join('');
};
/**
 * The ```mindmap placeholder. Only the block and its drawing area are emitted here: the head a reader
 * acts on — the format switch, the source panel, the palette, fit and full screen — is built by the
 * preview's toolbar layer, so a share page, an embedded note and an exported document carry no buttons
 * that could not work there. The body rides along encoded for the same reason a chart's does, and the
 * index numbers the blocks within this document so the mount pass can tell two maps of the same body
 * apart.
 */
function renderMindmapBlock(token: Token, line: string, rendererEnv: unknown): string {
    const env = renderEnv(rendererEnv);
    const index = env.mindmapSequence++;
    const annotation = readFenceAnnotation(token.info);
    return [
        `<div class="mindmap-block loading"${line} data-mindmap="${escapeAttr(encodeDataValue(token.content))}" data-mindmap-mode="${detectMindmapMode(token.content)}" data-mindmap-index="${index}"${annotation === null ? '' : ` ${MINDMAP_THEME_ATTR}="${escapeAttr(annotation)}"`} aria-busy="true">`,
        `<div class="mindmap-block-placeholder" data-mindmap-placeholder>${escapeHtml(t("preview.mindmap_loading"))}</div>`,
        `</div>`,
    ].join('');
}
md.renderer.rules.table_open = (tokens, index) => {
    const line = tokens[index]!.map ? ` data-line="${tokens[index]!.map![0]}"` : '';
    return `<div class="table-wrap"${line}><table>`;
};
md.renderer.rules.table_close = () => '</table></div>';
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index]!;
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    token.attrSet('referrerpolicy', 'no-referrer');
    // markdown-it fills alt from the label children at render time, so the size suffix has to
    // come off `token.content` and be removed from the last text child, not from the alt attr.
    const sized = splitAltSize(token.content ?? '');
    if (sized.size) {
        const label = [...(token.children ?? [])].reverse().find((child) => child.type === 'text');
        if (label)
            label.content = label.content.replace(/\|[ \t]*\d{1,5}(?:[xX][ \t]*\d{1,5})?[ \t]*$/, '');
        token.attrSet('alt', sized.alt);
        if (sized.size.width)
            token.attrSet('width', String(sized.size.width));
        if (sized.size.height)
            token.attrSet('height', String(sized.size.height));
    }
    const title = token.attrGet('title');
    const rendered = defaultImage
        ? defaultImage(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options);
    return title ? `<figure>${rendered}<figcaption>${escapeHtml(title)}</figcaption></figure>` : rendered;
};
const defaultLink = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const href = tokens[index]!.attrGet('href') ?? '';
    if (/^https?:/i.test(href)) {
        tokens[index]!.attrSet('target', '_blank');
        tokens[index]!.attrSet('rel', 'noopener noreferrer');
    }
    return defaultLink
        ? defaultLink(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options);
};
md.core.ruler.push('source_lines', (state) => {
    for (const token of state.tokens) {
        if (token.map && token.type.endsWith('_open') && token.level === 0) {
            token.attrSet('data-line', String(token.map[0]));
        }
    }
    return true;
});
md.core.ruler.push('collect_headings', (state) => {
    const env = renderEnv(state.env);
    if (state.tokens.length <= 1) return true;
    env.headings = [];
    for (let index = 0; index < state.tokens.length; index++) {
        const token = state.tokens[index]!;
        if (token.type !== 'heading_open')
            continue;
        const inline = state.tokens[index + 1];
        const text = inline ? plainInline(inline) : '';
        env.headings.push({
            level: Number(token.tag.slice(1)),
            text,
            slug: token.attrGet('id') ?? slugifyHeading(text),
            line: token.map?.[0] ?? 0,
        });
    }
    return true;
});
export const PURIFY_CONFIG = {
    ADD_ATTR: [
        'data-line',
        'data-math',
        'data-mermaid',
        'data-chart',
        'data-chart-style',
        'data-wikilink',
        'data-embed-target',
        'data-block-ref',
        'data-block-id',
        'data-tag',
        'data-lang',
        'data-copy',
        'data-task-placeholder',
        'data-task-line',
        'data-task-checked',
        'data-tabs',
        'data-tab-button',
        'data-tab-panel',
        'data-callout',
        'data-code-start',
        'data-code-title',
        'data-code-wrap',
        'data-code-collapse-at',
        'data-code-theme',
        'data-line-numbers',
        'data-highlight-lines',
        'data-example-family',
        'data-example-layout',
        'data-example-ratio',
        'data-js-example-output',
        'data-markdown-example',
        'data-markdown-example-id',
        'data-mindmap',
        'data-mindmap-mode',
        'data-mindmap-index',
        'data-mindmap-theme',
        'data-mindmap-placeholder',
        'target',
        'loading',
        'decoding',
        'referrerpolicy',
        'align',
        'colspan',
        'open',
        'hidden',
        'role',
        'aria-busy',
        'aria-label',
        'aria-selected',
        'aria-controls',
        'aria-labelledby',
        'tabindex',
        'width',
        'height',
        'lang',
        'dir',
    ],
    ADD_TAGS: ['figure', 'figcaption', 'details', 'summary'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'base'],
    FORBID_ATTR: [
        'style',
        'onerror',
        'onload',
        'onclick',
        'onchange',
        'oninput',
        'onfocus',
        'srcdoc',
        'formaction',
        'action',
    ],
    ALLOW_DATA_ATTR: true,
};
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A' && node.getAttribute('target')?.toLowerCase() === '_blank') {
        node.setAttribute('rel', 'noopener noreferrer');
    }
});
export interface MarkdownBlock {
    startLine: number;
    endLine: number;
    html: string;
}

/** Parse once with the full document environment so reference links retain their targets. */
export function renderMarkdownBlocks(source: string): { blocks: MarkdownBlock[]; headings: Heading[] } {
    const env = emptyEnvironment();
    const tokens = md.parse(stripObsidianComments(source), env);
    const groups: Array<{ startLine: number; endLine: number; raw: string }> = [];
    let tail = '';
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.level !== 0 || token.nesting === -1) continue;
        let end = i + 1;
        if (token.nesting === 1) {
            let depth = 1;
            while (end < tokens.length && depth > 0) depth += tokens[end++]!.nesting;
        }
        const raw = md.renderer.render(tokens.slice(i, end), md.options, env);
        if (token.map)
            groups.push({ startLine: token.map[0], endLine: token.map[1], raw });
        else
            tail += raw;
        i = end - 1;
    }
    if (tail && groups.length)
        groups[groups.length - 1]!.raw += tail;
    const blocks: MarkdownBlock[] = [];
    if (!groups.length)
        return { blocks, headings: env.headings };
    const marker = `${env.taskNonce}:`;
    const frame = document.createElement('template');
    frame.innerHTML = materializeTrustedTasks(DOMPurify.sanitize(groups.map((group, index) => `<div data-render-group="${marker}${index}">${group.raw}</div>`).join(''), PURIFY_CONFIG), env.taskNonce);
    for (const child of Array.from(frame.content.children)) {
        const key = (child as HTMLElement).dataset?.renderGroup;
        if (typeof key !== 'string' || !key.startsWith(marker))
            continue;
        const group = groups[Number(key.slice(marker.length))];
        const html = child.innerHTML;
        if (group && html.trim())
            blocks.push({ startLine: group.startLine, endLine: group.endLine, html });
    }
    return { blocks, headings: env.headings };
}

export function renderMarkdown(source: string, options?: { hideFrontMatter?: boolean }): RenderResult {
    const env = emptyEnvironment();
    env.hideFrontMatter = options?.hideFrontMatter === true;
    const raw = md.render(stripObsidianComments(source), env);
    const sanitized = DOMPurify.sanitize(raw, PURIFY_CONFIG);
    const html = materializeTrustedTasks(sanitized, env.taskNonce);
    return {
        html,
        headings: env.headings,
        hasMath: env.hasMath,
        hasMermaid: env.hasMermaid,
        hasEmbeds: env.hasEmbeds,
        frontMatter: env.frontMatter,
        frontMatterErrors: env.frontMatterErrors,
    };
}

function stripObsidianComments(source: string): string {
    const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
    let inComment = false;
    let fenceChar = '';
    let fenceLength = 0;
    return lines.map((line) => {
        const ending = /\r\n$|[\r\n]$/.exec(line)?.[0] ?? '';
        const body = ending ? line.slice(0, -ending.length) : line;
        const fence = !inComment ? /^ {0,3}(`{3,}|~{3,})/.exec(body) : null;
        if (fence) {
            const marker = fence[1]!;
            if (!fenceChar) {
                fenceChar = marker[0]!;
                fenceLength = marker.length;
            }
            else if (marker[0] === fenceChar && marker.length >= fenceLength) {
                fenceChar = '';
                fenceLength = 0;
            }
            return line;
        }
        if (fenceChar)
            return line;
        // A line with neither marker cannot change state, so rebuild-by-character is pure
        // overhead. The inComment test must stay: inside an open %% block the loop below
        // blanks the line instead of copying it.
        if (!inComment && !body.includes('%') && !body.includes('`'))
            return line;
        let output = '';
        let inlineTicks = 0;
        for (let index = 0; index < body.length;) {
            if (body[index] === '`' && !inComment) {
                let end = index + 1;
                while (body[end] === '`')
                    end++;
                const ticks = end - index;
                if (!inlineTicks || inlineTicks === ticks)
                    inlineTicks = inlineTicks ? 0 : ticks;
                output += body.slice(index, end);
                index = end;
                continue;
            }
            const marker = body.startsWith('%%', index) && body[index - 1] !== '\\';
            if (marker && !inlineTicks) {
                inComment = !inComment;
                output += '  ';
                index += 2;
                continue;
            }
            output += inComment ? ' ' : body[index]!;
            index++;
        }
        return output + ending;
    }).join('');
}
export function parseWikiTarget(source: string): WikiTarget {
    const pipe = source.indexOf('|');
    const rawTarget = (pipe >= 0 ? source.slice(0, pipe) : source).trim();
    const alias = pipe >= 0 ? source.slice(pipe + 1).trim() || null : null;
    let noteTitle = rawTarget;
    let heading: string | null = null;
    let blockId: string | null = null;
    if (rawTarget.startsWith('^')) {
        noteTitle = '';
        blockId = rawTarget.slice(1);
    }
    else {
        const hash = rawTarget.indexOf('#');
        if (hash >= 0) {
            noteTitle = rawTarget.slice(0, hash).trim();
            const fragment = rawTarget.slice(hash + 1).trim();
            if (fragment.startsWith('^'))
                blockId = fragment.slice(1);
            else
                heading = fragment || null;
        }
    }
    return { raw: rawTarget, noteTitle, heading, blockId, alias };
}
function emptyEnvironment(): RenderEnvironment {
    const nonce = createNonce();
    return {
        headings: [],
        hasMath: false,
        hasMermaid: false,
        hasEmbeds: false,
        frontMatter: {},
        frontMatterErrors: [],
        taskNonce: nonce,
        tabSequence: 0,
        exampleSequence: 0,
        mindmapSequence: 0,
        docId: `ink-${nonce}`,
    };
}
function renderEnv(value: unknown): RenderEnvironment {
    return value as RenderEnvironment;
}
function createNonce(): string {
    const secureCrypto = globalThis.crypto;
    if (secureCrypto && typeof secureCrypto.randomUUID === 'function')
        return secureCrypto.randomUUID();
    if (secureCrypto && typeof secureCrypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        secureCrypto.getRandomValues(bytes);
        return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function materializeTrustedTasks(html: string, nonce: string): string {
    if (!html.includes('data-task-placeholder'))
        return html;
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll<HTMLElement>('[data-task-placeholder]').forEach((placeholder) => {
        if (placeholder.dataset.taskPlaceholder !== nonce)
            return;
        const line = placeholder.dataset.taskLine;
        if (!line || !/^\d+$/.test(line))
            return;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'task-list-item-checkbox';
        input.checked = placeholder.dataset.taskChecked === '1';
        if (input.checked)
            input.setAttribute('checked', '');
        if (placeholder.closest('.markdown-example-preview')) {
            input.disabled = true;
            input.setAttribute('aria-label', t("markdown.the_tasks_in_the_example_are_read_only"));
        }
        else {
            input.dataset.taskLine = line;
            input.setAttribute('aria-label', input.checked ? t("markdown.mark_incomplete") : t("markdown.mark_complete"));
        }
        placeholder.replaceWith(input);
    });
    return template.innerHTML;
}
function renderFrontMatterValue(value: unknown): string {
    if (value == null)
        return '<span class="frontmatter-empty">—</span>';
    if (Array.isArray(value)) {
        return value.map((item) => `<span class="frontmatter-chip">${escapeHtml(formatScalar(item))}</span>`).join('');
    }
    if (typeof value === 'object')
        return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
    return escapeHtml(formatScalar(value));
}
function formatScalar(value: unknown): string {
    if (value instanceof Date)
        return value.toISOString();
    return String(value);
}
function blockLine(state: {
    src: string;
    bMarks: number[];
    tShift: number[];
    eMarks: number[];
}, line: number): string {
    const from = state.bMarks[line]! + state.tShift[line]!;
    return state.src.slice(from, state.eMarks[line]!);
}
function findTabSegments(state: {
    src: string;
    bMarks: number[];
    tShift: number[];
    eMarks: number[];
}, start: number, end: number): Array<{
    title: string;
    start: number;
    end: number;
    selected: boolean;
}> {
    const directiveTabs = findDirectiveTabSegments(state, start, end);
    if (directiveTabs.length)
        return directiveTabs;
    const markers: Array<{
        line: number;
        title: string;
    }> = [];
    let fence: {
        char: string;
        length: number;
    } | null = null;
    for (let line = start; line < end; line++) {
        const text = blockLine(state, line);
        const fenceMatch = /^(`{3,}|~{3,})/.exec(text);
        if (fenceMatch) {
            const marker = fenceMatch[1]!;
            if (!fence)
                fence = { char: marker[0]!, length: marker.length };
            else if (marker[0] === fence.char && marker.length >= fence.length)
                fence = null;
            continue;
        }
        if (fence)
            continue;
        const tab = /^@tab[ \t]+(.+?)[ \t]*$/.exec(text);
        if (tab)
            markers.push({ line, title: stripBracketTitle(tab[1]!) || t("common.tabs") });
    }
    return markers.map((marker, index) => ({
        title: marker.title,
        start: marker.line + 1,
        end: markers[index + 1]?.line ?? end,
        selected: false,
    }));
}
function findDirectiveTabSegments(state: {
    src: string;
    bMarks: number[];
    tShift: number[];
    eMarks: number[];
}, start: number, end: number): Array<{
    title: string;
    start: number;
    end: number;
    selected: boolean;
}> {
    const tabs: Array<{ title: string; start: number; end: number; selected: boolean }> = [];
    for (let line = start; line < end;) {
        const match = TAB_ITEM_OPEN.exec(blockLine(state, line));
        if (!match) {
            line++;
            continue;
        }
        const fenceEnd = findColonFenceEnd(state, line + 1, end, match[1]!.length);
        // An item that never closes runs to the end of its own set, so the typed text stays
        // readable instead of discarding the whole group.
        const close = fenceEnd < 0 ? end : fenceEnd;
        let contentStart = line + 1;
        let selected = false;
        while (contentStart < close) {
            const option = /^:selected:?(?:[ \t]+[^\r\n]*)?$/i.exec(blockLine(state, contentStart));
            if (!option)
                break;
            selected = true;
            contentStart++;
        }
        if (contentStart < close && !blockLine(state, contentStart).trim())
            contentStart++;
        tabs.push({
            title: stripBracketTitle(match[2] ?? '') || t("common.tabs"),
            start: contentStart,
            end: close,
            selected,
        });
        line = close + 1;
    }
    return tabs;
}
function colonFenceMark(text: string): { length: number; opens: boolean } | null {
    const run = /^:{3,}/.exec(text);
    if (!run)
        return null;
    const rest = text.slice(run[0].length);
    if (!rest.trim())
        return { length: run[0]!.length, opens: false };
    // A recognised directive opens a container; an unknown `::: name` still has to hold its
    // own closer, or a directive the renderer does not know would steal its parent's close.
    if (COLON_CONTAINER_BODY.test(rest) || /^[ \t]*[A-Za-z][-\w]{0,31}/.test(rest))
        return { length: run[0]!.length, opens: true };
    return null;
}
function findColonFenceEnd(state: {
    src: string;
    bMarks: number[];
    tShift: number[];
    eMarks: number[];
}, start: number, end: number, markerLength: number): number {
    const open: number[] = [markerLength];
    let fence: { char: string; length: number } | null = null;
    for (let line = start; line < end; line++) {
        const text = blockLine(state, line);
        const codeFence = /^(`{3,}|~{3,})/.exec(text);
        if (codeFence) {
            const marker = codeFence[1]!;
            if (!fence)
                fence = { char: marker[0]!, length: marker.length };
            else if (marker[0] === fence.char && marker.length >= fence.length)
                fence = null;
            continue;
        }
        if (fence)
            continue;
        const mark = colonFenceMark(text);
        if (!mark)
            continue;
        if (mark.opens) {
            open.push(mark.length);
            continue;
        }
        // One closer line closes the innermost container it can serve, so a `:::` inside a
        // `::::` set ends that inner block instead of truncating its parent.
        for (let depth = open.length - 1; depth >= 0; depth--) {
            if (open[depth]! > mark.length)
                continue;
            open.length = depth;
            if (!open.length)
                return line;
            break;
        }
    }
    return -1;
}
function stripBracketTitle(value: string): string {
    const trimmed = value.trim();
    return /^\[[^\][\n]*\]$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}
function sourceLineAttribute(sourceLine: number | undefined): string {
    return sourceLine === undefined ? '' : ` data-line="${sourceLine}"`;
}
/**
 * The `::` lines that open a node, ignoring the ones inside a code fence or a nested `:::` block.
 * `colonFenceMark` decides what counts as a container line here too, so this scan and the one that
 * found the block's own end can never disagree about where a `:::` starts a level.
 */
function findTimelineNodeMarks(state: StateBlock, start: number, end: number): Array<{ line: number, head: string }> {
    const marks: Array<{ line: number, head: string }> = [];
    let fence: { char: string, length: number } | null = null;
    let nested = 0;
    for (let line = start; line < end; line++) {
        const text = blockLine(state, line);
        const codeFence = /^(`{3,}|~{3,})/.exec(text);
        if (codeFence) {
            const marker = codeFence[1]!;
            if (!fence)
                fence = { char: marker[0]!, length: marker.length };
            else if (marker[0] === fence.char && marker.length >= fence.length)
                fence = null;
            continue;
        }
        if (fence)
            continue;
        const container = colonFenceMark(text);
        if (container) {
            if (container.opens)
                nested++;
            else if (nested > 0)
                nested--;
            continue;
        }
        if (nested > 0)
            continue;
        const mark = TIMELINE_NODE_MARK.exec(text);
        if (mark)
            marks.push({ line, head: mark[1]!.trim() });
    }
    return marks;
}
function renderTimelineContainer(state: StateBlock, startLine: number, end: number, nextLine: number, info: string): void {
    const { title, options } = splitTimelineInfo(info);
    const marks = findTimelineNodeMarks(state, startLine + 1, end);
    const open = state.push('timeline_open', 'div', 1);
    open.block = true;
    open.map = [startLine, nextLine];
    open.meta = { title, options };
    const bodyStart = startLine + 1;
    const firstNode = marks[0]?.line ?? end;
    if (marks.length && hasTextBetween(state, bodyStart, firstNode)) {
        const intro = state.push('timeline_intro_open', 'div', 1);
        intro.block = true;
        intro.attrSet('class', 'markdown-timeline-intro');
        state.md.block.tokenize(state, bodyStart, firstNode);
        state.push('timeline_intro_close', 'div', -1).block = true;
    }
    if (marks.length) {
        const list = state.push('timeline_list_open', 'ol', 1);
        list.block = true;
        list.attrSet('class', 'markdown-timeline');
        list.attrSet('role', 'list');
        marks.forEach((mark, index) => {
            const item = state.push('timeline_item_open', 'li', 1);
            item.block = true;
            item.meta = { item: parseTimelineItem(mark.head), sourceLine: mark.line };
            const bodyFrom = state.tokens.length;
            state.md.block.tokenize(state, mark.line + 1, marks[index + 1]?.line ?? end);
            hardBreakOwnParagraphs(state.tokens, bodyFrom, state.tokens.length);
            state.push('timeline_item_close', 'li', -1).block = true;
        });
        state.push('timeline_list_close', 'ol', -1).block = true;
    }
    else {
        state.md.block.tokenize(state, bodyStart, end);
    }
    state.push('timeline_close', 'div', -1).block = true;
}
function hasTextBetween(state: StateBlock, start: number, end: number): boolean {
    for (let line = start; line < end; line++) {
        if (blockLine(state, line).trim())
            return true;
    }
    return false;
}
/**
 * A node is written as a stack of short lines that each mean something on their own, so the soft
 * breaks of its own paragraphs are raised to hard breaks. Only the paragraphs sitting directly in
 * the node are touched: a list, quote or table the author put there keeps the app-wide line rules.
 */
function hardBreakOwnParagraphs(tokens: Token[], from: number, to: number): void {
    let depth = 0;
    for (let index = from; index < to; index++) {
        const token = tokens[index]!;
        if (token.nesting === 1)
            depth++;
        if (depth === 1 && token.type === 'inline' && token.content.includes('\n'))
            token.content = raiseSoftBreaks(token.content);
        if (token.nesting === -1)
            depth--;
    }
}
function raiseSoftBreaks(content: string): string {
    return content.split('\n')
        .map((segment, index, all) =>
            index === all.length - 1 || endsWithHardBreak(segment) ? segment : `${segment}\\`)
        .join('\n');
}
function endsWithHardBreak(segment: string): boolean {
    if (/ {2,}$/.test(segment))
        return true;
    const trailingBackslash = /\\+$/.exec(segment)?.[0].length ?? 0;
    return trailingBackslash % 2 === 1;
}
function matchingClose(tokens: Token[], start: number, openType: string, closeType: string): number {
    let depth = 0;
    for (let index = start; index < tokens.length; index++) {
        if (tokens[index]!.type === openType)
            depth++;
        else if (tokens[index]!.type === closeType && --depth === 0)
            return index;
    }
    return -1;
}
function normalizeCalloutType(value: string): string {
    const type = value.toLowerCase();
    const aliases: Record<string, string> = {
        summary: 'abstract',
        tldr: 'abstract',
        hint: 'tip',
        important: 'tip',
        check: 'success',
        done: 'success',
        help: 'question',
        faq: 'question',
        caution: 'warning',
        attention: 'warning',
        fail: 'failure',
        missing: 'failure',
        error: 'danger',
        bug: 'danger',
        cite: 'quote',
    };
    return (aliases[type] ?? type.replace(/[^a-z0-9_-]/g, '')) || 'note';
}
function calloutDefaultTitle(type: string): string {
    const names: Record<string, string> = {
        note: t("markdown.note"),
        abstract: t("markdown.abstract"),
        info: t("markdown.info"),
        todo: t("markdown.todo"),
        tip: t("markdown.tip"),
        success: t("markdown.success"),
        question: t("markdown.question"),
        warning: t("markdown.warning"),
        failure: t("markdown.failure"),
        danger: t("markdown.danger"),
        example: t("markdown.example"),
        quote: t("common.quote"),
    };
    return names[type] ?? type;
}
function findOpeningToken(tokens: Token[], inlineIndex: number): Token | null {
    const previous = tokens[inlineIndex - 1];
    if (previous && ['paragraph_open', 'heading_open'].includes(previous.type))
        return previous;
    return null;
}
function expandBlockReferences(inline: Token, TokenConstructor: new (type: string, tag: string, nesting: -1 | 0 | 1) => Token): void {
    if (!inline.children)
        return;
    const expanded: Token[] = [];
    for (const child of inline.children) {
        if (child.type !== 'text' || !child.content.includes('((')) {
            expanded.push(child);
            continue;
        }
        let cursor = 0;
        const pattern = /\(\(([A-Za-z0-9][A-Za-z0-9_-]{0,63})\)\)/g;
        for (const match of child.content.matchAll(pattern)) {
            if (match.index! > cursor) {
                const textToken = new TokenConstructor('text', '', 0);
                textToken.content = child.content.slice(cursor, match.index);
                expanded.push(textToken);
            }
            const reference = new TokenConstructor('block_reference', 'a', 0);
            reference.content = match[1]!;
            expanded.push(reference);
            cursor = match.index! + match[0].length;
        }
        if (cursor < child.content.length) {
            const textToken = new TokenConstructor('text', '', 0);
            textToken.content = child.content.slice(cursor);
            expanded.push(textToken);
        }
    }
    inline.children = expanded;
}
function reparseInline(token: Token, content: string, markdown: MarkdownIt, env: unknown): void {
    const children: Token[] = [];
    markdown.inline.parse(content, markdown, env, children);
    token.content = content;
    token.children = children;
}
function setTokenAttribute(token: Token, name: string, value: string): void {
    if (name === 'class') {
        value.split(/\s+/).filter(Boolean).forEach((className) => appendTokenClass(token, className));
    }
    else {
        token.attrSet(name, value);
    }
}
function appendTokenClass(token: Token, className: string): void {
    const current = token.attrGet('class')?.split(/\s+/).filter(Boolean) ?? [];
    if (!current.includes(className))
        current.push(className);
    token.attrSet('class', current.join(' '));
}
function localizeFrontMatterError(error: string): string {
    if (error === 'Front Matter exceeds the 64 KiB safety limit')
        return t("markdown.front_matter_exceeds_the_64_kib_safety_limit");
    if (error === 'Front Matter root must be a YAML mapping')
        return t("markdown.the_front_matter_root_must_be_a_yaml_mapping");
    return getLocale() === 'zh-CN' ? t("markdown.invalid_yaml_check_indentation_quotes_and_duplicate_keys") : error;
}
function plainInline(token: Token): string {
    if (token.type !== 'inline' || !token.children)
        return token.content;
    return token.children
        .filter((child) => ['text', 'code_inline', 'inline_tag', 'wikilink', 'block_reference'].includes(child.type))
        .map((child) => child.content)
        .join('')
        .trim();
}
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
export function escapeAttr(text: string): string {
    return escapeHtml(text).replace(/'/g, '&#39;').replace(/\n/g, '&#10;');
}
