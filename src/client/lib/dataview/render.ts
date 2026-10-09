/**
 * Building the DOM a query result becomes.
 *
 * Everything here is constructed with element nodes and `textContent`, never by handing a result's own
 * text to `innerHTML`: a note's property value is user data that may contain markup, and a query result
 * is rendered inside another user's page. The one place markup is honoured is a task's or field's own
 * inline Markdown, which `renderInlineText` walks itself — wiki links, emphasis and code spans only —
 * because running the full Markdown pipeline per cell is what made large previews slow in this app.
 *
 * The classes are the app's own vocabulary: a table reuses `.table-wrap`/`table` so it inherits the
 * prose table styling, a task reuses the checkbox and list styles, and a heading uses
 * `--text-secondary` rather than a colour of its own.
 */

import { encodeDataValue } from '../markdown/data-attr'
import { DvLink, Grouping, Values, type DataObject, type Literal } from './value'
import type { CalendarResult, ListResult, TableResult, TaskResult, QueryResult } from './engine'
import { DEFAULT_QUERY_SETTINGS, type QueryRuntimeSettings } from './functions'
import { t } from '../i18n'
import { narrowWeekdayLabels, weekStartFor } from '../time'

export interface RenderContext {
    settings: QueryRuntimeSettings
    /** The note the block lives in, so a result that links back to itself can mark it. */
    originPath: string | null
    /** Whether a task checkbox may write back to its note; only a surface the reader owns can. */
    canToggle?: boolean
}

export function renderResult(result: QueryResult, context: RenderContext): HTMLElement {
    switch (result.kind) {
        case 'table':
            return withCount(renderTable(result, context), result.rows.length, context)
        case 'list':
            return withCount(renderList(result, context), result.items.length, context)
        case 'task':
            return withCount(renderTasks(result, context), result.tasks.length, context)
        case 'calendar':
            return withCount(renderCalendar(result, context), result.days.reduce((total, day) => total + day.rows.length, 0), context)
        default:
            return renderNotice('warning', t('dataview.unknown_view'))
    }
}

/**
 * The tally line hangs under the answer rather than inside it, so a table keeps being a table and a list
 * keeps being a list. With the setting off the view's own element is what the block gets, untouched.
 */
function withCount(element: HTMLElement, total: number, context: RenderContext): HTMLElement {
    if (!context.settings.showResultCount || total === 0) return element
    const wrap = document.createElement('div')
    wrap.className = 'dataview-output'
    wrap.append(element, renderCount(total, context))
    return wrap
}

function renderTable(result: TableResult, context: RenderContext): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap dataview-table-wrap'
    const table = document.createElement('table')
    table.className = 'dataview-table'
    const head = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const name of result.names) {
        const cell = document.createElement('th')
        cell.scope = 'col'
        cell.textContent = name
        headRow.append(cell)
    }
    head.append(headRow)
    const body = document.createElement('tbody')
    for (const row of result.rows) {
        const tr = document.createElement('tr')
        const cells = result.showId ? [row.id, ...row.cells] : row.cells
        for (const value of cells) {
            const cell = document.createElement('td')
            appendValue(cell, value, context)
            tr.append(cell)
        }
        body.append(tr)
    }
    table.append(head, body)
    wrap.append(table)
    if (!result.rows.length) wrap.append(renderEmpty(context))
    return wrap
}

function renderList(result: ListResult, context: RenderContext): HTMLElement {
    const list = document.createElement('ul')
    list.className = 'dataview-list'
    for (const item of result.items) {
        const li = document.createElement('li')
        if (result.showId) appendValue(li, item.id, context)
        if (item.value !== null) {
            if (result.showId) li.append(document.createTextNode(': '))
            appendValue(li, item.value, context)
        }
        if (item.members.length) {
            // A `GROUP BY` row is a heading with its members under it; the key alone would hide the fact
            // that the query matched anything at all.
            const nested = document.createElement('ul')
            nested.className = 'dataview-group'
            for (const member of item.members) {
                const child = document.createElement('li')
                appendValue(child, member, context)
                nested.append(child)
            }
            li.append(nested)
        }
        list.append(li)
    }
    if (!result.items.length) {
        const wrapper = document.createElement('div')
        wrapper.append(renderEmpty(context))
        return wrapper
    }
    return list
}

/**
 * A task row: the checkbox is a static picture of the note's own state, because ticking it here would
 * have to edit a different note's line. The row opens that note instead.
 */
/** The accessible name of a task checkbox: the task's own text, not a generic "checkbox". */
function taskAriaLabel(task: DataObject): string {
    const text = typeof task.text === 'string' ? task.text.trim() : ''
    return text ? `${t('dataview.task_toggle')}: ${text.slice(0, 120)}` : t('dataview.task_toggle')
}

function renderTasks(result: TaskResult, context: RenderContext): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'dataview-tasks'
    for (const entry of result.tasks) {
        const task = entry.task
        const row = document.createElement('div')
        row.className = 'dataview-task'
        const completed = task.completed === true
        const path = typeof task.path === 'string' ? task.path : null
        const line = typeof task.line === 'number' ? task.line : null
        const taskText = typeof task.text === 'string' ? task.text : null
        const toggleable = context.canToggle === true && path !== null && line !== null && taskText !== null
        const checkbox = document.createElement(toggleable ? 'input' : 'span')
        if (toggleable) {
            // A real checkbox on the surface that can write: keyboard and screen-reader state come free,
            // and the payload is what the click handler needs to find the same line again.
            const input = checkbox as HTMLInputElement
            input.type = 'checkbox'
            input.checked = completed
            input.setAttribute('aria-label', taskAriaLabel(task))
            input.dataset.dataviewTask = encodeDataValue(JSON.stringify({ path, line, text: taskText, completed }))
        } else {
            checkbox.setAttribute('role', 'img')
            checkbox.setAttribute('aria-label', completed ? t('dataview.task_done') : t('dataview.task_open'))
        }
        checkbox.className = `dataview-task-checkbox${completed ? ' is-checked' : ''}`
        row.append(checkbox)

        const text = document.createElement('span')
        text.className = 'dataview-task-text'
        renderInlineText(text, String(task.text ?? ''), context)
        if (completed) text.classList.add('is-done')
        row.append(text)

        for (const chip of taskChips(task)) row.append(chip)

        const source = Values.isLink(entry.source) ? entry.source : null
        if (source) {
            const link = document.createElement('span')
            link.className = 'dataview-task-source'
            appendValue(link, source, context)
            row.append(link)
        }
        wrapper.append(row)
    }
    if (!result.tasks.length) wrapper.append(renderEmpty(context))
    return wrapper
}

/** The `due 2024-05-06` pills a task carries, kept out of the sentence so they stay scannable. */
function taskChips(task: DataObject): HTMLElement[] {
    const out: HTMLElement[] = []
    for (const key of ['due', 'completion', 'scheduled', 'start', 'created']) {
        const value = task[key]
        if (!Values.isDate(value)) continue
        const chip = document.createElement('span')
        chip.className = 'dataview-task-chip'
        chip.dataset.field = key
        const label = document.createElement('span')
        label.className = 'dataview-task-chip-key'
        label.textContent = key
        const date = document.createElement('span')
        date.className = 'dataview-task-chip-value'
        date.textContent = Values.toString(value, { ...noopSettings(), dateFormat: 'MM-dd' })
        chip.append(label, date)
        out.push(chip)
    }
    return out
}

function noopSettings(): QueryRuntimeSettings {
    return { ...DEFAULT_QUERY_SETTINGS, renderNullAs: '', dateFormat: '', datetimeFormat: '', locale: 'en-US' }
}

/**
 * One month per day that actually has a match, drawn as a seven-column grid. Days with nothing are drawn but
 * inert, so the shape of the month reads the way a calendar should.
 */
function renderCalendar(result: CalendarResult, context: RenderContext): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'dataview-calendar'
    const months = new Map<string, { date: Date; rows: { id: Literal; data: DataObject }[] }[]>()
    for (const day of result.days) {
        const key = `${day.date.getFullYear()}-${day.date.getMonth()}`
        const bucket = months.get(key)
        if (bucket) bucket.push(day)
        else months.set(key, [day])
    }
    for (const [, days] of months) {
        const byDay = new Map<number, (typeof days)[number]>()
        for (const day of days) byDay.set(day.date.getDate(), day)
        const first = days[0]!.date
        const section = document.createElement('section')
        section.className = 'dataview-calendar-month'
        const heading = document.createElement('h4')
        heading.className = 'dataview-calendar-title'
        heading.textContent = new Intl.DateTimeFormat(context.settings.locale, { month: 'long', year: 'numeric' }).format(first)
        section.append(heading)

        const grid = document.createElement('div')
        grid.className = 'dataview-calendar-grid'
        grid.setAttribute('role', 'grid')
        const weekStart = weekStartFor(context.settings.locale)
        for (const label of narrowWeekdayLabels(context.settings.locale, weekStart)) {
            const cell = document.createElement('span')
            cell.className = 'dataview-calendar-weekday'
            cell.setAttribute('role', 'columnheader')
            cell.textContent = label
            grid.append(cell)
        }
        const leading = (new Date(first.getFullYear(), first.getMonth(), 1).getDay() - weekStart + 7) % 7
        for (let blank = 0; blank < leading; blank++) {
            const cell = document.createElement('span')
            cell.className = 'dataview-calendar-day is-empty'
            cell.setAttribute('role', 'gridcell')
            grid.append(cell)
        }
        const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
        for (let number = 1; number <= lastDay; number++) {
            const hit = byDay.get(number)
            const cell = document.createElement(hit ? 'button' : 'span')
            cell.className = hit ? 'dataview-calendar-day has-items' : 'dataview-calendar-day is-empty'
            cell.setAttribute('role', 'gridcell')
            const mark = document.createElement('span')
            mark.className = 'dataview-calendar-number'
            mark.textContent = String(number)
            cell.append(mark)
            if (hit) {
                cell.setAttribute('type', 'button')
                cell.setAttribute('aria-label', `${number} · ${hit.rows.length}`)
                const count = document.createElement('span')
                count.className = 'dataview-calendar-count'
                count.textContent = String(hit.rows.length)
                cell.append(count)
                const target = hit.rows[0]?.id
                if (Values.isLink(target)) cell.dataset.dataviewOpen = encodeDataValue(target.path)
            }
            grid.append(cell)
        }
        section.append(grid)
        wrapper.append(section)
    }
    if (!result.days.length) wrapper.append(renderEmpty(context))
    return wrapper
}

/**
 * A value as nodes. An array becomes its items separated by commas, a grouping becomes a small list of
 * its rows, and anything else becomes text — so a cell never receives markup it did not ask for.
 */
export function appendValue(target: ParentNode, value: Literal | undefined, context: RenderContext, depth = 0): void {
    if (depth > context.settings.maxRecursiveRenderDepth) {
        // A note can hold a property nested hundreds of levels deep, and the DOM for it is the reader's
        // problem, not the query's; the ceiling is a setting because some authors do want more.
        target.append(document.createTextNode('…'))
        return
    }
    if (Values.isGrouping(value) || value instanceof Grouping) {
        const list = document.createElement('ul')
        list.className = 'dataview-group'
        for (const row of (value as Grouping).rows) {
            const li = document.createElement('li')
            const link = row.file && Values.isLink((row.file as DataObject).link) ? (row.file as DataObject).link : null
            appendValue(li, link ?? Values.toString(row, context.settings, context.settings.locale), context, depth + 1)
            list.append(li)
        }
        target.append(list)
        return
    }
    if (Values.isLink(value)) {
        target.append(renderLinkNode(value, context))
        return
    }
    if (Values.isArray(value)) {
        if (!value.length) {
            target.append(document.createTextNode(context.settings.renderNullAs))
            return
        }
        value.forEach((item, index) => {
            if (index) target.append(document.createTextNode(', '))
            // A nested list keeps its brackets, so a reader can tell one value from several.
            if (Values.isArray(item)) {
                target.append(document.createTextNode('['))
                appendValue(target, item, context, depth + 1)
                target.append(document.createTextNode(']'))
                return
            }
            appendValue(target, item, context, depth)
        })
        return
    }
    if (Values.isObject(value)) {
        const entries = Object.entries(value)
        if (!entries.length) {
            target.append(document.createTextNode(context.settings.renderNullAs))
            return
        }
        const list = document.createElement('span')
        list.className = 'dataview-object'
        entries.forEach(([key, item], index) => {
            if (index) list.append(document.createTextNode(', '))
            const pair = document.createElement('span')
            pair.className = 'dataview-object-pair'
            const name = document.createElement('span')
            name.className = 'dataview-object-key'
            name.textContent = key
            const valueNode = document.createElement('span')
            valueNode.className = 'dataview-object-value'
            appendValue(valueNode, item, context, depth + 1)
            pair.append(name, document.createTextNode(': '), valueNode)
            list.append(pair)
        })
        target.append(list)
        return
    }
    const text = Values.isNull(value) ? context.settings.renderNullAs : Values.toString(value, context.settings, context.settings.locale)
    if (typeof text === 'string' && text.includes('[[') && depth === 0) {
        renderInlineText(target, text, context)
        return
    }
    target.append(document.createTextNode(text))
}

/** The anchor a link value becomes; the DML renderer draws the same shape so a click means the same. */
export function renderLinkNode(link: DvLink, context: RenderContext): HTMLElement {
    const anchor = document.createElement('a')
    anchor.className = 'wikilink'
    anchor.href = '#'
    if (link.path === context.originPath) anchor.classList.add('is-current')
    const name = link.path.replace(/\.md$/i, '').replace(/^.*\//, '')
    const target = link.subpath ? (link.kind === 'block' ? `${name}^${link.subpath}` : `${name}#${link.subpath}`) : name
    anchor.dataset.wikilink = encodeDataValue(target)
    anchor.textContent = link.display ?? (link.subpath ? `${name} > ${link.subpath}` : name)
    if (link.embed) anchor.classList.add('is-embed')
    return anchor
}

/**
 * One pass, one alternation: a wiki link, a Markdown link, bold (two spellings), italic,
 * strikethrough, a code span, or an inline tag with its leading boundary. Group order is what
 * `inlineNode` reads, so a change here must be mirrored there.
 */
const INLINE_RE = /(\[\[([^[\]|\n]{1,400})(?:\|([^[\]\n]{0,200}))?\]\])|(!?\[([^[\]\n]{0,200})\]\(([^)\s]{1,500})\))|(\*\*([^*\n]{1,200})\*\*)|(__([^_\n]{1,200})__)|(\*([^*\n]{1,200})\*)|(~~([^~\n]{1,200})~~)|(`([^`\n]{1,200})`)|([\s(])?(#([\p{Letter}\p{Number}][\p{Letter}\p{Number}/_-]{0,60}))/gu

/**
 * The small inline Markdown a result cell understands. Every matched run becomes an element holding a
 * text node, and the plain runs in between go in as `textContent`, so no path here can inject markup.
 */
export function renderInlineText(target: ParentNode, source: string, context: RenderContext): void {
    void context
    let cursor = 0
    const pattern = new RegExp(INLINE_RE.source, INLINE_RE.flags)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
        if (!match[0].length) {
            pattern.lastIndex = match.index + 1
            continue
        }
        const node = inlineNode(match)
        if (!node) continue
        if (match.index > cursor) target.append(document.createTextNode(source.slice(cursor, match.index)))
        for (const child of node) target.append(child)
        cursor = match.index + match[0].length
    }
    if (cursor < source.length) target.append(document.createTextNode(source.slice(cursor)))
}

/** The nodes one match contributes; null lets the walk fall through to the next candidate. */
function inlineNode(match: RegExpExecArray): Node[] | null {
    const g = match.slice(1)
    if (g[0] !== undefined) return [linkFromText(g[1]!, g[2] ?? null)]
    if (g[3] !== undefined) {
        const anchor = externalLink(g[4] ?? '', g[5] ?? '')
        return anchor ? [anchor] : null
    }
    if (g[6] !== undefined) return [wrap('strong', g[7]!)]
    if (g[8] !== undefined) return [wrap('strong', g[9]!)]
    if (g[10] !== undefined) return [wrap('em', g[11]!)]
    if (g[12] !== undefined) return [wrap('del', g[13]!)]
    if (g[14] !== undefined) return [wrap('code', g[15]!)]
    if (g[18] !== undefined) {
        // The boundary character is not part of the tag, so it goes back as text and the tag follows.
        const boundary = g[16]
        return boundary ? [document.createTextNode(boundary), inlineTag(g[18]!)] : [inlineTag(g[18]!)]
    }
    return null
}

function linkFromText(target: string, display: string | null): HTMLElement {
    const link = DvLink.infer(target.trim(), false, display)
    const anchor = document.createElement('a')
    anchor.className = 'wikilink'
    anchor.href = '#'
    const name = link.path.replace(/\.md$/i, '').replace(/^.*\//, '')
    anchor.dataset.wikilink = encodeDataValue(link.subpath ? (link.kind === 'block' ? `${name}^${link.subpath}` : `${name}#${link.subpath}`) : name)
    anchor.textContent = link.display ?? name
    return anchor
}

function externalLink(label: string, href: string): HTMLElement | null {
    let url: URL | null = null
    try {
        url = new URL(href, 'https://example.invalid')
    } catch {
        return null
    }
    if (!/^https?:$/.test(url.protocol) && !href.startsWith('/') && !href.startsWith('#')) return null
    const anchor = document.createElement('a')
    anchor.href = url.href
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.textContent = label
    return anchor
}

function inlineTag(name: string): HTMLElement {
    const span = document.createElement('span')
    span.className = 'inline-tag'
    span.dataset.tag = encodeDataValue(name)
    span.setAttribute('role', 'link')
    span.tabIndex = 0
    span.textContent = `#${name}`
    return span
}

function wrap(tag: string, text: string): HTMLElement {
    const node = document.createElement(tag)
    node.textContent = text
    return node
}

export function renderNotice(tone: 'error' | 'warning' | 'empty', message: string, detail?: string): HTMLElement {
    const aside = document.createElement('aside')
    aside.className = `dataview-notice is-${tone}`
    const strong = document.createElement('strong')
    strong.textContent = message
    aside.append(strong)
    if (detail) {
        const pre = document.createElement('pre')
        pre.className = 'dataview-notice-detail'
        pre.textContent = detail
        aside.append(pre)
    }
    return aside
}

function renderEmpty(context: RenderContext): HTMLElement | DocumentFragment {
    if (!context.settings.warnOnEmptyResult) return document.createDocumentFragment()
    const p = document.createElement('p')
    p.className = 'dataview-empty'
    p.textContent = t('dataview.no_results')
    return p
}

/** The line a block prints under its answer when the reader asked for the tally. */
function renderCount(total: number, context: RenderContext): HTMLElement | DocumentFragment {
    if (!context.settings.showResultCount || total === 0) return document.createDocumentFragment()
    const p = document.createElement('p')
    p.className = 'dataview-result-count'
    p.dataset.count = String(total)
    p.textContent = t('dataview.result_count', { value0: total })
    return p
}

/** The footer a list carries when the settings ceiling clipped it, or the body ceiling did. */
export function renderTruncation(shown: number, matched: number, bodiesCut: boolean): HTMLElement {
    const p = document.createElement('p')
    p.className = 'dataview-truncated'
    p.textContent = bodiesCut
        ? t('dataview.limited_bodies', { value0: shown })
        : t('dataview.rows_limited', { value0: shown, value1: matched })
    return p
}
