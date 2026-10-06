import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseKanbanBody } from './body'
import type { KanbanBlockEntry, KanbanRenderStamp, KanbanRootHandlers } from './entry'
import type { KanbanData, KanbanWriter } from './types'
import { KanbanRoot, KanbanRootBoundary } from './ui'
import {
  createKanbanCanvas,
  createKanbanReserve,
  decorateKanbanControls,
  isKanbanWritableHere,
  kanbanBlocks,
  kanbanBody,
  kanbanIndex,
  kanbanPlaceholder,
  markKanbanLoading,
  markKanbanReady,
  setKanbanHeadTitle,
  showKanbanError,
} from './view'
import { flushKanbanEntry, discardKanbanWrite, retryKanbanWrite, scheduleKanbanWrite } from './write'

export interface KanbanMountOptions {
  scope: string
  noteId: string | null
  editable: boolean
  writeBack?: KanbanWriter
  onOpenFullscreen?: (node: HTMLElement) => void
  onCloseFullscreen?: (node: HTMLElement) => void
  /**
   * Renders a card description as the host would render it in the note body. Injected rather than
   * imported: the markdown renderer already imports this module, so reaching back for it would close
   * a cycle. Absent means the host cannot render markdown (exports, snapshots), and the UI hides it.
   */
  renderDescription?: (source: string) => string
}

interface Assignment {
  node: HTMLElement
  entry: KanbanBlockEntry
}

const entries = new Map<string, KanbanBlockEntry>()
const listeners = new Set<(scope: string) => void>()
const scopeOptions = new Map<string, KanbanMountOptions>()
let pendingKey = 0

export function kanbanEntryKey(scope: string, index: number): string {
  return `${scope}#${index}`
}

export function kanbanEntryForNode(node: HTMLElement): KanbanBlockEntry | null {
  for (const entry of entries.values()) {
    if (entry.host === node) return entry
  }
  return null
}

export function subscribeKanbans(listener: (scope: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(scope: string): void {
  queueMicrotask(() => {
    for (const listener of [...listeners]) listener(scope)
  })
}

function assignEntries(nodes: HTMLElement[], options: KanbanMountOptions): Assignment[] {
  const taken = new Set<KanbanBlockEntry>()
  const assignments: Assignment[] = []

  for (const node of nodes) {
    const body = kanbanBody(node)
    const match = [...entries.values()].find(
      (e) => e.scope === options.scope && e.source === body && !taken.has(e),
    )
    if (match) {
      taken.add(match)
      assignments.push({ node, entry: match })
    }
  }

  for (const node of nodes) {
    if (assignments.some((a) => a.node === node)) continue
    const keyed = entries.get(kanbanEntryKey(options.scope, kanbanIndex(node)))
    if (keyed && !taken.has(keyed)) {
      taken.add(keyed)
      assignments.push({ node, entry: keyed })
      continue
    }
    const created = createEntry(node, options)
    taken.add(created)
    assignments.push({ node, entry: created })
  }

  for (const { node, entry } of assignments) {
    const index = kanbanIndex(node)
    const key = kanbanEntryKey(options.scope, index)
    if (entry.key !== key) entries.delete(entry.key)
    entry.key = key
    entry.index = index
    entries.set(key, entry)
  }

  return assignments
}

function createEntry(node: HTMLElement, options: KanbanMountOptions): KanbanBlockEntry {
  const created: KanbanBlockEntry = {
    key: `${options.scope}@new-${++pendingKey}`,
    scope: options.scope,
    noteId: options.noteId,
    index: kanbanIndex(node),
    host: node,
    source: kanbanBody(node),
    data: null,
    mode: 'json',
    editable: options.editable,
    owner: 'inline',
    container: null,
    root: null,
    ref: null,
    write: options.writeBack ?? null,
    dirty: false,
    unsaved: false,
    disposed: false,
    reserveHeight: null,
    timer: null,
    handlers: null,
    rendered: null,
  }
  entries.set(created.key, created)
  return created
}

/**
 * Tears one block's React root down. The unmount is deferred by a microtask because both callers run
 * inside the host tree's own commit — the preview re-renders, a block leaves the note, and React
 * refuses to take one root down from inside another root's render: it warns and leaves the teardown to
 * race the commit it interrupted.
 */
function disposeEntry(entry: KanbanBlockEntry): void {
  if (entry.timer !== null) window.clearTimeout(entry.timer)
  // Dying is a state, not just a teardown step: the session that hosts this board can still be open in
  // full screen, and the reader has to be told before the stage under it goes blank (announced where
  // the block left the document — see `mountKanbans`), and a late `moveBack` from that overlay's own
  // cleanup must not push the dead container back into a placeholder a fresh board may already own.
  entry.disposed = true
  const root = entry.root
  entry.root = null
  if (root) queueMicrotask(() => root.unmount())
}

/**
 * Everything the root reads, gathered so two renders can be compared before the second one happens.
 *
 * The preview remounts every block each time the editor settles: a keystroke elsewhere in the note
 * re-renders the markup and `mountKanbans` walks the blocks again, usually with the fence exactly as
 * it was. Rendering anyway is not wrong, but it reconciles a whole board — its header, its toolbar
 * and every mounted card — for a change that was never made, and on a board at the item ceiling that
 * is work the reader pays for while typing prose.
 */
function renderStamp(entry: KanbanBlockEntry, options: KanbanMountOptions): KanbanRenderStamp {
  return {
    source: entry.source,
    data: entry.data,
    unsaved: entry.unsaved,
    owner: entry.owner,
    noteId: entry.noteId,
    writable: entry.write !== null,
    renderDescription: options.renderDescription,
  }
}

function sameStamp(a: KanbanRenderStamp, b: KanbanRenderStamp): boolean {
  return a.source === b.source
    && a.data === b.data
    && a.unsaved === b.unsaved
    && a.owner === b.owner
    && a.noteId === b.noteId
    && a.writable === b.writable
    && a.renderDescription === b.renderDescription
}

/**
 * The handlers the root is given, kept on the entry and reused across renders.
 *
 * They read the mount options at call time rather than closing over one render's copy: the block
 * outlives any single `mountKanbans` pass, and the identity is what the memoized root compares.
 */
function entryHandlers(entry: KanbanBlockEntry): KanbanRootHandlers {
  const writable = entry.write !== null
  if (entry.handlers && entry.handlers.writable === writable) return entry.handlers
  const settle = () => {
    const options = scopeOptions.get(entry.scope)
    if (options) renderKanbanEntry(entry, options)
  }
  entry.handlers = {
    writable,
    onUpdateData: (next) => updateKanbanData(entry, () => next),
    onRetryWrite: writable ? () => {
      retryKanbanWrite(entry)
      settle()
    } : undefined,
    onDiscardWrite: writable ? () => {
      discardKanbanWrite(entry)
      settle()
    } : undefined,
    onToggleFullscreen: () => {
      const options = scopeOptions.get(entry.scope)
      if (!options) return
      // Read at call time, not at render time: the same block is the inline one and the overlay's,
      // and which door it opens depends on where it happens to be standing when it is clicked.
      if (entry.owner === 'overlay') options.onCloseFullscreen?.(entry.host)
      else options.onOpenFullscreen?.(entry.host)
    },
  }
  return entry.handlers
}

function renderKanbanEntry(entry: KanbanBlockEntry, options: KanbanMountOptions): void {
  if (!entry.root || !entry.data) return
  const stamp = renderStamp(entry, options)
  if (entry.rendered && sameStamp(entry.rendered, stamp)) return
  entry.rendered = stamp
  const inOverlay = entry.owner === 'overlay'
  const sourceResult = entry.unsaved ? parseKanbanBody(entry.source) : null
  const handlers = entryHandlers(entry)
  entry.root.render(
    createElement(
      KanbanRootBoundary,
      { source: entry.source },
      createElement(KanbanRoot, {
        initialData: entry.data,
        isFullscreen: inOverlay,
        kanbanName: entry.noteId || 'default',
        unsaved: entry.unsaved,
        sourceData: sourceResult && sourceResult.ok ? sourceResult.data : undefined,
        onRetryWrite: handlers.onRetryWrite,
        onDiscardWrite: handlers.onDiscardWrite,
        onUpdateData: handlers.onUpdateData,
        renderDescription: options.renderDescription,
        onToggleFullscreen: handlers.onToggleFullscreen,
      }),
    ),
  )
}

function mountBlock(node: HTMLElement, entry: KanbanBlockEntry, options: KanbanMountOptions): void {
  const body = kanbanBody(node)
  entry.host = node
  entry.noteId = options.noteId
  decorateKanbanControls(node)
  // Unwritten edits outrank the note body: a re-render must not re-point the
  // fence or re-parse over them, or retry and discard lose what they resolve.
  if (!entry.unsaved) {
    entry.ref = isKanbanWritableHere(node) ? { line: Number(node.dataset.line), body } : null
    entry.editable = options.editable && entry.ref !== null
  }
  entry.write = options.writeBack ?? null

  if (!entry.container) {
    entry.container = createKanbanCanvas(entry.editable)
    entry.root = createRoot(entry.container)
  }

  const placeholder = kanbanPlaceholder(node)
  if (placeholder && entry.container) {
    if (entry.owner === 'overlay') {
      if (placeholder.childElementCount === 0) placeholder.append(createKanbanReserve(entry.reserveHeight))
    } else if (entry.container.parentNode !== placeholder) {
      placeholder.replaceChildren(entry.container)
    }
  }

  if (!entry.unsaved && (entry.source !== body || !entry.data)) {
    entry.source = body
    const parsed = parseKanbanBody(body)
    if (!parsed.ok) {
      showKanbanError(node, parsed.error)
      return
    }
    entry.data = parsed.data
    entry.mode = parsed.mode
  }

  // The head's own name, from the body the parser just read (see `setKanbanHeadTitle`). A block that
  // kept its data — an unwritten edit outranks the body, so this pass did not re-parse — names itself
  // from that data instead.
  setKanbanHeadTitle(node, entry.data?.title)
  renderKanbanEntry(entry, options)
  markKanbanReady(node)
  notify(entry.scope)
}

export async function mountKanbans(root: HTMLElement, options: KanbanMountOptions): Promise<void> {
  scopeOptions.set(options.scope, options)
  const blocks = kanbanBlocks(root)
  const assignments = assignEntries(blocks, options)

  for (const { node, entry } of assignments) {
    markKanbanLoading(node)
    mountBlock(node, entry, options)
  }

  for (const [key, entry] of entries) {
    if (entry.scope === options.scope && !assignments.some((a) => a.entry === entry)) {
      disposeEntry(entry)
      entries.delete(key)
      notify(entry.scope)
    }
  }
}

export function updateKanbanData(entry: KanbanBlockEntry, updater: (prev: KanbanData) => KanbanData): void {
  if (!entry.data) return
  entry.data = updater(entry.data)
  // A rename is a write to the document like any other, and the block's head is where the note shows
  // the name — so it follows the data rather than the render that happens to be nearby.
  setKanbanHeadTitle(entry.host, entry.data.title)
  const opts = scopeOptions.get(entry.scope)
  const rerender = () => {
    if (opts) renderKanbanEntry(entry, opts)
  }
  scheduleKanbanWrite(entry, rerender)
  rerender()
}

function rerenderDeferred(entry: KanbanBlockEntry): void {
  // The move and the cleanup-time flush both run inside another root's commit —
  // rendering this root synchronously there races the commit, so the refresh is
  // deferred the same way a teardown is.
  queueMicrotask(() => {
    const options = scopeOptions.get(entry.scope)
    if (options) renderKanbanEntry(entry, options)
  })
}

/**
 * Hands the live board to the full screen overlay: the same root, so its edits,
 * history and write-back are the ones the inline block keeps using afterwards —
 * there is never a second copy of the same board to fall out of step.
 */
export function attachKanbanToOverlay(entry: KanbanBlockEntry, target: HTMLElement): void {
  if (!entry.container || entry.disposed) return
  entry.owner = 'overlay'
  // Measured while the canvas is still in the note: the block is as tall as its columns need, so the
  // stand-in has to be that height rather than a fixed one, or opening the overlay would jump the
  // note by however much the board does not use.
  entry.reserveHeight = Math.round(entry.container.getBoundingClientRect().height)
  entry.container.classList.add('is-fullscreen')
  target.append(entry.container)
  const placeholder = kanbanPlaceholder(entry.host)
  if (placeholder && placeholder.childElementCount === 0) {
    placeholder.append(createKanbanReserve(entry.reserveHeight))
  }
  rerenderDeferred(entry)
}

export function detachKanbanFromOverlay(entry: KanbanBlockEntry): void {
  if (!entry.container || entry.disposed) return
  entry.owner = 'inline'
  entry.container.classList.remove('is-fullscreen')
  const placeholder = kanbanPlaceholder(entry.host)
  if (placeholder) placeholder.replaceChildren(entry.container)
  rerenderDeferred(entry)
}

export async function retryKanban(node: HTMLElement): Promise<void> {
  const entry = kanbanEntryForNode(node)
  if (!entry) return
  const options = scopeOptions.get(entry.scope)
  if (!options) return
  mountBlock(node, entry, options)
}

export function flushKanbans(scope: string): void {
  for (const entry of entries.values()) {
    if (entry.scope !== scope) continue
    const unsavedBefore = entry.unsaved
    const result = flushKanbanEntry(entry)
    // A forced flush is where a conflict first surfaces outside the debounce
    // timer, so the header badge has to be refreshed from here too.
    if (result !== null && entry.unsaved !== unsavedBefore) rerenderDeferred(entry)
  }
}

export function destroyKanbans(scope: string): void {
  for (const [key, entry] of entries) {
    if (entry.scope === scope) {
      disposeEntry(entry)
      entries.delete(key)
    }
  }
  scopeOptions.delete(scope)
}
