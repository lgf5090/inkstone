import { escapeAttr, escapeHtml } from '../../lib/markdown/renderer'
import { t } from '../../lib/i18n'
import type { MessageKey } from '../../lib/i18n'
import {
  MEDIA_MAX_ROW_HEIGHT,
  MEDIA_MIN_ROW_HEIGHT,
  parseMediaOptions,
  parseMediaRow,
} from '../../lib/markdown/media-layout'
import type { MediaAlign, MediaBlockOptions, MediaFit, MediaGap, MediaRadius, MediaRowOptions } from '../../lib/markdown/media-layout'
import { mediaOptionsFromDOM, mediaRowFromDOM } from '../../lib/markdown/media-layout-view'
import { splitLines } from '../../lib/markdown/fence-edit'
import {
  applyMediaEdit,
  editAddRow,
  editBlockOptions,
  editBlockWidth,
  editMoveCell,
  editRemoveRow,
  editRowOptions,
  editTakeCellOut,
  editUnwrapBlock,
  locateMediaBlock,
} from '../../lib/markdown/media-layout-source'
import type { MediaEdit } from '../../lib/markdown/media-layout-source'
import {
  blockActionSource,
  closeBlockOverlayFromEvent,
  dismissBlockOverlays,
  setBlockOverlay,
  toggleBlockOverlay,
  type BlockOverlaySpec,
  type BlockToast,
  type BlockToolbarModule,
  type BlockToolbarOptions,
} from './block-overlay'

/**
 * The settings bar of a `::: media` layout block.
 *
 * A block keeps its configuration on its header line plus one group per row, so every button here rewrites
 * a line the reader can see in the source. That is why the same control works from the reading view, a
 * split pane and the live editor, and why the change survives a reload, a share and an export with no
 * second copy of the answer stored anywhere.
 *
 * The panel is built when it is first opened: a note can hold dozens of blocks, and the row-by-row and
 * picture-by-picture controls are DOM nobody asks for until they decide to resize something.
 */

const MEDIA_BLOCK = '.markdown-media[data-media][data-line]'
type Choice = 'none' | 'left' | 'right';

const WRAPS: Array<[Choice, MessageKey]> = [
  ['none', 'preview.media_wrap_none'],
  ['left', 'preview.media_wrap_left'],
  ['right', 'preview.media_wrap_right'],
]
const WIDTH_CHOICES = ['full', '30', '40', '50', '60', '80']
const ALIGNS: Array<[MediaAlign, MessageKey]> = [
  ['left', 'workspace.align_left'],
  ['center', 'workspace.align_center'],
  ['right', 'workspace.align_right'],
]
const FITS: Array<[MediaFit, MessageKey]> = [
  ['contain', 'preview.media_fit_contain'],
  ['cover', 'preview.media_fit_cover'],
  ['fill', 'preview.media_fit_fill'],
  ['none', 'preview.media_fit_none'],
]
const GAPS: Array<[MediaGap, MessageKey]> = [
  ['narrow', 'preview.panel_gap_narrow'],
  ['normal', 'preview.panel_gap_normal'],
  ['wide', 'preview.panel_gap_wide'],
]
const RADII: Array<[MediaRadius, MessageKey]> = [
  ['none', 'preview.media_corner_square'],
  ['md', 'preview.media_corner_rounded'],
  ['full', 'preview.media_corner_circle'],
]
const RATIOS = ['none', '1:1', '4:3', '16:9', '3:2']
const COLUMNS = ['none', '2', '3', '4']
const ROW_HEIGHTS = [180, 260, 340, 460]

/** The one-click width lists a row of this many pictures can use: one picture twice as wide, either end. */
export function rowWidthPresets(cells: number): number[][] {
  if (cells < 2 || cells > 4) return [];
  const run = (first: boolean): number[] =>
    Array.from({ length: cells }, (_unused, index) => (first ? index === 0 : index === cells - 1) ? 2 : 1);
  return [run(false), run(true)]
}

function ratioLabel(value: string): string {
  return value === 'none' ? t('preview.media_ratio_auto') : value;
}

function columnLabel(value: string): string {
  return value === 'none' ? t('preview.media_columns_off') : value;
}

function widthLabel(value: string): string {
  return value === 'full' ? t('preview.media_width_full') : `${value}%`;
}

function optionButton(action: string, value: string, label: string, active: boolean, disabled = false): string {
  return `<button type="button" class="block-opt-btn${active ? ' is-active' : ''}" data-media-action="${escapeAttr(action)}" data-media-val="${escapeAttr(value)}" aria-pressed="${active}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
}

function iconButton(action: string, value: string, label: string, icon: string, disabled = false): string {
  return `<button type="button" class="block-icon-opt" data-media-action="${escapeAttr(action)}" data-media-val="${escapeAttr(value)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"${disabled ? ' disabled' : ''}>${icon}</button>`
}

function settingsRow(label: string, content: string): string {
  return `<div class="block-settings-row"><span class="block-settings-title">${escapeHtml(label)}</span><div class="block-settings-group">${content}</div></div>`
}

const ARROW_UP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>'
const ARROW_DOWN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>'
const ARROW_OUT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M3 21 21 3"/></svg>'
const SETTINGS_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>'
const UNWRAP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>'

function wrapRow(options: MediaBlockOptions): string {
  return settingsRow(t('preview.media_wrap'), WRAPS.map(([value, key]) => optionButton('set-wrap', value, t(key), (options.wrap ?? 'none') === value)).join(''))
}

function widthRow(options: MediaBlockOptions): string {
  const buttons = WIDTH_CHOICES
    .map((value) => optionButton('set-width', value, widthLabel(value), value === 'full' ? options.width === null : options.width === Number(value)))
    .join('')
  return settingsRow(t('preview.media_width'), buttons)
}

function gapRow(options: MediaBlockOptions): string {
  return settingsRow(t('preview.panel_gap'), GAPS.map(([value, key]) => optionButton('set-gap', value, t(key), options.gap === value)).join(''))
}

/** Everything the header can say, one row of buttons per word. */
function blockRows(options: MediaBlockOptions): string {
  return [
    wrapRow(options),
    widthRow(options),
    settingsRow(t('preview.media_align'), ALIGNS.map(([value, key]) => optionButton('set-align', value, t(key), options.align === value)).join('')),
    settingsRow(t('preview.media_auto_columns'), COLUMNS.map((value) => optionButton('set-columns', value, columnLabel(value), value === 'none' ? options.columns === null : options.columns === Number(value))).join('')),
    gapRow(options),
    settingsRow(t('preview.media_fit'), FITS.map(([value, key]) => optionButton('set-fit', value, t(key), options.fit === value)).join('')),
    settingsRow(t('preview.media_ratio'), RATIOS.map((value) => optionButton('set-ratio', value, ratioLabel(value), value === 'none' ? options.ratio === null : options.ratio === value)).join('')),
    settingsRow(t('preview.media_corner'), RADII.map(([value, key]) => optionButton('set-radius', value, t(key), options.radius === value)).join('')),
    settingsRow(t('preview.media_edge'), [
      optionButton('set-border', 'on', t('preview.media_edge'), options.border),
      optionButton('set-shadow', 'on', t('preview.media_shadow'), options.shadow),
      optionButton('set-plain', 'on', t('preview.media_edge_off'), !options.border && !options.shadow),
    ].join('')),
    settingsRow(t('preview.media_caption'), [
      optionButton('set-caption', 'on', t('preview.media_caption_on'), options.caption),
      optionButton('set-caption', 'off', t('preview.media_caption_off'), !options.caption),
      optionButton('set-caption-align', 'left', t('workspace.align_left'), options.captionAlign === 'left'),
      optionButton('set-caption-align', 'center', t('workspace.align_center'), options.captionAlign === 'center'),
    ].join('')),
    settingsRow(t('preview.media_numbered'), [
      optionButton('set-numbered', 'on', t('preview.media_caption_on'), options.numbered),
      optionButton('set-numbered', 'off', t('preview.media_caption_off'), !options.numbered),
    ].join('')),
    settingsRow(t('preview.media_reset'), optionButton('reset', '', t('preview.media_reset'), false)),
  ].join('')
}

/**
 * One section per picture row of the block.
 *
 * A row is addressed by the note line it was drawn from rather than by its place in the block, so a height
 * written onto the second row still lands on the second row after the reader adds one above it.
 */
function rowSection(block: HTMLElement): string {
  const rows = [...block.querySelectorAll<HTMLElement>(':scope > .markdown-media-row')]
  if (!rows.length) return ''
  // A columned block lays its pictures out on the block's own grid, so its rows generate no box: a height,
  // a share or an alignment written onto one of them would sit in the note changing nothing. Only the
  // structural controls survive there.
  const grid = block.hasAttribute('data-media-columns')
  return rows.map((row, index) => {
    const line = Number(row.dataset.line)
    const current = mediaRowFromDOM(row)
    const heights = grid ? '' : [
      optionButton('row-height', `${line}:auto`, t('preview.media_row_height_auto'), current.height === null),
      ...ROW_HEIGHTS.map((value) => optionButton('row-height', `${line}:${value}`, String(value), current.height === value)),
    ].join('')
    const widths = !grid && current.cells >= 2
      ? [
        optionButton('row-widths', `${line}:equal`, t('preview.panel_ratio_equal'), current.weights.length === 0),
        ...rowWidthPresets(current.cells).map((preset) => {
          const list = preset.join(':')
          return optionButton('row-widths', `${line}:${list}`, list, current.weights.join(':') === list)
        }),
      ].join('')
      : ''
    const placement = grid ? '' : ALIGNS.map(([value, key]) => optionButton('row-align', `${line}:${value}`, t(key), current.align === value)).join('')
    const cells = [...row.querySelectorAll<HTMLElement>(':scope > .markdown-media-cell')]
    const moves = cells.map((_cell, cellIndex) => {
      const value = `${line}:${cellIndex}`
      return [
        iconButton('cell-move', `up:${value}`, t('preview.media_cell_up'), ARROW_UP, cellIndex === 0 && index === 0),
        iconButton('cell-move', `down:${value}`, t('preview.media_cell_down'), ARROW_DOWN, cellIndex === cells.length - 1 && index === rows.length - 1),
        iconButton('cell-out', value, t('preview.media_cell_out'), ARROW_OUT),
      ].join('')
    }).join('')
    return [
      heights || widths
        ? settingsRow(t('preview.media_row_value0', { value0: index + 1 }), `${heights}${widths ? ` ${widths}` : ''}`)
        : '',
      placement ? settingsRow(t('preview.media_align'), placement) : '',
      moves ? `<div class="block-settings-row"><div class="block-settings-group">${moves}</div></div>` : '',
      settingsRow(t('preview.media_row'), optionButton('row-remove', String(line), t('preview.media_row_remove'), false, rows.length < 2)),
    ].join('')
  }).join('') + settingsRow(t('preview.media_row_add'), optionButton('row-add', 'end', t('preview.media_row_add'), false))
}

function headMarkup(block: HTMLElement, panelId: string): string {
  const title = block.hasAttribute('data-media-text') ? t('preview.media_settings') : t('workspace.media_layout')
  const settings = escapeAttr(t('preview.media_settings'))
  const unwrap = escapeAttr(t('preview.media_unwrap'))
  const hint = escapeAttr(t('preview.media_drag_hint'))
  return [
    `<div class="block-head" title="${hint}">`,
    `<span class="block-head-title">${escapeHtml(title)}</span>`,
    `<span class="block-tools">`,
    `<button type="button" class="block-tool-btn" data-media-action="toggle-settings" title="${settings}" aria-label="${settings}" aria-expanded="false" aria-controls="${escapeAttr(panelId)}">${SETTINGS_ICON}</button>`,
    `<button type="button" class="block-tool-btn" data-media-action="unwrap" title="${unwrap}" aria-label="${unwrap}">${UNWRAP_ICON}</button>`,
    `</span>`,
    `</div>`,
    `<div class="block-settings" id="${escapeAttr(panelId)}" hidden></div>`,
  ].join('')
}

/**
 * The frame's own drag surfaces.
 *
 * Only the edges are built here. The strip between two pictures has to know where a picture ends, and on a
 * detached staging tree every rectangle is zero, so a strip placed from one would sit at the row's left
 * edge forever; the pointer pass builds those on the live host, where a measurement means something.
 *
 * A columned block keeps its right edge — the block still sizes itself — but loses the bottom and the
 * corner, because the only thing those write is a row height and a row there is no box for.
 */
function handleMarkup(grid: boolean): string {
  const width = escapeAttr(t('preview.media_width'))
  const height = escapeAttr(t('preview.media_row_height'))
  const both = escapeAttr(t('preview.media_block_handles'))
  return [
    `<div class="media-handles">`,
    `<button type="button" class="media-edge media-edge-right" data-media-handle="width" aria-label="${width}"></button>`,
    grid ? '' : `<button type="button" class="media-edge media-edge-bottom" data-media-handle="height" aria-label="${height}"></button>`,
    grid ? '' : `<button type="button" class="media-edge media-edge-corner" data-media-handle="both" aria-label="${both}"></button>`,
    `</div>`,
  ].join('')
}

function materializePanel(block: HTMLElement): void {
  const panel = block.querySelector<HTMLElement>(':scope > .block-settings')
  if (!panel || panel.dataset.rendered) return
  const options = mediaOptionsFromDOM(block)
  panel.innerHTML = block.hasAttribute('data-media-text')
    ? `${wrapRow(options)}${widthRow(options)}${gapRow(options)}`
    : `${blockRows(options)}${rowSection(block)}`
  panel.dataset.rendered = 'true'
}

const OVERLAY_SPEC: BlockOverlaySpec = {
  block: MEDIA_BLOCK,
  panels: { settings: ':scope > .block-settings' },
  triggers: { settings: ':scope > .block-head [data-media-action="toggle-settings"]' },
  openClasses: { settings: 'is-block-settings-open' },
  materialize: materializePanel,
}

export function headerLineOf(target: Element): number | null {
  const block = target.closest<HTMLElement>(MEDIA_BLOCK)
  if (!block) return null
  const line = Number(block.dataset.line)
  return Number.isInteger(line) && line >= 0 ? line : null
}

function commit(
  edit: MediaEdit | null,
  source: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
  done?: string,
): boolean {
  if (edit === null) {
    toast({ title: t('preview.media_edit_unavailable'), tone: 'warning' })
    return true
  }
  onEdit(applyMediaEdit(source, edit))
  if (done) toast({ title: done, tone: 'success' })
  return true
}

function updateOptions(
  target: Element,
  source: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
  update: (current: MediaBlockOptions) => MediaBlockOptions,
  done?: string,
): boolean {
  const line = headerLineOf(target)
  if (line === null) return false
  return commit(editBlockOptions(source, line, update), source, onEdit, toast, done)
}

/** The row-addressed values are `line:…` pairs, so they come back apart the same way they went in. */
function rowLineOf(value: string): number {
  return Number(value.split(':')[0]);
}

function editRowAt(target: Element, source: string, value: string, update: (current: MediaRowOptions, cells: number) => MediaRowOptions): MediaEdit | null {
  const line = headerLineOf(target)
  const rowLine = rowLineOf(value)
  if (line === null || !Number.isInteger(rowLine)) return null
  return editRowOptions(source, line, rowLine, update)
}

function cellsOnLine(source: string, rowLine: number): number {
  const lines = splitLines(source).lines
  const row = parseMediaRow(lines[rowLine] ?? '')
  return row ? row.cells.length : 0
}

export function executeMediaAction(
  action: string,
  target: Element,
  source: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
): boolean {
  const value = (target as HTMLElement).dataset?.mediaVal ?? ''
  const line = headerLineOf(target)
  if (line === null) return false
  if (action === 'toggle-settings') {
    const block = target.closest<HTMLElement>(MEDIA_BLOCK)
    if (block) toggleBlockOverlay(OVERLAY_SPEC, block, "settings")
    return true
  }
  if (action === 'unwrap') return commit(editUnwrapBlock(source, line), source, onEdit, toast, t('preview.media_unwrap_done'))
  if (action === 'reset') return updateOptions(target, source, onEdit, toast, () => ({ ...parseMediaOptions('') }), t('preview.media_reset_done'))
  if (action === 'set-wrap') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, wrap: value === 'none' ? null : value === 'right' ? 'right' : 'left' }))
  if (action === 'set-align') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, align: value as MediaAlign }))
  if (action === 'set-fit') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, fit: value as MediaFit }))
  if (action === 'set-gap') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, gap: value as MediaGap }))
  if (action === 'set-radius') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, radius: value as MediaRadius }))
  if (action === 'set-caption-align') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, captionAlign: value === 'left' ? 'left' : 'center' }))
  if (action === 'set-border') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, border: value === 'on' }))
  if (action === 'set-shadow') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, shadow: value === 'on' }))
  if (action === 'set-plain') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, border: false, shadow: false }))
  if (action === 'set-caption') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, caption: value === 'on' }))
  if (action === 'set-numbered') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, numbered: value === 'on' }))
  if (action === 'set-ratio') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, ratio: value === 'none' ? null : value }))
  if (action === 'set-columns') return updateOptions(target, source, onEdit, toast, (c) => ({ ...c, columns: value === 'none' ? null : Number(value) }))
  if (action === 'set-width') return commit(editBlockWidth(source, line, value === 'full' ? null : Number(value)), source, onEdit, toast)

  if (action === 'row-height') {
    const height = value.split(':')[1]
    return commit(editRowAt(target, source, value, (current) => ({
      ...current,
      height: height === 'auto' ? null : clampHeight(Number(height)),
    })), source, onEdit, toast)
  }
  if (action === 'row-widths') {
    const list = value.split(':').slice(1).join(':')
    return commit(editRowAt(target, source, value, (current, cells) => ({
      ...current,
      weights: list === 'equal' ? [] : list.split(':').map(Number).slice(0, cells),
    })), source, onEdit, toast)
  }
  if (action === 'row-align') {
    const [rowText, align] = value.split(':')
    const rowLine = Number(rowText)
    if (!Number.isInteger(rowLine)) return true
    return commit(editRowOptions(source, line, rowLine, (current) => ({
      ...current,
      align: current.align === align ? null : (align as MediaAlign),
    })), source, onEdit, toast)
  }
  if (action === 'row-remove') return commit(editRemoveRow(source, line, Number(value)), source, onEdit, toast)
  if (action === 'row-add') {
    const block = target.closest<HTMLElement>(MEDIA_BLOCK)
    const last = block?.querySelector<HTMLElement>(':scope > .markdown-media-row:last-of-type')
    return commit(editAddRow(source, line, Number(last?.dataset.line ?? line)), source, onEdit, toast)
  }
  if (action === 'cell-out') {
    const [rowText, indexText] = value.split(':')
    return commit(editTakeCellOut(source, line, Number(rowText), Number(indexText)), source, onEdit, toast)
  }
  if (action === 'cell-move') {
    const [direction, rowText, indexText] = value.split(':')
    const rowLine = Number(rowText)
    const index = Number(indexText)
    if (!Number.isInteger(rowLine) || !Number.isInteger(index)) return true
    const block = locateMediaBlock(source, line)
    const rows = block?.rowLines ?? []
    const at = rows.indexOf(rowLine)
    const neighbour = rows[at + (direction === 'up' ? -1 : 1)]
    if (neighbour === undefined) return true
    // A picture moving to another row joins it at the end: the button says which row it goes to, and the
    // row it leaves keeps its own order, so nothing is placed somewhere the reader never pointed.
    const to = { line: neighbour, index: cellsOnLine(source, neighbour) }
    return commit(editMoveCell(source, line, { line: rowLine, index }, to), source, onEdit, toast)
  }
  return false
}

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return 260;
  return Math.min(MEDIA_MAX_ROW_HEIGHT, Math.max(MEDIA_MIN_ROW_HEIGHT, Math.round(value)))
}

/** Builds each block's head, its panel placeholder and the frame's drag edges. */
export function enhanceMediaLayouts(root: HTMLElement, options: BlockToolbarOptions): void {
  if (!options.mediaToolbar) return
  root.querySelectorAll<HTMLElement>(MEDIA_BLOCK).forEach((block) => {
    if (block.closest('.note-embed-body') || block.querySelector(':scope > .block-head')) return
    block.classList.add('has-media-chrome')
    const line = block.dataset.line ?? '0'
    const wrapper = document.createElement('div')
    wrapper.innerHTML = `${headMarkup(block, `media-settings-${line}`)}${handleMarkup(block.hasAttribute('data-media-columns'))}`
    const nodes = [...wrapper.childNodes]
    const head = nodes.shift()
    if (head) block.prepend(head)
    nodes.forEach((node) => block.append(node))
  })
}

/**
 * Which panels were open, and which control inside them had the focus.
 *
 * A press rewrites the note, the note re-renders, and without this the panel a reader is working in would
 * shut on every button. The focused control is remembered by its action and value so the keyboard returns
 * to the same button rather than to the top of the block.
 */
export interface MediaPanelState {
  open: Map<string, boolean>
  focus: Map<string, string>
}

export function mediaPanelStates(root: HTMLElement | null): MediaPanelState {
  const open = new Map<string, boolean>()
  const focus = new Map<string, string>()
  if (!root) return { open, focus }
  root.querySelectorAll<HTMLElement>(MEDIA_BLOCK).forEach((block) => {
    const key = block.dataset.line ?? 'unmapped'
    open.set(key, block.classList.contains('is-block-settings-open'))
    const pressed = block.querySelector<HTMLElement>('[data-media-action]:focus')
    if (pressed) focus.set(key, `${pressed.dataset.mediaAction}|${pressed.dataset.mediaVal ?? ''}`)
  })
  return { open, focus }
}

export function applyMediaPanelStates(root: HTMLElement, state: MediaPanelState): void {
  root.querySelectorAll<HTMLElement>(MEDIA_BLOCK).forEach((block) => {
    const key = block.dataset.line ?? 'unmapped'
    if (!state.open.get(key)) return
    setBlockOverlay(OVERLAY_SPEC, block, 'settings')
    const pressed = state.focus.get(key)
    if (!pressed) return
    const [action, value] = pressed.split('|')
    const candidate = block.querySelector<HTMLElement>(`[data-media-action="${CSS.escape(action)}"][data-media-val="${CSS.escape(value)}"]`)
      ?? block.querySelector<HTMLElement>(`[data-media-action="${CSS.escape(action)}"]`)
    candidate?.focus({ preventScroll: true })
  })
}

export const mediaLayoutToolbar: BlockToolbarModule = {
  enhance: enhanceMediaLayouts,
  dismiss: (target) => dismissBlockOverlays(OVERLAY_SPEC, target),
  close: (target) => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
  handle: (event, target, ctx) => {
    const button = target.closest<HTMLElement>('[data-media-action]')
    if (!button) return false
    event.preventDefault()
    const editable = blockActionSource(ctx)
    if (!editable) return true
    return executeMediaAction(
      button.dataset.mediaAction!,
      button,
      editable.source,
      (next) => ctx.api.editContent(editable.noteId, next),
      ctx.api.toast,
    )
  },
}
