import { t } from '../../i18n'
import { fenceBody } from '../fence-bodies'
import type { KanbanFenceRef } from './types'

export const KANBAN_BLOCK_SELECTOR = '[data-kanban]'
export const KANBAN_PLACEHOLDER_SELECTOR = '[data-kanban-placeholder]'
export const KANBAN_CANVAS_CLASS = 'kanban-canvas'
export const KANBAN_CANVAS_SELECTOR = '[data-kanban-canvas]'
export const KANBAN_FULLSCREEN_CLASS = 'kanban-fullscreen'

const CONTROL_ICONS: Record<string, string[]> = {
  'data-kanban-fullscreen': ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6'],
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function iconSvg(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const data of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', data)
    svg.append(path)
  }
  return svg
}

/**
 * The board's name, written into the block's own head.
 *
 * The head is the markup a fence renders, and that markup has no access to the body: a board's name
 * lives in the body's `title`, which only the parser can read. So the head used to write its own type
 * name there — the same word the board view's own tab carries, twice on one screen, with the name a
 * reader had given the board nowhere at all (user report 2026-09-23). The registry has the parsed body
 * and owns this chrome (it decorates the head's controls already), so it is the one that names it.
 *
 * No name means no element: an untitled board shows nothing rather than a placeholder, which also keeps
 * a translated string out of markup that nothing re-renders when the language changes.
 */
export function setKanbanHeadTitle(node: HTMLElement, title: string | undefined): void {
  const head = node.querySelector<HTMLElement>('.kanban-block-head')
  if (!head) return
  const trimmed = title?.trim()
  const existing = head.querySelector<HTMLElement>('.kanban-block-title')
  if (!trimmed) {
    existing?.remove()
    return
  }
  if (existing) {
    existing.textContent = trimmed
    return
  }
  const span = document.createElement('span')
  span.className = 'kanban-block-title'
  span.textContent = trimmed
  head.prepend(span)
}

export function decorateKanbanControls(node: HTMLElement): void {
  for (const [attribute, paths] of Object.entries(CONTROL_ICONS)) {
    const button = node.querySelector<HTMLElement>(`[${attribute}]`)
    if (button && !button.querySelector('svg')) button.append(iconSvg(paths))
  }
}

export function createKanbanCanvas(editable: boolean): HTMLElement {
  const container = document.createElement('div')
  container.className = KANBAN_CANVAS_CLASS
  container.dataset.kanbanCanvas = '1'
  container.setAttribute('role', 'region')
  container.setAttribute('aria-label', t('preview.kanban'))
  if (!editable) container.classList.add('is-readonly')
  return container
}

// While the live canvas sits in the full screen overlay, the inline placeholder
// shows this stand-in so the block keeps its height and does not collapse. It is
// told how tall the canvas was, because the block is as tall as its columns need
// rather than a fixed height; without a measurement it falls back to the cap.
export function createKanbanReserve(height?: number | null): HTMLElement {
  const reserve = document.createElement('div')
  reserve.className = `${KANBAN_CANVAS_CLASS} is-reserve`
  reserve.setAttribute('aria-hidden', 'true')
  if (typeof height === 'number' && height > 0) reserve.style.height = `${height}px`
  return reserve
}

export function kanbanBlocks(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(KANBAN_BLOCK_SELECTOR)]
}

export function kanbanBody(node: HTMLElement): string {
  return fenceBody(node, 'kanban', kanbanIndex(node)).replace(/\r\n/g, '\n').replace(/\n$/, '')
}

export function kanbanIndex(node: HTMLElement): number {
  const value = Number(node.dataset.kanbanIndex)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function kanbanPlaceholder(node: HTMLElement): HTMLElement | null {
  return node.querySelector<HTMLElement>(KANBAN_PLACEHOLDER_SELECTOR)
}

export function kanbanFenceRef(node: HTMLElement): KanbanFenceRef | null {
  const raw = node.dataset.line
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  return { line: Number(raw), body: kanbanBody(node) }
}

export function isKanbanWritableHere(node: HTMLElement): boolean {
  return Boolean(kanbanFenceRef(node)) && !node.closest('.note-embed-body, .markdown-example-preview')
}

/**
 * Take out the controls that answer only to a mounted board. The preview pane binds both of
 * them (features/preview/preview-interactions.ts) and asks the live instance; everywhere else
 * they are buttons that look pressable and do nothing.
 */
export function removeKanbanLiveControls(node: HTMLElement): void {
  node.querySelectorAll<HTMLElement>('[data-kanban-fullscreen], [data-kanban-retry]').forEach((control) => control.remove())
}

export function markKanbanLoading(node: HTMLElement): void {
  node.classList.add('loading')
  node.classList.remove('is-ready', 'has-error', 'kanban-source')
  node.setAttribute('aria-busy', 'true')
}

export function markKanbanReady(node: HTMLElement): void {
  node.classList.remove('loading', 'has-error', 'kanban-source')
  node.classList.add('is-ready')
  node.setAttribute('aria-busy', 'false')
}

export function showKanbanError(node: HTMLElement, detail: string): void {
  node.classList.remove('loading', 'is-ready')
  node.classList.add('has-error')
  node.setAttribute('aria-busy', 'false')
  const placeholder = kanbanPlaceholder(node) ?? node
  const wrap = document.createElement('div')
  wrap.className = 'kanban-error'
  const message = document.createElement('span')
  message.className = 'kanban-error-message'
  message.textContent = `${t('preview.kanban_render_failed')}: ${detail.slice(0, 500)}`
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'kanban-retry'
  retry.dataset.kanbanRetry = '1'
  retry.textContent = t('common.retry')
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = kanbanBody(node)
  pre.append(code)
  wrap.append(message, retry, pre)
  placeholder.replaceChildren(wrap)
}

/**
 * The answer for a surface that will never mount the board: the fence body it was
 * rendered from, with the controls that need a live instance taken out. Without it
 * such a block sits at "Loading kanban…" forever, which is a promise the surface
 * cannot keep.
 */
function showKanbanSource(node: HTMLElement): void {
  removeKanbanLiveControls(node)
  node.classList.remove('loading', 'has-error', 'is-ready')
  node.classList.add('kanban-source')
  node.setAttribute('aria-busy', 'false')
  const placeholder = kanbanPlaceholder(node) ?? node
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = kanbanBody(node)
  pre.append(code)
  placeholder.replaceChildren(pre)
}

export function showKanbanSourceAll(root: ParentNode): void {
  kanbanBlocks(root).forEach(showKanbanSource)
}
