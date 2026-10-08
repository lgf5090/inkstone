/**
 * Inline Dataview: a `[key:: value]` field shown as a labelled chip, and a `= expression` line answered
 * where it is written.
 *
 * This is a DOM pass over already-rendered prose, not a Markdown rule, for two reasons. The first is
 * reach: the same pass runs over the split preview, the live-preview block, the note card and a share
 * page, and a markdown-it rule would have to be taught each of those surfaces' own guards. The second is
 * that the answer depends on the note's own properties, which only exist once the note is parsed — and
 * a Markdown rule runs before the block is even in the document.
 *
 * The pass does not read inside a front-matter table or a query block's own answer, and it leaves fenced
 * code alone unless the reader turned that on — a fenced example that demonstrates `[due:: 2024-05-06]`
 * stays the literal text the author wrote.
 */

import { appendValue, renderInlineText } from './render'
import { extractFullLineField, extractInlineFields } from './metadata'
import { parseField, parseInlineValue } from './expression'
import { Context } from './context'
import { encodeDataValue } from '../markdown/data-attr'
import { Values, type DataObject, type Literal } from './value'
import type { QueryRuntimeSettings } from './functions'
import type { RenderContext } from './render'

const PROSE_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote > p, td, th'
/** A fenced code block is prose for a query only when the reader asked for it; a code span never is. */
const CODE_PROSE_SELECTOR = `${PROSE_SELECTOR}, pre > code`
/** Subtrees that are never prose, whatever the settings say. */
const OWNED_SELECTOR = '.dataview-block, .frontmatter-properties, .dataview-inline-field, .dataview-inline-query, .dataview-inline-js'
const MARKER = 'dataviewInline'
const JS_MARKER = 'dataviewInlineJs'

export interface InlineContext {
    settings: QueryRuntimeSettings
    /** The note the prose belongs to, which is what `this.file.name` and a bare `rating` read. */
    data: DataObject | null
    linkHandler: Context['linkHandler']
    fields: boolean
    queries: boolean
    /** True when `= …` may also be answered inside a fenced code block. */
    codeblocks?: boolean
    /** The prefix that makes a line an inline JavaScript query; empty or absent means the feature is off. */
    jsPrefix?: string
}

/** Whether a node's text is prose this pass may rewrite, walking up to the nearest deciding ancestor. */
function skippedBy(element: HTMLElement, context: InlineContext, forQuery: boolean): boolean {
    let node: HTMLElement | null = element
    while (node) {
        if (node.matches(OWNED_SELECTOR)) return true
        if (node.tagName === 'CODE') {
            const inFence = forQuery && context.codeblocks && node.parentElement?.tagName === 'PRE'
            if (!inFence) return true
        } else if (node.tagName === 'PRE' && !(forQuery && context.codeblocks)) return true
        node = node.parentElement
    }
    return false
}

/** The renderer only needs the two halves a value render reads, not the evaluator or the row. */
function renderContextFor(context: InlineContext): RenderContext {
    const file = context.data?.file as DataObject | undefined
    return { settings: context.settings, originPath: typeof file?.path === 'string' ? file.path : null }
}

/**
 * Re-answer the inline lines that were computed while the note had no page yet. Their source expression
 * is kept on the answer, because the line it came from is no longer in the DOM.
 */
export function rerunInlineQueries(root: ParentNode, context: InlineContext): void {
    if (!context.queries) return
    const engine = new Context({ linkHandler: context.linkHandler, settings: context.settings })
    const scope = context.data ? { ...context.data, this: context.data as Literal } : {}
    for (const element of root.querySelectorAll<HTMLElement>('[data-dataview-pending]')) {
        const body = element.dataset.dataviewPending ?? ''
        delete element.dataset.dataviewPending
        let result: ReturnType<Context['attempt']>
        try {
            result = engine.attempt(parseField(body), scope)
        } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        if (!context.data) {
            element.dataset.dataviewPending = body
            continue
        }
        element.className = result.ok ? 'dataview-inline-query' : 'dataview-inline-error'
        element.replaceChildren()
        if (result.ok) renderInlineText(element, Values.toString(result.value, context.settings, context.settings.locale), renderContextFor(context))
        else {
            element.setAttribute('title', result.error)
            element.textContent = context.settings.renderNullAs || '—'
        }
    }
}

/** Apply both inline features under `root`. Idempotent: a node once processed is skipped. */
export function renderDataviewInline(root: ParentNode, context: InlineContext): void {
    const engine = new Context({ linkHandler: context.linkHandler, settings: context.settings })
    const scope = context.data ? { ...context.data, this: context.data as Literal } : {}
    for (const element of root.querySelectorAll<HTMLElement>(context.codeblocks ? CODE_PROSE_SELECTOR : PROSE_SELECTOR)) {
        if (element.dataset[MARKER]) continue
        element.dataset[MARKER] = '1'
        const queryable = context.queries && !skippedBy(element, context, true)
        const fieldable = context.fields && !skippedBy(element, context, false)
        if (!queryable && !fieldable) continue
        if (queryable && applyInlineQuery(element, engine, scope, context)) continue
        if (fieldable) applyInlineFields(element, context)
    }
}

/**
 * Replace every `$= …` line with an empty placeholder, in document order, and hand the placeholders back
 * with the code each one carries. The answer needs the worker, which this module deliberately does not
 * know about, so `blocks.ts` is the one that fills them in.
 */
export function takeInlineJsLines(root: ParentNode, context: InlineContext, limit: number): HTMLElement[] {
    if (!context.jsPrefix) return []
    const marks: HTMLElement[] = []
    for (const element of root.querySelectorAll<HTMLElement>(context.codeblocks ? CODE_PROSE_SELECTOR : PROSE_SELECTOR)) {
        if (element.dataset[JS_MARKER]) continue
        element.dataset[JS_MARKER] = '1'
        if (marks.length >= limit) break
        if (skippedBy(element, context, true)) continue
        const nodes = textNodes(element, context, true)
        let cursor = 0
        const ranges = nodes.map((node) => {
            const length = (node.nodeValue ?? '').length
            const range = { node, start: cursor, end: cursor + length }
            cursor += length
            return range
        })
        const full = nodes.map((node) => node.nodeValue ?? '').join('')
        const lead = leadLine(full, context.jsPrefix)
        if (!lead) continue
        const whole = full.trim() === lead[0].trim()
        const hit = ranges.find((range) => range.start <= lead.index && lead.index + lead[0].length <= range.end)
        if (!whole && !hit) continue
        const code = lead[1]!.trim()
        if (!code) continue
        const mark = document.createElement('span')
        mark.className = 'dataview-inline-js loading'
        mark.setAttribute('aria-busy', 'true')
        // The line stays readable as its own code until the worker answers, which is what a reader who
        // just typed it expects to see — an empty gap reads as a lost line.
        mark.textContent = code
        mark.dataset.dataviewJs = encodeDataValue(code)
        const text = hit && !whole ? hit.node.nodeValue ?? '' : full
        const start = hit && !whole ? lead.index - hit.start : lead.index
        const indent = /^[ \t]*/.exec(lead[0])![0]
        const consumed = start + lead[0].length
        const replacement = document.createDocumentFragment()
        replacement.append(indent, mark, text.slice(consumed))
        if (whole || !hit) element.replaceChildren(replacement)
        else hit.node.parentNode?.replaceChild(replacement, hit.node)
        marks.push(mark)
    }
    return marks
}

/** A line that starts with this prefix, or null when the element holds none. */
function leadLine(text: string, prefix: string): RegExpExecArray | null {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^[ \\t]*${escaped}[ \\t]*(.+)$`, 'm').exec(text)
}

/**
 * A line whose text starts with `=` is one query for the whole line. `=( … )` computes and shows
 * nothing, which is how an author keeps a derived value out of the page.
 */
function applyInlineQuery(element: HTMLElement, engine: Context, scope: Record<string, Literal>, context: InlineContext): boolean {
    // The app's own inline renderers may already have split a line into several text nodes, so the
    // query is read from the element's whole text and written back where that line actually lives.
    const nodes = textNodes(element, context, true)
    const full = nodes.map((node) => node.nodeValue ?? '').join('')
    let cursor = 0
    const ranges = nodes.map((node) => {
        const length = (node.nodeValue ?? '').length
        const range = { node, start: cursor, end: cursor + length }
        cursor += length
        return range
    })
    // Line-bounded: a live-preview block hands this pass several lines at once, and only the line that
    // starts with `=` is the query.
    const lead = /^[ \t]*=[ \t]*(.+)$/m.exec(full)
    if (!lead) return false
    const whole = full.trim() === lead[0].trim()
    const hit = ranges.find((range) => range.start <= lead.index && lead.index + lead[0].length <= range.end)
    if (!whole && !hit) return false
    const text = hit && !whole ? hit.node.nodeValue ?? '' : full
    const start = hit && !whole ? lead.index - hit.start : lead.index
    const indent = /^[ \t]*(?==)/.exec(lead[0])![0]
    let expression = lead[1]!.trim()
    let consumed = start + lead[0].length
    // `=( … )` is the one form that may be written across lines, so its closing parenthesis — not the
    // line end — decides where the expression stops.
    if (expression.startsWith('(') && depthOf(expression) > 0) {
        expression = text.slice(start + indent.length + 1).trim()
        consumed = text.length
    }
    const hidden = /^\([\s\S]*\)$/.test(expression)
    const body = hidden ? expression.slice(1, -1).trim() : expression
    // A line that merely starts with `=` is not proof the rest parses, and this pass runs over the
    // whole note: an author's typo would otherwise take the rest of the page's inline fields with it.
    let result: ReturnType<Context['attempt']>
    try {
        result = engine.attempt(parseField(body), scope)
    } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const replacement = document.createDocumentFragment()
    if (!result.ok) {
        const notice = document.createElement('span')
        notice.className = 'dataview-inline-error'
        notice.title = result.error
        notice.textContent = context.settings.renderNullAs || '—'
        if (!context.data) notice.dataset.dataviewPending = body
        replacement.append(indent, notice, text.slice(consumed))
    } else if (!hidden) {
        const wrapper = document.createElement('span')
        wrapper.className = 'dataview-inline-query'
        renderInlineText(wrapper, Values.toString(result.value, context.settings, context.settings.locale), renderContextFor(context))
        // With no page for this note every answer is provisional, including a plausible-looking zero.
        if (!context.data) wrapper.dataset.dataviewPending = body
        replacement.append(indent, wrapper, text.slice(consumed))
    } else {
        replacement.append(indent, text.slice(consumed))
    }
    if (whole || !hit) element.replaceChildren(replacement)
    else hit.node.parentNode?.replaceChild(replacement, hit.node)
    // The rest of the paragraph is the author's prose, and its `[key:: value]` fields are still fields.
    applyInlineFields(element, context)
    return true
}

/** Parentheses left open by a fragment, which is how a multi-line `=( … )` is recognised. */
function depthOf(text: string): number {
    let depth = 0
    for (const character of text) {
        if (character === '(') depth++
        else if (character === ')') depth--
    }
    return depth
}

/** Every `[k:: v]` in the line becomes a labelled chip; the surrounding prose is left alone. */
function applyInlineFields(element: HTMLElement, context: InlineContext): void {
    for (const node of textNodes(element, context, false)) {
        const text = node.nodeValue ?? ''
        if (!text.includes('::')) continue
        const hits = extractInlineFields(text)
        const full = hits.length === 0 ? wholeLineFieldIn(element, text) : null
        if (!hits.length && !full) continue
        const list = full ? [full] : hits
        const replacement = document.createDocumentFragment()
        let cursor = 0
        for (const hit of list) {
            if (hit.start < cursor) continue
            if (hit.start > cursor) replacement.append(document.createTextNode(text.slice(cursor, hit.start)))
            replacement.append(chipFor(hit.key, hit.value, context))
            cursor = hit.end
        }
        if (cursor < text.length) replacement.append(document.createTextNode(text.slice(cursor)))
        node.parentNode?.replaceChild(replacement, node)
    }
}

/** A whole-line `Key:: Value` counts only when the field is the line, not a fragment of a sentence. */
function wholeLineFieldIn(_element: HTMLElement, text: string): { key: string; value: string; start: number; end: number } | null {
    const trimmed = text.trim()
    if (!trimmed.includes('::') || trimmed.split('::').length !== 2) return null
    const hit = extractFullLineField(trimmed)
    if (!hit) return null
    const offset = text.length - text.trimStart().length
    return { key: hit.key, value: hit.value, start: offset, end: offset + trimmed.length }
}

function chipFor(key: string, raw: string, context: InlineContext): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'dataview-inline-field'
    chip.dataset.fieldKey = key
    const label = document.createElement('span')
    label.className = 'dataview-inline-key'
    label.textContent = key
    const separator = document.createElement('span')
    separator.className = 'dataview-inline-sep'
    separator.textContent = '::'
    const value = document.createElement('span')
    value.className = 'dataview-inline-value'
    const inline = extractInlineFields('[' + key + ':: ' + raw + ']')[0]
    const parsed = inline ? parseInlineValue(inline.value) : null
    const target = renderContextFor(context)
    if (parsed !== null && parsed !== undefined) appendValue(value, parsed, target)
    else renderInlineText(value, raw, target)
    chip.append(label, separator, value)
    return chip
}

/** Every text node below `element`, skipping subtrees that are not prose. */
function textNodes(element: Node, context: InlineContext, forQuery: boolean): Text[] {
    const out: Text[] = []
    const walk = (node: Node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
                out.push(child as Text)
                continue
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue
            const element = child as HTMLElement
            if (skippedBy(element, context, forQuery)) continue
            walk(element)
        }
    }
    walk(element)
    return out
}
