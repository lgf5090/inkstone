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
import { coverWidthFor, readNoteDecorations } from '@shared/property-decorations';
import type { DecorationDefaults, NotePropertyNames, PropertyImageValue } from '@shared/property-decorations';
import { ACCENT_COLOR_TOKEN, propertyColorCss, propertyPillCss, resolveProperties } from '@shared/property-style';
import type { PropertyResolveContext, PropertyStyleSettings, ResolvedProperty, ResolvedPropertyItem } from '@shared/property-style';
import {
    PP_COLUMN,
    PP_COUNT,
    PP_HEADER,
    PP_HEADER_BUTTON,
    PP_ICON_ROW,
    PP_KEY,
    PP_KEY_CELL,
    PP_KIND,
    PP_LAYOUT,
    PP_MARKDOWN,
    PP_NOTE,
    PP_OBJECT,
    PP_PILL,
    PP_PILLS,
    PP_PILL_HASH,
    PP_PILL_TEXT,
    PP_PILL_THEME,
    PP_ROW,
    PP_ROW_HIDDEN,
    PP_ROWS,
    PP_SCALAR,
    PP_SHELL,
    PP_SHELL_QUIET,
    PP_SWITCH,
    PP_SWITCH_KNOB,
    PP_SWITCH_KNOB_OFF,
    PP_SWITCH_KNOB_ON,
    PP_SWITCH_OFF,
    PP_SWITCH_ON,
    PP_TITLE,
    PP_VALUE,
    PP_VALUE_INNER,
    propertyKindGlyph,
    propertyRowCount,
} from '../property-markup';
import { getLocale, t, type MessageKey } from '../i18n';
import { parseEmbedSize, splitAltSize } from './attachments';
import { blockLine, colonFenceMark, findColonFenceEnd, scanRenderBody, type ColonLineSource } from './colon-fence';
import { effectiveTabsPosition, isVerticalTabsPosition, matchPanelHeader, parseTabsOptions } from './panel-options';
import type { TabsOptions } from './panel-options';
import { findColonTabSegments, renderAlignContainer, renderColsContainer } from './panels';
import type { TabSegment } from './panels';
import { emptyCrossrefRegistry, crossrefAnchor, crossrefLabel, lookupCrossref, nameCrossrefBlocks, readCrossrefName, splitCrossrefTail } from './crossref';
import type { CrossrefKind, CrossrefRegistry, CrossrefTokenMeta } from './crossref';
import { mediaBlockAttributes, mediaCellAttributes, mediaCellCaption, mediaRowAttributes, renderMediaContainer } from './media-block';
import type { MediaCellToken, MediaRowToken } from './media-block';
import type { MediaBlockOptions } from './media-layout';
import { encodeDataValue, escapeAttr, escapeHtml } from './data-attr';import { parseFenceInfo } from './fence-info';
import { readCodeOptions } from './code-options';
import { createFenceBodies, takeFenceIndex, type FenceBodies } from './fence-bodies';
// From the body module, not the kanban index: the index re-exports the React board, and a fence that
// only needs the language list and the mode must not pull the whole UI into the markdown chunk.
import { detectKanbanMode, KANBAN_LANGUAGES } from './kanban/body';
import { EXAMPLE_SPLIT_DEFAULTS, exampleRatioLabel, parseExampleSplit, type ExampleFamily } from './example-split';
import { isTimelineDateTime, parseTimelineItem, splitTimelineInfo } from './timeline-options';
import type { TimelineItem, TimelineOptions, TimelineStatus } from './timeline-options';
import { readFenceStyle } from './chart/style';
import { CHART_LANGUAGES } from './chart/body';
import { detectMindmapMode, MINDMAP_LANGUAGES } from './mindmap/body';
import { dataviewHostMarkup, dataviewModeOf } from '../dataview/body';
import { MINDMAP_THEME_ATTR, readFenceAnnotation } from './mindmap/theme';
import { emojiCharForCode, emojiUnicodeIsLoaded, requestEmojiUnicode } from '../emoji-unicode';
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
    /**
     * The fence bodies this markup was built from, one per rich block in document order. A board's
     * body is far too large to ride in a `data-*` attribute — every sanitizer pass and every
     * `innerHTML` write would re-walk it — so the host registers these on the element instead and the
     * block's `data-kanban-index` is the key back.
     */
    fences: FenceBodies;
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
    /** What `@fig:`, `@eq:` and `@tbl:` names resolve to, numbered in the order the document was written. */
    crossrefs: CrossrefRegistry;
    docId: string;
    hideFrontMatter?: boolean;
    properties?: PropertyRenderOptions;
    emojiShortcodes: boolean;
    fences: FenceBodies;
}
export interface PropertyRenderOptions {
    style: PropertyStyleSettings;
    names: NotePropertyNames;
    defaults: DecorationDefaults;
    revealHidden: boolean;
    hideHeader: boolean;
    hideWholeBlockWhenEmpty: boolean;
    iconInline: boolean;
    iconSize: number;
    bannerHeight: number;
    bannerFade: boolean;
    coverWidths: { width1: number, width2: number, width3: number };
    locale: string;
    now?: number;
    tagColorOf?: (name: string) => string | null;
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
    const properties = renderEnv(env).properties;
    if (!entries.length || renderEnv(env).hideFrontMatter)
        return '';
    if (properties?.style.enabled)
        return prettyFrontMatter(meta.data, properties);
    const rows = entries
        .map(([key, value]) => `<div class="frontmatter-row"><dt>${escapeHtml(key)}</dt><dd>${renderFrontMatterValue(value)}</dd></div>`)
        .join('');
    return `<details class="frontmatter-properties" data-line="0"><summary>${escapeHtml(t("markdown.properties"))}</summary><dl>${rows}</dl></details>`;
};
const COLON_CONTAINER_OPEN = /^(:{3,})[ \t]*(details|tabs|t|timeline)\b(?:[ \t]+(.*))?$/;
const COLON_DIRECTIVE_TABS = /^(:{3,})[ \t]*\{(tab-set)\}[ \t]*(.*)$/;
const TAB_ITEM_OPEN = /^(:{3,})(?:\{tab-item\}|[ \t]*tab-item)(?:[ \t]+(.*?))?[ \t]*$/;
const AT_TAB = /^@tab(?:(?::active|\+))?[ \t]+(.+?)[ \t]*$/;
const TIMELINE_NODE_MARK = /^::(?!:)[ \t]*(.*)$/;
const INTERRUPTS_CONTAINER_CHAIN = { alt: ['paragraph', 'reference', 'blockquote', 'list'] };
md.block.ruler.before('fence', 'modern_container', (state, startLine, endLine, silent) => {
    const source = blockLine(state, startLine);
    const legacyMatch = COLON_CONTAINER_OPEN.exec(source);
    const directiveMatch = COLON_DIRECTIVE_TABS.exec(source);
    // The panel header is tested last: `::: tabs` is a tab set, not a layout block, and the two
    // vocabularies must never disagree about which one a line opens.
    const panel = legacyMatch || directiveMatch ? null : matchPanelHeader(source);
    if (!legacyMatch && !directiveMatch && !panel)
        return false;
    const markerLength = legacyMatch?.[1].length ?? directiveMatch?.[1].length ?? panel!.markerLength;
    const fenceEnd = findColonFenceEnd(state, startLine + 1, endLine, markerLength);
    // Like an unclosed ``` fence, an unclosed container claims the rest of its own context
    // instead of throwing the author's text away.
    const end = fenceEnd < 0 ? endLine : fenceEnd;
    const nextLine = fenceEnd < 0 ? endLine : fenceEnd + 1;
    if (silent)
        return true;
    const kind = legacyMatch?.[2] ?? directiveMatch?.[2];
    if (panel) {
        if (panel.kind === 'align')
            renderAlignContainer(state, startLine, end, nextLine, panel.align);
        else if (panel.kind === 'media')
            renderMediaContainer(state, startLine, end, nextLine, panel.media, renderEnv(state.env).crossrefs);
        else
            renderColsContainer(state, startLine, end, nextLine, panel.cols);
    }
    else if (kind === 'timeline') {
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
        const rawInfo = (legacyMatch?.[3] ?? directiveMatch?.[3] ?? '').trim();
        renderTabsContainer(state, startLine, end, nextLine, rawInfo);
    }
    state.line = nextLine;
    return true;
}, INTERRUPTS_CONTAINER_CHAIN);
function renderTabsContainer(state: StateBlock, startLine: number, end: number, nextLine: number, rawInfo: string): void {
    const tabs = findTabSegments(state, startLine + 1, end);
    if (!tabs.length) {
        // A tab set without any tab-item still holds the author's content, so render
        // the body as ordinary blocks instead of consuming it.
        state.md.block.tokenize(state, startLine + 1, end);
        state.line = nextLine;
        return;
    }
    const env = renderEnv(state.env);
    const id = `${env.docId}-tabs-${++env.tabSequence}`;
    const selectedIndex = Math.max(0, tabs.findIndex((tab) => tab.selected));
    const openToken = state.push('tabs_open', 'div', 1);
    openToken.block = true;
    openToken.map = [startLine, nextLine];
    openToken.meta = { id, titles: tabs.map((tab) => tab.title), selectedIndex, options: parseTabsOptions(rawInfo) };
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
    const { id, titles, selectedIndex, options } = tokens[index]!.meta as {
        id: string;
        titles: string[];
        selectedIndex: number;
        options?: TabsOptions;
    };
    const opt = options ?? { style: 'horizontal' as const, variant: 'default' as const, align: 'start' as const };
    const buttons = titles
        .map((title, tabIndex) => `<button type="button" role="tab" id="${id}-tab-${tabIndex}" aria-controls="${id}-panel-${tabIndex}" aria-selected="${tabIndex === selectedIndex ? 'true' : 'false'}" tabindex="${tabIndex === selectedIndex ? '0' : '-1'}" data-tab-button="${tabIndex}">${escapeHtml(title)}</button>`)
        .join('');
    const position = effectiveTabsPosition(opt);
    const styleAttr = isVerticalTabsPosition(position) ? ' data-tabs-style="vertical"' : '';
    const variantAttr = opt.variant !== 'default' ? ` data-tabs-variant="${escapeAttr(opt.variant)}"` : '';
    const alignAttr = opt.align !== 'start' ? ` data-tabs-align="${escapeAttr(opt.align)}"` : '';
    const positionAttr = opt.position ? ` data-tabs-position="${escapeAttr(opt.position)}"` : '';
    const syncAttr = opt.sync ? ` data-tabs-sync="${escapeAttr(opt.sync)}"` : '';
    // The outer element is the containment context: a container query on the node that establishes its
    // own containment measures the *ancestor*, so the strip has to collapse inside a narrow split pane
    // from one level up.
    return `<div class="markdown-tabs-outer"><div class="markdown-tabs" data-tabs${styleAttr}${variantAttr}${alignAttr}${positionAttr}${syncAttr}${sourceLine === undefined ? '' : ` data-line="${sourceLine}"`}><div class="tab-list" role="tablist" aria-label="${escapeAttr(t("common.tabs"))}">${buttons}</div>`;
};
md.renderer.rules.tabs_close = () => '</div></div>';
md.renderer.rules.tab_panel_open = (tokens, index) => {
    const { id, tabIndex, selected } = tokens[index]!.meta as {
        id: string;
        tabIndex: number;
        selected: boolean;
    };
    return `<section class="tab-panel" role="tabpanel" id="${id}-panel-${tabIndex}" aria-labelledby="${id}-tab-${tabIndex}" data-tab-panel="${tabIndex}"${selected ? '' : ' hidden'}>`;
};
md.renderer.rules.tab_panel_close = () => '</section>';
md.renderer.rules.panel_align_open = (tokens, index) => {
    const sourceLine = tokens[index]!.map?.[0];
    const { align } = tokens[index]!.meta as {
        align: string;
    };
    return `<div class="markdown-align" data-align="${escapeAttr(align)}"${sourceLine === undefined ? '' : ` data-line="${sourceLine}"`}>`;
};
md.renderer.rules.panel_align_close = () => '</div>';
md.renderer.rules.panel_cols_open = (tokens, index) => {
    const sourceLine = tokens[index]!.map?.[0];
    const { options, count, tracks } = tokens[index]!.meta as {
        options: { gap: string; divider: boolean; align: string | null };
        count: number;
        tracks: string | null;
    };
    const attrs = [
        ` data-cols="${count}"`,
        options.gap === 'normal' ? '' : ` data-cols-gap="${escapeAttr(options.gap)}"`,
        options.divider ? ' data-cols-divider="true"' : '',
        options.align ? ` data-cols-align="${escapeAttr(options.align)}"` : '',
        tracks ? ` data-cols-tracks="${escapeAttr(tracks)}"` : '',
    ].join('');
    return `<div class="markdown-cols"${attrs}${sourceLine === undefined ? '' : ` data-line="${sourceLine}"`}>`;
};
md.renderer.rules.panel_cols_close = () => '</div>';
md.renderer.rules.panel_col_open = (tokens, index) => `<div class="markdown-col" data-col="${(tokens[index]!.meta as {
    index: number;
}).index}">`;
md.renderer.rules.panel_col_close = () => '</div>';
/**
 * The `::: media` layout block: one grid per source line, one cell per picture.
 *
 * Nothing here is a `style` attribute — the prose whitelist strips those — so every number travels as a
 * `data-media-*` value that the enhancer reads back into a CSS custom property after sanitization.
 */
function mediaFigureLabel(figure: number): string {
    return `${t("markdown.figure")} ${figure}`;
}
md.renderer.rules.media_open = (tokens, index) => {
    const meta = tokens[index]!.meta as {
        options: MediaBlockOptions;
        numbered: boolean;
        rows: number;
    };
    const line = tokens[index]!.map?.[0];
    return `<div ${mediaBlockAttributes(meta, escapeAttr)}${line === undefined ? '' : ` data-line="${line}"`}>`;
};
md.renderer.rules.media_close = () => '</div>';
md.renderer.rules.media_row_open = (tokens, index) => `<div ${mediaRowAttributes(tokens[index]!.meta as MediaRowToken, escapeAttr)}>`;
md.renderer.rules.media_row_close = () => '</div>';
md.renderer.rules.media_cell_open = (tokens, index) => `<div ${mediaCellAttributes(tokens[index]!.meta as MediaCellToken, escapeAttr)}>`;
md.renderer.rules.media_cell_close = (tokens, index) => {
    const meta = tokens[index]!.meta as MediaCellToken;
    const label = meta.figure === null ? null : mediaFigureLabel(meta.figure);
    return `${mediaCellCaption(meta, label, escapeHtml)}</div>`;
};
md.renderer.rules.crossref_ref = (tokens, index, _options, env) => {
    const { kind, name } = tokens[index]!.meta as CrossrefRefToken;
    const entry = lookupCrossref(renderEnv(env).crossrefs, kind, name);
    // A reference to a name the note never gave says so in the author's own spelling rather than inventing
    // a number, because a wrong number is a claim about somebody else's document.
    if (entry === null)
        return escapeHtml(`@${kind}:${name}`);
    const anchor = crossrefAnchor(kind, name);
    return `<a class="figure-reference" data-block-ref="${escapeAttr(anchor)}" href="#%5E${escapeAttr(anchor)}">${escapeHtml(crossrefLabel(entry))}</a>`;
};
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
    // A name written after the closing `$$` is taken off the line before the fence is looked for, or the
    // block would not be recognised at all and the author would read their own equation as a paragraph.
    const opened = splitCrossrefTail(blockLine(state, startLine));
    if (!/^\$\$/.test(opened.body))
        return false;
    let marker = opened.marker;
    const firstLine = opened.body.slice(2);
    let content = '';
    let next = startLine;
    let found = false;
    if (firstLine.trim().endsWith('$$')) {
        content = firstLine.trim().slice(0, -2);
        found = true;
    }
    else {
        while (!found && ++next < endLine) {
            const closed = splitCrossrefTail(blockLine(state, next));
            const text = closed.body;
            if (text.trim().endsWith('$$')) {
                content += text.slice(0, text.lastIndexOf('$$'));
                if (closed.marker !== null)
                    marker = closed.marker;
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
    token.content = marker === null ? content.trim() : `${content.trim()} ${marker}`;
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
    const body = `<div class="math-block"${line} data-math="${escapeAttr(encodeDataValue(token.content))}"></div>`;
    const entry = (token.meta as CrossrefTokenMeta | null)?.crossref;
    if (entry === undefined)
        return body;
    // A named equation is the equation and its number on one line: the number is what every `@eq:` in the
    // note says, so it is shown rather than kept as a target only a jump can find.
    const anchor = crossrefAnchor('eq', entry.name);
    return `<div class="math-equation" id="${escapeAttr(`^${anchor}`)}" data-block-id="${escapeAttr(anchor)}" data-crossref="${escapeAttr(entry.kind)}">${body}<span class="math-equation-number">${escapeHtml(crossrefLabel(entry))}</span></div>`;
};
const WIKI_RE = /^\[\[([^\[\]\n]{1,400})\]\]/;
const EMBED_RE = /^!\[\[([^\[\]\n]{1,400})\]\]/;
const BLOCK_REF_RE = /^\(\(([A-Za-z0-9][A-Za-z0-9_-]{0,63})\)\)/;
const CROSSREF_REF_RE = /^@(fig|eq|tbl):([A-Za-z0-9][A-Za-z0-9_-]{0,63})/;
interface CrossrefRefToken {
    kind: CrossrefKind;
    name: string;
}
const TAG_RE = /^#([\p{L}\p{N}_\-/·]{1,60})(?![\p{L}\p{N}_\-/·])/u;
const EMOJI_CODE_RE = /^:([A-Za-z0-9_+-]{2,30}):/;
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
// A cross-reference names the block it points at — a figure, an equation, a table — the way
// pandoc-crossref spells it, so the `:` is what tells `@fig:beach` from an at-handle somebody typed. The
// guard keeps it out of the middle of a word and out of an e-mail, where a reference would be a surprise
// rather than a spelling.
md.inline.ruler.before('text', 'crossref_ref', (state, silent) => {
    if (state.src[state.pos] !== '@')
        return false;
    const previous = state.pos > 0 ? state.src[state.pos - 1]! : ' ';
    if (/[\w@/.-]/.test(previous))
        return false;
    const match = CROSSREF_REF_RE.exec(state.src.slice(state.pos));
    if (!match || !readCrossrefName(match[2]!))
        return false;
    if (!silent) {
        const token = state.push('crossref_ref', 'a', 0);
        token.markup = `@${match[1]!}:`;
        token.meta = { kind: match[1] as CrossrefKind, name: match[2]! } satisfies CrossrefRefToken;
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
md.inline.ruler.before('text', 'emoji_shortcode', (state, silent) => {
    if (state.src[state.pos] !== ':')
        return false;
    if (!renderEnv(state.env).emojiShortcodes)
        return false;
    const source = state.src;
    // A code is a word, so it starts where a word does: after a space, a bracket, or another code.
    // That is what keeps `12:30:00` and `1:100:1` a clock and a ratio, and a colon inside a `:::`
    // run belongs to the container syntax rather than to anybody's name.
    if (source[state.pos - 1] === ':' && source[state.pos - 2] === ':')
        return false;
    if (/[\p{L}\p{N}_]/u.test(source[state.pos - 1] ?? ''))
        return false;
    const match = EMOJI_CODE_RE.exec(source.slice(state.pos));
    if (!match)
        return false;
    const glyph = emojiCharForCode(match[1]!);
    if (!glyph) {
        // The set is a lazy chunk, so a document that speaks in codes is the request for it. The
        // answer this parse gives is the literal text; the version signal re-renders once it lands.
        if (!emojiUnicodeIsLoaded())
            requestEmojiUnicode();
        return false;
    }
    if (!silent) {
        const token = state.push('text', '', 0);
        token.content = glyph;
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
// Equations and tables name themselves here, after every block rule has had its turn and before a single
// inline token is parsed: a `{#tbl:x}` line below a table is a paragraph until this takes it away, and a
// reference above the thing it points at has to be able to resolve.
md.core.ruler.before('inline', 'crossref_anchors', (state) => {
    nameCrossrefBlocks(state.tokens, renderEnv(state.env).crossrefs);
    return true;
});
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
        // One set for the whole document: a markup string carries no per-subtree registration once it
        // is re-parsed, so a board inside an example answers to the outer numbering.
        childEnv.fences = parentEnv.fences;
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
    if (dataviewModeOf(info.language)) {
        // A query block answers from other notes, which are behind a store and a throttled endpoint, so
        // the fence emits an empty host and `renderDataviewBlocks` fills it in after the render.
        return dataviewHostMarkup(dataviewModeOf(info.language)!, line, token.content);
    }
    if ((KANBAN_LANGUAGES as readonly string[]).includes(info.language)) {
        // The body goes to the render's fence set rather than into an attribute: a two-hundred-card
        // board is ~17 KB of encoded text that every sanitizer pass and every innerHTML write would
        // walk again on each keystroke. `data-kanban-index` is the key back, and the host that
        // inserts this markup registers the set on the element holding it.
        const env = renderEnv(rendererEnv);
        const index = takeFenceIndex(env.fences, 'kanban', token.content);
        const mode = detectKanbanMode(token.content);
        const fullscreenLabel = escapeAttr(t("preview.kanban_fullscreen"));
        return [
            `<div class="kanban-block loading"${line} data-kanban="" data-kanban-index="${index}" aria-busy="true">`,
            // No board name here: it lives in the fence body, which this markup would have to parse a
            // second time to read. The registry, which has the parsed body, names the head instead.
            `<div class="kanban-block-head">`,
            `<span class="kanban-block-mode">${escapeHtml(mode)}</span>`,
            `<span class="kanban-block-actions">`,
            `<button type="button" class="kanban-block-btn" data-kanban-fullscreen aria-label="${fullscreenLabel}" title="${fullscreenLabel}"></button>`,
            `</span>`,
            `</div>`,
            `<div class="kanban-block-placeholder" data-kanban-placeholder>${escapeHtml(t("preview.kanban_loading"))}</div>`,
            `</div>`,
        ].join('');
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
    const token = tokens[index]!;
    const line = token.map ? ` data-line="${token.map[0]}"` : '';
    const entry = (token.meta as CrossrefTokenMeta | null)?.crossref;
    if (entry === undefined)
        return `<div class="table-wrap"${line}><table>`;
    // A named table is captioned with the number its references quote; the caption is the table's own, so
    // a screen reader and a printed page both carry it without anybody having to write a paragraph.
    const anchor = crossrefAnchor('tbl', entry.name);
    return `<div class="table-wrap"${line} id="${escapeAttr(`^${anchor}`)}" data-block-id="${escapeAttr(anchor)}" data-crossref="${escapeAttr(entry.kind)}"><table><caption class="markdown-table-caption">${escapeHtml(crossrefLabel(entry))}</caption>`;
};
md.renderer.rules.table_close = () => '</table></div>';
const CELL_ALIGNMENTS = new Set(['left', 'center', 'right']);
/**
 * Turn a table cell's alignment into a class.
 *
 * markdown-it writes the alignment an author asked for as `style="text-align:…"`, and `style` is on
 * the sanitizer's forbid list on purpose — a note can hold anything, so no inline declaration from
 * note text reaches the page. Without this swap the `:-:` of a delimiter row was parsed, honored by
 * the tokenizer and then thrown away, so every aligned column rendered flush-left. A class costs
 * nothing to allow and is styled by the prose sheet beside the table rules.
 */
for (const rule of ['th_open', 'td_open'] as const) {
    const fallback = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens, index, options, env, self) => {
        const token = tokens[index]!;
        const declared = /^text-align:(\w+)$/.exec(token.attrGet('style') ?? '')?.[1] ?? '';
        if (!CELL_ALIGNMENTS.has(declared))
            return fallback ? fallback(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
        const declaredAttrs = token.attrs!;
        token.attrs = declaredAttrs.filter(([name]) => name !== 'style');
        token.attrJoin('class', `markdown-cell-${declared}`);
        const html = self.renderToken(tokens, index, options);
        token.attrs = declaredAttrs;
        return html;
    };
}
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
        'data-kanban',
        'data-kanban-index',
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
        'data-dataview',
        'data-dataview-mode',
        'data-dataview-body',
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

const COLOR_ONLY_STYLE = /^(?:color|background(?:-color)?):\s*#[0-9a-fA-F]{3,8}$/i;
const COLOR_STYLE_TAGS = new Set(['FONT', 'MARK', 'SPAN', 'U', 'SUP', 'SUB']);

/**
 * The document pipeline, on its own purify instance so the one exemption below cannot reach the
 * outline label or the Mermaid SVG through the shared hooks.
 *
 * A colour the toolbar wrote is the only inline style a note may carry: one declaration, one plain
 * hex, on a tag that holds text. Everything else — a `url()`, a second declaration, a `position` —
 * is still dropped, so the blanket ban on `style` in {@link PURIFY_CONFIG} keeps its teeth.
 */
const colorStylePurify = typeof window === 'undefined' ? DOMPurify : DOMPurify(window);
colorStylePurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style' && COLOR_STYLE_TAGS.has(node.nodeName) && COLOR_ONLY_STYLE.test(data.attrValue))
        data.forceKeepAttr = true;
});

function sanitizeDocument(html: string): string {
    return colorStylePurify.sanitize(html, PURIFY_CONFIG);
}
export interface MarkdownBlock {
    startLine: number;
    endLine: number;
    html: string;
}

const OUTLINE_LABEL_CONFIG = {
    ALLOWED_TAGS: ['strong', 'b', 'em', 'i', 's', 'del', 'code', 'kbd', 'samp', 'mark', 'sub', 'sup', 'u', 'span'],
    ALLOWED_ATTR: [] as string[],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
};

/**
 * Renders one heading's inline markdown for the outline.
 *
 * The label sits inside a `<button>`, so links, images and every attribute are dropped rather than
 * nested: DOMPurify unwrites a forbidden tag and keeps its text, which is the reading the row wants.
 */
export function renderOutlineLabel(source: string): string {
    const env = emptyEnvironment();
    return DOMPurify.sanitize(md.renderInline(stripObsidianComments(source), env), OUTLINE_LABEL_CONFIG);
}

/** One property value rendered as inline Markdown through the document's own whitelist. */
export function renderInlineProperty(source: string, emojiShortcodes = true): string {
    const env = emptyEnvironment();
    env.emojiShortcodes = emojiShortcodes;
    return sanitizeDocument(md.renderInline(stripObsidianComments(source), env));
}

/** Parse once with the full document environment so reference links retain their targets. */
export function renderMarkdownBlocks(source: string, options?: { emojiShortcodes?: boolean, hideFrontMatter?: boolean, properties?: PropertyRenderOptions }): { blocks: MarkdownBlock[]; headings: Heading[]; fences: FenceBodies } {
    const env = emptyEnvironment();
    env.emojiShortcodes = options?.emojiShortcodes ?? true;
    env.hideFrontMatter = options?.hideFrontMatter === true;
    env.properties = options?.properties;
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
        return { blocks, headings: env.headings, fences: env.fences };
    const marker = `${env.taskNonce}:`;
    const frame = document.createElement('template');
    frame.innerHTML = materializeTrustedTasks(sanitizeDocument(groups.map((group, index) => `<div data-render-group="${marker}${index}">${group.raw}</div>`).join('')), env.taskNonce);
    for (const child of Array.from(frame.content.children)) {
        const key = (child as HTMLElement).dataset?.renderGroup;
        if (typeof key !== 'string' || !key.startsWith(marker))
            continue;
        const group = groups[Number(key.slice(marker.length))];
        const html = child.innerHTML;
        if (group && html.trim())
            blocks.push({ startLine: group.startLine, endLine: group.endLine, html });
    }
    return { blocks, headings: env.headings, fences: env.fences };
}

export function renderMarkdown(source: string, options?: { hideFrontMatter?: boolean, emojiShortcodes?: boolean, properties?: PropertyRenderOptions }): RenderResult {
    const env = emptyEnvironment();
    env.hideFrontMatter = options?.hideFrontMatter === true;
    env.properties = options?.properties;
    env.emojiShortcodes = options?.emojiShortcodes ?? true;
    const raw = md.render(stripObsidianComments(source), env);
    const sanitized = sanitizeDocument(raw);
    const html = materializeTrustedTasks(sanitized, env.taskNonce);
    return {
        html,
        headings: env.headings,
        hasMath: env.hasMath,
        hasMermaid: env.hasMermaid,
        hasEmbeds: env.hasEmbeds,
        frontMatter: env.frontMatter,
        frontMatterErrors: env.frontMatterErrors,
        fences: env.fences,
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
        crossrefs: emptyCrossrefRegistry(),
        docId: `ink-${nonce}`,
        emojiShortcodes: true,
        fences: createFenceBodies(),
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
const HEX_ONLY = /^#[0-9a-f]{6}$/i;

interface Paint {
    style: string;
    extraClass: string;
    extraAttr: string;
}

const NO_PAINT: Paint = { style: '', extraClass: '', extraAttr: '' };

/**
 * How one stored colour travels into the markup.
 *
 * The document pipeline bans `style` outright and exempts exactly one declaration of one plain hex on
 * a text-bearing tag, so a hex goes inline and the accent token goes as a hook the stylesheet paints
 * (`.pp-text-token`, `.pp-pill[data-pp-token]`). Both resolve to the same colour the reading pane's
 * panel sets through the CSSOM, where no sanitizer is involved. Anything else paints nothing here and
 * nothing there either.
 */
function prettyPaint(role: 'color' | 'background-color', stored: string | null | undefined): Paint {
    if (!stored)
        return NO_PAINT;
    if (stored === ACCENT_COLOR_TOKEN)
        return role === 'color'
            ? { style: '', extraClass: ' pp-text-token', extraAttr: '' }
            : { style: '', extraClass: '', extraAttr: ' data-pp-token="accent"' };
    if (!HEX_ONLY.test(stored))
        return NO_PAINT;
    const css = role === 'color' ? propertyColorCss(stored) : propertyPillCss(stored);
    return { style: ` style="${escapeAttr(`${role}:${css}`)}"`, extraClass: '', extraAttr: '' };
}

function prettySwitch(row: ResolvedProperty): string {
    const on = Boolean(row.value);
    return `<span role="switch" aria-checked="${on}" class="${PP_SWITCH} ${on ? PP_SWITCH_ON : PP_SWITCH_OFF}"><span class="${PP_SWITCH_KNOB} ${on ? PP_SWITCH_KNOB_ON : PP_SWITCH_KNOB_OFF}"></span></span>`;
}

function prettyProgress(row: ResolvedProperty): string {
    const progress = row.progress;
    if (!progress)
        return '';
    const label = escapeAttr(`${row.items[0]?.raw ?? ''} / ${progress.max} · ${progress.percent}%`);
    if (progress.variant === 'circle')
        return `<span class="pp-progress-circle" role="img" data-pp-percent="${progress.percent}%" aria-label="${label}"></span>`;
    return `<progress class="pp-progress" max="${escapeAttr(String(progress.max))}" value="${escapeAttr(String(progress.value))}" aria-label="${label}" title="${progress.percent}%"></progress>`;
}

function prettyPill(item: ResolvedPropertyItem, row: ResolvedProperty): string {
    const background = prettyPaint('background-color', item.pillSlot === 'color' ? item.pill : null);
    const colour = prettyPaint('color', item.textSlot === 'color' ? item.textColor : null);
    const themed = item.pillSlot === 'theme' ? ` ${PP_PILL_THEME}` : '';
    const wrapper = ` class="${PP_PILL}${background.extraClass}${item.pillSlot === 'transparent' ? ' pp-pill-transparent' : ''}"${background.style}${background.extraAttr}`;
    const label = row.kind === 'tags' ? item.raw : item.display;
    const inner = row.kind === 'tags'
        ? `<span${wrapper}><span class="${PP_PILL_TEXT}${themed}" data-property-pill-value="${escapeAttr(item.raw)}"><span class="${PP_PILL_HASH}">#</span><span${colour.extraClass ? ` class="${colour.extraClass.trim()}"` : ''}${colour.style}>${escapeHtml(label)}</span></span></span>`
        : `<span${wrapper}><span class="${PP_PILL_TEXT}${themed}${colour.extraClass}"${colour.style}>${escapeHtml(label)}</span></span>`;
    return inner;
}

function prettyValueCell(row: ResolvedProperty): string {
    if (row.kind === 'boolean')
        return prettySwitch(row);
    if (row.kind === 'tags' || row.kind === 'array')
        return `<span class="${PP_PILLS}">${row.items.map(item => prettyPill(item, row)).join('')}</span>`;
    if (row.kind === 'object')
        return `<span class="${PP_OBJECT}">${escapeHtml(row.display)}</span>`;
    const item = row.items[0];
    const value = item?.raw ?? '';
    const formatted = !!item && item.display !== item.raw;
    const stamp = ` data-property-value="${escapeAttr(value)}"${formatted ? ` data-property-format="template" title="${escapeAttr(value)}"` : ''}`;
    if (row.markdown)
        return `<div class="${PP_VALUE_INNER}"><span class="${PP_MARKDOWN}"${stamp} title="${escapeAttr(value)}">${renderInlineProperty(value)}</span></div>`;
    const background = prettyPaint('background-color', item?.pillSlot === 'color' ? item.pill : null);
    const colour = prettyPaint('color', item?.textSlot === 'color' ? item.textColor : null);
    const label = escapeHtml(item?.display || t('properties.empty_value'));
    const text = colour.style || colour.extraClass
        ? `<span class="${colour.extraClass.trim()}"${colour.style}>${label}</span>`
        : label;
    return `<div class="${PP_VALUE_INNER}">${prettyProgress(row)}<span class="${PP_SCALAR}${background.extraClass}"${background.style}${background.extraAttr}${stamp}>${text}</span></div>`;
}

function prettyRow(row: ResolvedProperty): string {
    const cls = `${PP_ROW}${row.hidden ? ` ${PP_ROW_HIDDEN}` : ''}`;
    const hidden = row.hidden ? ' data-property-hidden="true"' : '';
    return `<div class="${cls}"${hidden} data-property-key="${escapeAttr(row.key)}"><div class="${PP_KEY_CELL}"><span aria-hidden="true" class="${PP_KIND}">${propertyKindGlyph(row)}</span><span class="${PP_KEY}">${escapeHtml(row.key)}</span></div><div class="${PP_VALUE}">${prettyValueCell(row)}</div></div>`;
}

function prettyImageMarkup(image: PropertyImageValue, className: string): string {
    const alt = escapeAttr(image.alt);
    if (image.source.kind === 'url')
        return `<img class="${className}" src="${escapeAttr(image.source.url)}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    return `<div class="note-embed loading" data-embed-target="${escapeAttr(encodeDataValue(image.source.name))}"><span class="note-embed-head">${escapeHtml(image.source.name)}</span><div class="note-embed-body" aria-busy="true">${escapeHtml(t('common.loading'))}</div></div>`;
}

function prettyFrontMatter(data: Record<string, unknown>, options: PropertyRenderOptions): string {
    const context: PropertyResolveContext = {
        locale: options.locale,
        now: options.now ?? Date.now(),
        tagColorOf: options.tagColorOf,
    };
    const rows = resolveProperties(data, options.style, context);
    const shown = options.revealHidden ? rows : rows.filter(row => !row.hidden);
    const decorations = readNoteDecorations(data, options.names, options.defaults);
    const icon = decorations.icon
        ? `<span class="pp-icon ${options.iconInline ? 'is-inline' : 'is-block'}" data-pp-icon-size="${options.iconSize}">${decorations.icon.icon.kind === 'glyph' ? escapeHtml(decorations.icon.icon.text) : prettyImageMarkup(decorations.icon.icon.image, 'pp-icon-image')}</span>`
        : '';
    const header = options.hideHeader ? '' : `<summary class="${PP_HEADER}"><span class="${PP_HEADER_BUTTON}">${options.iconInline ? icon : ''}<span class="pp-chevron" aria-hidden="true"></span><span class="${PP_TITLE}">${escapeHtml(t('markdown.properties'))}</span><span class="${PP_COUNT}">${propertyRowCount(shown)}</span></span></summary>`;
    const note = shown.length
        ? shown.map(prettyRow).join('')
        : `<div class="${PP_NOTE}">${escapeHtml(t(rows.length ? 'properties.all_hidden' : 'properties.empty'))}</div>`;
    const iconRow = options.iconInline || !icon ? '' : `<div class="${PP_ICON_ROW}">${icon}</div>`;
    const column = `<details class="frontmatter-properties pp ${PP_COLUMN}" open>${iconRow}${header}<div class="${PP_ROWS}">${note}</div></details>`;
    const cover = decorations.cover
        ? `<div class="pp-cover is-${decorations.cover.position} is-${decorations.cover.shape}" data-pp-cover-width="${coverWidthFor(options.coverWidths, decorations.cover.shape)}">${prettyImageMarkup(decorations.cover.image, 'pp-cover-image')}</div>`
        : '';
    const banner = decorations.banner && decorations.banner.image.source.kind === 'url'
        ? `<div class="pp-banner" data-pp-banner-height="${options.bannerHeight}" data-pp-banner-position="${decorations.banner.positionPercent}"><img class="pp-banner-image" src="${escapeAttr(decorations.banner.image.source.url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">${options.bannerFade ? '<span class="pp-banner-fade" aria-hidden="true"></span>' : ''}</div>`
        : '';
    const quiet = options.hideWholeBlockWhenEmpty && !shown.length;
    const layout = `<div class="${PP_LAYOUT}" data-cover-position="${decorations.cover?.position ?? options.defaults.coverPosition}">${cover}${column}</div>`;
    return `<section class="${PP_SHELL}${quiet ? ` ${PP_SHELL_QUIET}` : ''}" data-note-properties data-line="0">${banner}${quiet ? '' : layout}</section>`;
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
function findTabSegments(state: ColonLineSource, start: number, end: number): TabSegment[] {
    const directiveTabs = findDirectiveTabSegments(state, start, end);
    if (directiveTabs.length)
        return directiveTabs;
    const markers: Array<{
        line: number;
        title: string;
        selected: boolean;
    }> = [];
    for (const entry of scanRenderBody(state, start, end)) {
        if (entry.depth > 0 || entry.fence)
            continue;
        const tab = AT_TAB.exec(entry.text);
        if (tab)
            markers.push({ line: entry.line, title: stripBracketTitle(tab[1]!) || t("common.tabs"), selected: /^@tab(?::active|\+)(?:[ \t]|$)/.test(entry.text) });
    }
    if (markers.length) {
        return markers.map((marker, index) => ({
            title: marker.title,
            start: marker.line + 1,
            end: markers[index + 1]?.line ?? end,
            selected: marker.selected,
        }));
    }
    // The `::` spelling is the last reader, so a note that mixes it with `@tab` keeps the markers
    // the author wrote rather than gaining a panel for every line that merely begins with two colons.
    return findColonTabSegments(state, start, end).map((tab) => ({ ...tab, title: stripBracketTitle(tab.title) || t("common.tabs") }));
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
// The escapers live in `./data-attr` so a fence module can build markup without importing this file
// back; they are re-exported here because every existing caller reaches for them on the renderer.
export { escapeAttr, escapeHtml };
