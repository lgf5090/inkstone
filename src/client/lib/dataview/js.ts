/**
 * The DML block on the page side: build a snapshot, ask the worker, draw what comes back.
 *
 * The snapshot is the privacy boundary. A note's code only ever sees pages the *reader of this note*
 * can see, already serialized by the same index a query block reads, and it sees at most
 * `DV_PAGE_LIMIT` of them — a block that wants more is told the answer is short rather than being
 * handed the vault to walk.
 *
 * The run is capped twice over: the worker is terminated at `DV_RUN_TIMEOUT_MS`, and a reply that never
 * arrives leaves the block saying so rather than spinning.
 */

import { cool, type DvNode, type DvReply, type DvRequest, type DvSnapshotPage, DV_PAGE_LIMIT } from './js-api'
import { dataviewIndex, querySettings } from './service'
import { renderLinkNode } from './render'
import { DvLink } from './value'
import DOMPurify from 'dompurify'
import { t } from '../i18n'
import { renderMarkdown, PURIFY_CONFIG } from '../markdown/renderer'

export const DV_RUN_TIMEOUT_MS = 2000

interface DvWorker {
    postMessage(data: DvRequest): void
    terminate(): void
    onmessage: ((event: MessageEvent<DvReply>) => void) | null
    onerror: (() => void) | null
}

function spawn(): DvWorker {
    return new Worker(new URL('./js.worker.ts', import.meta.url), { type: 'module' }) as unknown as DvWorker
}

export interface DvRunResult {
    nodes: DvNode[]
    errorText: string
    logs: { type: string; text: string }[]
    truncated: boolean
    /** True when the snapshot itself was cut, which the block says out loud. */
    snapshotShort: boolean
    /** True when a note in the window had no parsed page yet, so the answer can still grow. */
    snapshotOwes: boolean
}

/** Run one block's code. Resolves with an error text rather than rejecting, so a block never stalls. */
export async function runDataviewJs(code: string, originNoteId: string | null): Promise<DvRunResult> {
    let pages = snapshot(originNoteId)
    // A note's code reads the vault, so a body the index has not read is a missing answer rather than a
    // smaller one. Ask for the ones inside the window once — `load` is bounded by the reader's own limit.
    if (pages.missing.length) {
        await dataviewIndex.load(pages.missing)
        pages = snapshot(originNoteId)
    }
    const request: DvRequest = {
        code,
        pages: pages.pages,
        current: pages.current,
        settings: querySettings(),
    }
    let worker: DvWorker
    try {
        worker = spawn()
    } catch (error) {
        return { nodes: [], errorText: error instanceof Error ? error.message : String(error), logs: [], truncated: false, snapshotShort: pages.short, snapshotOwes: pages.owed }
    }
    return await new Promise<DvRunResult>((resolve) => {
        let settled = false
        const finish = (result: DvRunResult) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            worker.terminate()
            resolve(result)
        }
        const timer = setTimeout(() => {
            finish({
                nodes: [],
                errorText: t('dataview.js_timeout', { value0: DV_RUN_TIMEOUT_MS }),
                logs: [],
                truncated: false,
                snapshotShort: pages.short, snapshotOwes: pages.owed,
            })
        }, DV_RUN_TIMEOUT_MS)
        worker.onmessage = (event) => {
            const reply = event.data
            finish({
                nodes: Array.isArray(reply?.nodes) ? reply.nodes : [],
                errorText: reply?.errorText ?? '',
                logs: Array.isArray(reply?.logs) ? reply.logs : [],
                truncated: Boolean(reply?.truncated),
                snapshotShort: pages.short, snapshotOwes: pages.owed,
            })
        }
        worker.onerror = () => finish({ nodes: [], errorText: t('dataview.js_crashed'), logs: [], truncated: false, snapshotShort: pages.short, snapshotOwes: pages.owed })
        try {
            worker.postMessage(request)
        } catch (error) {
            finish({ nodes: [], errorText: error instanceof Error ? error.message : String(error), logs: [], truncated: false, snapshotShort: pages.short, snapshotOwes: pages.owed })
        }
    })
}

interface DvSnapshot {
    pages: DvSnapshotPage[]
    current: DvSnapshotPage | null
    /** The window was cut at the page ceiling, so a wider answer exists. */
    short: boolean
    /** Notes inside the window whose body has not been read yet. */
    owed: boolean
    missing: string[]
}

function snapshot(originNoteId: string | null): DvSnapshot {
    const ids = dataviewIndex.allNoteIds()
    const window = ids.slice(0, DV_PAGE_LIMIT)
    const pages: DvSnapshotPage[] = []
    const missing: string[] = []
    let current: DvSnapshotPage | null = null
    for (const id of window) {
        const data = dataviewIndex.serialize(id)
        const path = dataviewIndex.pageOf(id)?.path
        if (!data || !path) {
            missing.push(id)
            continue
        }
        const page: DvSnapshotPage = { path, data: cool(data) }
        pages.push(page)
        if (id === originNoteId) current = page
    }
    return { pages, current, short: ids.length > window.length, owed: missing.length > 0, missing }
}

/**
 * Draw a descriptor tree. Every string goes in as text, and the two escape hatches — `renderMarkdown`
 * and `renderHtml` — go through the same pipeline the note's own prose uses, so a block cannot publish
 * markup the sanitizer would refuse anywhere else.
 */
export function renderDvNodes(nodes: DvNode[]): DocumentFragment {
    const fragment = document.createDocumentFragment()
    for (const node of nodes) {
        const element = renderDvNode(node)
        if (element) fragment.append(element)
    }
    return fragment
}

function renderDvNode(node: DvNode): Node | null {
    switch (node.kind) {
        case 'text':
            return document.createTextNode(node.text)
        case 'heading': {
            const heading = document.createElement(`h${Math.min(6, Math.max(1, node.level))}`)
            heading.className = 'dataview-dv-heading'
            appendChildren(heading, node.children)
            return heading
        }
        case 'paragraph': {
            const paragraph = document.createElement('p')
            appendChildren(paragraph, node.children)
            return paragraph
        }
        case 'list': {
            const list = document.createElement(node.ordered ? 'ol' : 'ul')
            list.className = 'dataview-list'
            appendChildren(list, node.items)
            return list
        }
        case 'task': {
            const wrap = document.createElement('div')
            wrap.className = 'dataview-tasks'
            for (const task of node.items) {
                const row = document.createElement('div')
                row.className = 'dataview-task'
                const box = document.createElement('span')
                box.className = `dataview-task-checkbox${task.completed ? ' is-checked' : ''}`
                box.setAttribute('role', 'img')
                box.setAttribute('aria-label', task.completed ? t('dataview.task_done') : t('dataview.task_open'))
                const text = document.createElement('span')
                text.className = 'dataview-task-text'
                appendChildren(text, task.text)
                row.append(box, text)
                if (task.source) {
                    const source = document.createElement('span')
                    source.className = 'dataview-task-source'
                    source.textContent = task.source
                    row.append(source)
                }
                wrap.append(row)
            }
            return wrap
        }
        case 'table':
        case 'grid': {
            const wrap = document.createElement('div')
            wrap.className = 'table-wrap dataview-table-wrap'
            const table = document.createElement('table')
            table.className = 'dataview-table'
            const head = document.createElement('tr')
            for (const cell of node.header) {
                const th = document.createElement('th')
                th.scope = 'col'
                th.append(...childNodes(cell))
                head.append(th)
            }
            const thead = document.createElement('thead')
            thead.append(head)
            const body = document.createElement('tbody')
            for (const row of node.rows) {
                const tr = document.createElement('tr')
                for (const cell of row) {
                    const td = document.createElement('td')
                    td.append(...childNodes(cell))
                    tr.append(td)
                }
                body.append(tr)
            }
            table.append(thead, body)
            wrap.append(table)
            return wrap
        }
        case 'element': {
            const element = document.createElement(node.tag)
            if (node.class) element.className = node.class
            for (const [key, value] of Object.entries(node.attrs)) {
                if (/^(?:href|src|xlink:href|formaction|action|data-|on)/i.test(key)) {
                    // A URL attribute is where an injected `javascript:` would live, and an event
                    // attribute is the handler itself; only the note's own prose may carry either.
                    if (!/^(?:data-|aria-)/i.test(key)) continue
                }
                element.setAttribute(key, value)
            }
            appendChildren(element, node.children)
            return element
        }
        case 'link':
            // The same anchor a DQL cell draws, so a DML table's link opens the note like any other.
            return renderLinkNode(new DvLink(node.path, 'file', node.subpath, node.display, node.embed), { settings: querySettings(), originPath: null })
        case 'markdown': {
            const wrap = document.createElement('div')
            wrap.className = 'dataview-markdown'
            wrap.innerHTML = renderMarkdown(node.text).html
            return wrap
        }
        case 'html': {
            // The one place a block's own text becomes markup, so it runs through the same policy the
            // note's prose is sanitized with: no script, no event handler, no foreign scheme.
            const wrap = document.createElement('div')
            wrap.className = 'dataview-html'
            wrap.innerHTML = DOMPurify.sanitize(node.html, PURIFY_CONFIG)
            return wrap
        }
        case 'section': {
            const section = document.createElement('section')
            section.className = 'dataview-section'
            if (node.title) {
                const heading = document.createElement('h4')
                heading.textContent = node.title
                section.append(heading)
            }
            appendChildren(section, node.children)
            return section
        }
        default:
            return null
    }
}

function appendChildren(target: HTMLElement, nodes: DvNode[]): void {
    for (const node of nodes ?? []) {
        const child = renderDvNode(node)
        if (child) target.append(child)
    }
}

function childNodes(node: DvNode): Node[] {
    const holder = document.createElement('span')
    const child = renderDvNode(node)
    if (child) holder.append(child)
    return [...holder.childNodes]
}

/** The line a DML block adds when the snapshot it was given was cut short. */
export function dvTruncatedNotice(): HTMLElement {
    const note = document.createElement('p')
    note.className = 'dataview-truncated'
    note.textContent = t('dataview.js_snapshot_short', { value0: DV_PAGE_LIMIT })
    return note
}

/** Where the run's `console.log` output goes: below the answer, so it never impersonates content. */
export function dvLogPanel(logs: { type: string; text: string }[]): HTMLElement | null {
    if (!logs.length) return null
    const wrap = document.createElement('details')
    wrap.className = 'dataview-logs'
    const summary = document.createElement('summary')
    summary.textContent = t('dataview.js_logs', { value0: logs.length })
    wrap.append(summary)
    const list = document.createElement('pre')
    list.textContent = logs.map((line) => line.text).join('\n')
    wrap.append(list)
    return wrap
}

