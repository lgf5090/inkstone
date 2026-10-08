/**
 * Mounting query blocks into a preview.
 *
 * A ` ```dataview ` fence renders as an empty host in `renderer.ts` and is filled here, for the same
 * reason a chart or a board is: the answer depends on other notes, and those live behind a store and a
 * throttled endpoint. So the pass is asynchronous, and a block that answered from what was indexed a
 * moment ago re-answers when the index moves — which is what makes a query written against a note the
 * reader has not opened yet fill in rather than stay empty.
 *
 * Each host keeps its own record so a re-render replaces only its own subtree, and so a block removed
 * from the document stops subscribing. Nothing is cached across hosts: two blocks with the same query
 * in one document are two readers, and the index is the shared part.
 */

import { parseQuery } from './expression'
import { dvLogPanel, dvTruncatedNotice, renderDvNodes, runDataviewJs } from './js'
import type { DataviewMode } from './body'
import { ParseFailure } from './grammar'
import { Context } from './context'
import { executeQuery, type QueryResult } from './engine'
import { renderNotice, renderResult, renderTruncation } from './render'
import { querySettings, dataviewIndex, dataviewSettings, startDataview } from './service'
import { renderDataviewInline, rerunInlineQueries, type InlineContext } from './inline'
import type { DataObject } from './value'
import { decodeDataValue, encodeDataValue } from '../markdown/data-attr'
import { t } from '../i18n'
import type { DataRail } from './engine'
import type { Query } from './ast'

const HOST_SELECTOR = '[data-dataview]'
const MAX_SOURCE_CHARS = 8000
/** How many times a cold block asks the index for the bodies it is missing before it gives up. */
const BOOT_LOAD_ROUNDS = 3

interface Mount {
    /** The rendered subtree, so the next answer replaces exactly what this one drew. */
    body: HTMLElement
    head: HTMLElement
    /** The query text this host was last rendered from. */
    source: string
    /** Which of the two block languages this host holds. */
    mode: DataviewMode
    /** Set when the reader asks to see the fence body instead of the answer. */
    showSource: boolean
    /** Bumped on every draw, so a DML reply that arrives late is discarded rather than shown. */
    token: number
    /** The token of the run this block has in flight, or null when nothing is being computed. */
    runningToken: number | null
    /** How many boot-time body loads this block has asked for, so a cold mount still resolves. */
    bootLoads: number
    /** The index version this host answered against, so the pump only re-answers a moved index. */
    indexVersion: number
}

const mounts = new WeakMap<HTMLElement, Mount>()
/** Hosts whose answer is still arriving, keyed by the note they belong to. */
let pending = new Set<HTMLElement>()
/** Prose surfaces whose inline pass answered `this` before the note had a page. */
const inlineRoots = new Map<HTMLElement, DataviewMountOptions>()
let unsubscribeIndex: (() => void) | null = null
let pumpRunning = false

export interface DataviewMountOptions {
    /** The note the preview belongs to, which is what `this.file.name` reads. */
    originNoteId: string | null
    /** Where the block writes its own fence body back, when the surface can edit. */
    editable: boolean
}

/**
 * Render every query block under `root`. Returns immediately for a block whose bodies are still on
 * their way; those are finished by the pump that subscribes to the index.
 */
export function renderDataviewBlocks(root: HTMLElement, options: DataviewMountOptions): void {
    startDataview()
    watchIndex()
    const hosts = [...root.querySelectorAll<HTMLElement>(HOST_SELECTOR)]
    for (const host of hosts) {
        if (!host.isConnected) continue
        // Kept on the host rather than only in this call's closure: the pump re-answers a block when the
        // index moves, long after the surface that mounted it has re-rendered.
        setDataviewHostOptions(host, options)
        const source = decodeDataValue(host.dataset.dataview ?? '')
        const mount = mounts.get(host)
        if (mount && mount.source === source && mount.body.isConnected) {
            // The markup survived a preview diff unchanged, so only the answer's freshness is in
            // question: re-draw it and let the pump pick the block up again if bodies are still in.
            draw(host, mount, source, options)
            continue
        }
        build(host, source, options)
    }
    pump()
}

/**
 * Everything Dataview draws on a live preview surface, in one call: the query blocks, then the inline
 * fields and `= expression` lines in the prose around them. Both need the index, so both live here.
 */
export function mountDataview(root: HTMLElement, options: DataviewMountOptions): void {
    renderDataviewBlocks(root, options)
    const data = dataviewIndex.currentData(options.originNoteId)
    renderDataviewInline(root, inlineContextFor(options))
    // An inline answer reads the note it lives in, and that note is only a page once its body has been
    // read. Asking for it is cheap — one note — and the pump re-runs the pass when the page arrives.
    if (!data && options.originNoteId) {
        inlineRoots.set(root, options)
        void dataviewIndex.load([options.originNoteId])
    } else inlineRoots.delete(root)
}

/** The inline pass's view of a surface: the note's own page plus the two feature switches. */
function inlineContextFor(options: DataviewMountOptions): InlineContext {
    const settings = dataviewSettings()
    return {
        settings: querySettings(),
        data: dataviewIndex.currentData(options.originNoteId),
        linkHandler,
        fields: settings.inlineFields,
        queries: settings.inlineQueries,
    }
}

/** One link handler for the whole module, so a query and an inline line agree on note identity. */
const linkHandler = {
    resolve: (path: string): DataObject | null => {
        const id = dataviewIndex.noteIdForLink(path)
        return id ? dataviewIndex.serialize(id) : null
    },
    normalize: (path: string): string => {
        const id = dataviewIndex.noteIdForLink(path)
        return id ? dataviewIndex.pageOf(id)?.path ?? path : path
    },
    exists: (path: string): boolean => dataviewIndex.noteIdForLink(path) !== undefined,
}

function build(host: HTMLElement, source: string, options: DataviewMountOptions): void {
    host.classList.add('dataview-block')
    host.replaceChildren()
    const head = document.createElement('div')
    head.className = 'dataview-block-head'
    const title = document.createElement('span')
    title.className = 'dataview-block-title'
    title.textContent = t('dataview.block_title')
    head.append(title)

    const actions = document.createElement('span')
    actions.className = 'dataview-block-actions'
    const sourceButton = blockButton('dataview.show_source', 'dataview-source-toggle')
    sourceButton.setAttribute('aria-expanded', 'false')
    const refreshButton = blockButton('dataview.rerun', 'dataview-rerun')
    actions.append(sourceButton, refreshButton)
    head.append(actions)

    const body = document.createElement('div')
    body.className = 'dataview-block-body'
    host.append(head, body)

    const mount: Mount = { body, head, source, mode: host.dataset.dataviewMode === 'js' ? 'js' : 'query', showSource: false, token: 0, runningToken: null, bootLoads: 0, indexVersion: dataviewIndex.currentVersion }
    mounts.set(host, mount)
    if (!host.dataset.dataviewWired) {
        host.dataset.dataviewWired = '1'
        host.addEventListener('click', (event) => takeGesture(host, event as MouseEvent, options))
    }
    sourceButton.addEventListener('click', () => {
        mount.showSource = !mount.showSource
        sourceButton.setAttribute('aria-expanded', mount.showSource ? 'true' : 'false')
        sourceButton.classList.toggle('is-active', mount.showSource)
        draw(host, mount, source, options)
    })
    refreshButton.addEventListener('click', () => {
        void dataviewIndex.load([...dataviewIndex.allNoteIds()])
        draw(host, mount, source, options)
    })

    draw(host, mount, source, options)
}

function blockButton(labelKey: Parameters<typeof t>[0], marker: 'dataview-source-toggle' | 'dataview-rerun'): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `dataview-block-btn ${marker}`
    // The gesture test in `takeGesture` and the CSS both key off this, so the hook is a data
    // attribute like the app's other block controls (`data-copy`, `data-kanban-fullscreen`).
    button.setAttribute(`data-${marker}`, 'true')
    const label = t(labelKey)
    button.setAttribute('aria-label', label)
    button.title = label
    button.textContent = marker === 'dataview-source-toggle' ? '</>' : '↻'
    return button
}

/**
 * A DML block runs asynchronously: the snapshot is taken here, the worker answers when it can, and the
 * mount's token decides whether the reply still belongs to this draw.
 */
function drawJs(host: HTMLElement, mount: Mount, source: string, options: DataviewMountOptions, enabled: boolean): void {
    if (!enabled) {
        mount.body.append(renderNotice('warning', t('dataview.js_disabled')))
        mount.body.append(renderSource(source))
        return
    }
    if (!source.trim()) {
        mount.body.append(renderNotice('warning', t('dataview.empty_query')))
        return
    }
    // One run per block: a reader typing in a note with a DML block moves the index every few keystrokes,
    // and a queue of workers whose answers will all be discarded is the worst way to spend that.
    if (mount.runningToken !== null) {
        pending.add(host)
        // A draw that was folded into the run already in flight still owes an answer, so it must not read
        // as up to date when that reply lands.
        mount.indexVersion = -1
        return
    }
    host.classList.add('loading')
    const token = mount.token
    mount.runningToken = token
    void runDataviewJs(source, options.originNoteId).then((result) => {
        if (mount.runningToken === token) mount.runningToken = null
        if (mount.token !== token || !host.isConnected) {
            pump()
            return
        }
        host.classList.remove('loading')
        mount.body.replaceChildren()
        if (result.errorText) {
            host.classList.add('is-error')
            mount.body.append(renderNotice('error', t('dataview.exec_failed'), dataviewSettings().showErrorDetails ? result.errorText : undefined))
        } else {
            host.classList.remove('is-error')
            mount.body.append(renderDvNodes(result.nodes))
            if (result.snapshotShort || result.snapshotOwes) mount.body.append(dvTruncatedNotice())
        }
        const logs = dvLogPanel(result.logs)
        if (logs) mount.body.append(logs)
        // A DML snapshot covers whatever the index knew when it was taken, and the index can grow after
        // that — the note list itself arrives a moment after the first note opens. The block therefore
        // stays registered, and `pump` re-runs it only once the version has actually moved on.
        if (result.errorText) pending.delete(host)
        else {
            pending.add(host)
            // The store usually finishes filling while this worker was running, so the notification that
            // would have redrawn this block has already passed. Ask once here; the version guard makes a
            // block whose index has not moved a no-op rather than the start of a loop.
            pump()
        }
    }).catch((error: unknown) => {
        if (mount.runningToken === token) mount.runningToken = null
        if (mount.token !== token || !host.isConnected) {
            pump()
            return
        }
        host.classList.remove('loading')
        host.classList.add('is-error')
        mount.body.append(renderNotice('error', t('dataview.exec_failed'), dataviewSettings().showErrorDetails ? String(error) : undefined))
    })
}

/** Replace the body with the current answer, a notice, or the fence text when that is what was asked. */
function draw(host: HTMLElement, mount: Mount, source: string, options: DataviewMountOptions): void {
    mount.token += 1
    mount.body.replaceChildren()
    mount.indexVersion = dataviewIndex.currentVersion
    const settings = dataviewSettings()
    if (mount.showSource) {
        // Asked for by name on the block's own head, and it means the same thing for both languages:
        // show the fence body and stop computing.
        mount.body.append(renderSource(source))
        pending.delete(host)
        return
    }
    if (mount.mode === 'js') {
        drawJs(host, mount, source, options, settings.jsBlocks)
        return
    }
    if (!settings.enabled) {
        mount.body.append(renderNotice('warning', t('dataview.disabled'), undefined))
        mount.body.append(renderSource(source))
        return
    }
    if (!source.trim()) {
        mount.body.append(renderNotice('warning', t('dataview.empty_query')))
        return
    }
    const answer = answerFor(source, options)
    if (answer.kind === 'pending') {
        host.classList.add('loading')
        pending.add(host)
        mount.body.append(renderNotice('empty', t('dataview.loading')))
        boot(host, mount, source, options, answer.needBodies)
        return
    }
    host.classList.remove('loading')
    if (answer.kind === 'error') {
        host.classList.add('is-error')
        pending.delete(host)
        mount.body.append(renderNotice('error', answer.title, settings.showErrorDetails ? answer.detail : undefined))
        return
    }
    // A block that answered is still watched, because the row set can shrink as well as grow: archiving a
    // note or editing a tag away takes rows out, and only the index knows when that happened.
    pending.add(host)
    if (answer.owingBodies) boot(host, mount, source, options, answer.needBodies)
    host.classList.remove('is-error')
    const rendered = renderResult(answer.result, { settings: querySettings(), originPath: currentPath(options) })
    mount.body.append(rendered)
    if (answer.truncatedRows || answer.truncatedBodies) {
        mount.body.append(renderTruncation(answer.shown, answer.matched, answer.truncatedBodies))
    }
}

/**
 * Ask the index for the bodies this answer is missing, and draw again when they arrive. A block that has
 * never been satisfied cannot simply wait for the next index change — with live refresh off there may not
 * be one — so it drives its own first load. The rounds are capped because the index caps its own loads
 * and a body it was refused stays refused.
 */
function boot(host: HTMLElement, mount: Mount, source: string, options: DataviewMountOptions, needBodies: string[]): void {
    if (mount.bootLoads >= BOOT_LOAD_ROUNDS || !needBodies.length) return
    mount.bootLoads += 1
    void dataviewIndex.load(needBodies).then(() => {
        if (host.isConnected && mounts.get(host) === mount) draw(host, mount, source, options)
    })
}

interface AnswerBase {
    shown: number
    matched: number
    truncatedRows: boolean
    truncatedBodies: boolean
    /** Bodies this answer still waits on, so the row set can grow before the loading ends. */
    owingBodies: boolean
    needBodies: string[]
}

type Answer =
    | { kind: 'ok'; result: QueryResult } & AnswerBase
    | { kind: 'error'; title: string; detail: string }
    | { kind: 'pending'; needBodies: string[] }

/**
 * Parse, resolve and execute a query over what the index holds right now. `pending` means the answer is
 * empty *and* bodies are still on their way, which is the one case worth showing as a loading state; an
 * answer that is merely short says so through `owingBodies` instead of pretending to be final.
 */
function answerFor(source: string, options: DataviewMountOptions): Answer {
    let query: Query
    try {
        query = parseQuery(source)
    } catch (error) {
        if (error instanceof ParseFailure) {
            return { kind: 'error', title: t('dataview.parse_failed'), detail: describeParseFailure(source, error) }
        }
        return { kind: 'error', title: t('dataview.parse_failed'), detail: error instanceof Error ? error.message : String(error) }
    }

    const settings = dataviewSettings()
    const resolved = dataviewIndex.rails(query.source)
    if (!resolved.rails.length && resolved.pending) return { kind: 'pending', needBodies: resolved.needBodies }

    const context = new Context({ linkHandler, settings: querySettings() })
    const rows = capRows(resolved.rails, query, settings.maxRows)
    const result = executeQuery(query, rows.rails, context, dataviewIndex.currentData(options.originNoteId))
    if (!result.ok) return { kind: 'error', title: t('dataview.exec_failed'), detail: result.error }
    return {
        kind: 'ok',
        result: result.value,
        shown: countRows(result.value),
        matched: rows.matched,
        truncatedRows: rows.limited,
        truncatedBodies: resolved.pending || dataviewIndex.getStatus().truncated,
        owingBodies: resolved.pending,
        needBodies: resolved.needBodies,
    }
}

/**
 * A `LIMIT` is the author's own cap and always wins; `maxRows` is the app's ceiling for a query that
 * wrote none, so a `FROM ""` over a large vault cannot hand the browser fifty thousand rows.
 */
function capRows(rails: DataRail[], query: Query, maxRows: number): { rails: DataRail[]; matched: number; limited: boolean } {
    const hasLimit = query.operations.some((op) => op.type === 'limit')
    if (hasLimit || rails.length <= maxRows) return { rails, matched: rails.length, limited: false }
    return { rails: rails.slice(0, maxRows), matched: rails.length, limited: true }
}

function countRows(result: QueryResult): number {
    switch (result.kind) {
        case 'table':
            return result.rows.length
        case 'list':
            return result.items.length
        case 'task':
            return result.tasks.length
        case 'calendar':
            return result.days.reduce((total, day) => total + day.rows.length, 0)
        default:
            return 0
    }
}

function currentPath(options: DataviewMountOptions): string | null {
    if (!options.originNoteId) return null
    return dataviewIndex.pageOf(options.originNoteId)?.path ?? null
}

function describeParseFailure(source: string, error: ParseFailure): string {
    const position = error.position
    const line = source.slice(0, position).split('\n')
    const lineNumber = line.length
    const column = (line[line.length - 1] ?? '').length + 1
    const snippet = (line[line.length - 1] ?? '').trim().slice(0, 80)
    return `${t('dataview.at_line', { value0: lineNumber, value1: column })}\n${error.message}${snippet ? `\n${snippet}` : ''}`
}

function renderSource(source: string): HTMLElement {
    const pre = document.createElement('pre')
    pre.className = 'dataview-source'
    pre.textContent = source.length > MAX_SOURCE_CHARS ? `${source.slice(0, MAX_SOURCE_CHARS)}…` : source
    return pre
}

/**
 * Re-answer every block that is waiting on bodies. One subscription for the whole app, and one pass per
 * index change, because a document with twelve blocks must not cost twelve store reads.
 */
function watchIndex(): void {
    if (unsubscribeIndex) return
    unsubscribeIndex = dataviewIndex.subscribe(() => {
        pump()
    })
}

function pump(): void {
    // With live refresh off a block keeps the answer it first computed, and only a re-render of the
    // note (a save, a reopen) asks the index again.
    if (!dataviewSettings().liveRefresh) return
    if (pumpRunning) return
    pumpRunning = true
    // The index debounces its own notifications, so a burst of store writes lands as one re-answer.
    queueMicrotask(() => {
        pumpRunning = false
        for (const host of [...pending]) {
            const mount = mounts.get(host)
            if (!host.isConnected || !mount) {
                pending.delete(host)
                continue
            }
            // `draw` answers again and decides whether the host still owes one, so a block is not
            // executed twice per notification just to find out that nothing arrived.
            if (mount.indexVersion === dataviewIndex.currentVersion) continue
            draw(host, mount, mount.source, optionsFor(host))
        }
        for (const [root, options] of inlineRoots) {
            if (!root.isConnected) {
                inlineRoots.delete(root)
                continue
            }
            if (!dataviewIndex.currentData(options.originNoteId)) continue
            rerunInlineQueries(root, inlineContextFor(options))
            inlineRoots.delete(root)
        }
    })
}

/**
 * The options a mounted host needs when the index moves. They are kept on the host rather than in a
 * closure so a preview that re-uses its DOM across a note switch stays honest.
 */
const hostOptions = new WeakMap<HTMLElement, DataviewMountOptions>()

export function setDataviewHostOptions(host: HTMLElement, options: DataviewMountOptions): void {
    hostOptions.set(host, options)
}

function optionsFor(host: HTMLElement): DataviewMountOptions {
    const scoped = host.closest<HTMLElement>('[data-dataview-origin]')
    const noteId = scoped?.dataset.dataviewOrigin ?? hostOptions.get(host)?.originNoteId ?? null
    return { originNoteId: noteId, editable: hostOptions.get(host)?.editable ?? false }
}

/** Stop the shared subscription — what a test teardown calls so runs do not leak into each other. */
export function resetDataviewMounts(): void {
    unsubscribeIndex?.()
    unsubscribeIndex = null
    pending = new Set()
    inlineRoots.clear()
    pumpRunning = false
}

/**
 * What a press inside a query block means. The head's two buttons, a calendar day, and a link in an
 * answer are all the block's own business, and on the live surface an unclaimed click is read as “put
 * the caret in the source” — which folds the block the reader is standing in.
 */
function takeGesture(host: HTMLElement, event: MouseEvent, options: DataviewMountOptions): void {
    const target = event.target as HTMLElement
    if (target.closest('[data-dataview-source-toggle], [data-dataview-rerun]')) {
        event.preventDefault()
        event.stopPropagation()
        return
    }
    const day = target.closest<HTMLElement>('[data-dataview-open]')
    if (day) {
        event.preventDefault()
        event.stopPropagation()
        const path = decodeDataValue(day.dataset.dataviewOpen ?? '')
        const id = dataviewIndex.noteIdForPath(path)
        if (id) void openNote(id)
        return
    }
    const wiki = target.closest<HTMLElement>('[data-wikilink]')
    if (!wiki || !host.closest('.cm-live-block')) return
    // A plain click on a result link is navigation here, not a caret move; the split and read surfaces
    // already answer wikilinks through the preview's own handler, so only live needs taking.
    event.preventDefault()
    event.stopPropagation()
    const id = dataviewIndex.noteIdForLink(linkTitleOf(decodeDataValue(wiki.dataset.wikilink ?? '')))
    if (id) void openNote(id)
    void options
}

function linkTitleOf(target: string): string {
    const hash = target.indexOf('#')
    const caret = target.indexOf('^')
    const cut = hash >= 0 ? hash : caret
    return (cut >= 0 ? target.slice(0, cut) : target).trim()
}

async function openNote(noteId: string): Promise<void> {
    const { useNotes } = await import('../../store/notes')
    await useNotes.getState().openNote(noteId)
}

/**
 * The attribute value a fence body travels in. Exported so `renderer.ts` and the share page build the
 * same encoding without reaching into the data-attribute helper twice.
 */
export function encodeQueryBody(source: string): string {
    return encodeDataValue(source)
}

/** A host the caller wants re-rendered now, ignoring the debounce — used after a settings change. */
export function rerenderDataviewHost(host: HTMLElement): void {
    const mount = mounts.get(host)
    if (!mount) return
    draw(host, mount, mount.source, optionsFor(host))
}
