import { escapeHtml } from '../../lib/markdown/renderer'
import { MAX_PANEL_COLUMNS, colsRatioLabel, colsRatioPresets, parseColsRatio } from '../../lib/markdown/panel-options'
import type { AlignValue, ColsGap } from '../../lib/markdown/panel-options'
import { t } from '../../lib/i18n'
import type { MessageKey } from '../../lib/i18n'
import {
  blockActionSource,
  closeBlockOverlayFromEvent,
  dismissBlockOverlays,
  setBlockOverlay,
  toggleBlockOverlay,
  type BlockActionContext,
  type BlockOverlaySpec,
  type BlockToast,
  type BlockToolbarModule,
} from './block-overlay'
import { setColumnCount, setColumnTracks, updateAlignHeader, updateColsHeader } from './panel-source'

/**
 * The settings toolbar for the `:::` layout blocks: an alignment block and a column block.
 *
 * Both are wrapped rather than given a header of their own, because the block's own markup is what the
 * prose stylesheet draws and inserting chrome into it would be drawn too. Every edit rewrites the note's
 * header line — the block's whole state — so the change survives a reload, a share and an export.
 */

const PANEL_BLOCK = '.panel-block'
const LAYOUT_BLOCK = '.markdown-align[data-line], .markdown-cols[data-line]'
const ALIGN_WORDS: AlignValue[] = ['left', 'center', 'right', 'justify']
const ALIGN_KEYS: Record<AlignValue, MessageKey> = {
  left: 'workspace.align_left',
  center: 'workspace.align_center',
  right: 'workspace.align_right',
  justify: 'workspace.align_justify',
}
const GAPS: Array<[ColsGap, MessageKey]> = [
  ['narrow', 'preview.panel_gap_narrow'],
  ['normal', 'preview.panel_gap_normal'],
  ['wide', 'preview.panel_gap_wide'],
]

const OVERLAY_SPEC: BlockOverlaySpec = {
  block: PANEL_BLOCK,
  panels: { settings: '.block-settings' },
  triggers: { settings: '[data-panel-action="toggle-settings"]' },
  openClasses: { settings: 'is-block-settings-open' },
  materialize: materializeSettings,
}

const SETTINGS_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>'

function panelBlock(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(LAYOUT_BLOCK)
}

function isCols(block: HTMLElement): boolean {
  return block.classList.contains('markdown-cols')
}

function optionButton(action: string, value: string, label: string, active: boolean, disabled = false): string {
  return `<button type="button" class="block-opt-btn${active ? ' is-active' : ''}" data-panel-action="${action}" data-panel-val="${escapeHtml(value)}" aria-pressed="${active}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
}

function settingsRow(label: string, content: string): string {
  return `<div class="block-settings-row"><span class="block-settings-title">${escapeHtml(label)}</span><div class="block-settings-group">${content}</div></div>`
}

function alignRow(current: string | null): string {
  return settingsRow(t('workspace.alignment'), ALIGN_WORDS.map((word) => optionButton('set-align', word, t(ALIGN_KEYS[word]), current === word)).join(''))
}

function colsRows(block: HTMLElement): string {
  const columns = Number(block.dataset.cols) || 1
  const gap = (block.dataset.colsGap ?? 'normal') as ColsGap
  const divider = block.hasAttribute('data-cols-divider')
  const ratio = colsRatioLabel(block.dataset.colsTracks ?? null)
  // Every preset keeps the reader's column count: a width list with a different number of parts would
  // fold columns the reader can see, and reshaping is the stepper's job, not this row's.
  const ratioButtons = [
    optionButton('set-ratio', '', t('preview.panel_ratio_equal'), ratio === ''),
    ...colsRatioPresets(columns).map((preset) => optionButton('set-ratio', preset, preset, ratio === preset)),
  ].join('')
  const ratioFields = [
    `<input type="text" class="block-text-input is-narrow" data-panel-ratio-input maxlength="13" value="${escapeHtml(ratio)}" placeholder="1:2" aria-label="${escapeHtml(t('preview.panel_ratio'))}">`,
    `<button type="button" class="block-opt-btn" data-panel-action="apply-ratio">${escapeHtml(t('preview.panel_ratio_apply'))}</button>`,
  ].join('')
  return [
    settingsRow(t('preview.panel_columns'), `${optionButton('columns-remove', '', t('preview.panel_fewer'), false, columns <= 1)}<span class="block-settings-value">${columns}</span>${optionButton('columns-add', '', t('preview.panel_more'), false, columns >= MAX_PANEL_COLUMNS)}`),
    settingsRow(t('preview.panel_ratio'), ratioButtons),
    `<div class="block-settings-row is-column"><div class="block-settings-group is-fields">${ratioFields}</div></div>`,
    settingsRow(t('preview.panel_gap'), GAPS.map(([value, key]) => optionButton('set-gap', value, t(key), gap === value)).join('')),
    settingsRow(t('preview.panel_divider'), `${optionButton('set-divider', 'on', t('preview.panel_divider_on'), divider)}${optionButton('set-divider', 'off', t('preview.panel_divider_off'), !divider)}`),
    alignRow(block.dataset.colsAlign ?? null),
  ].join('')
}

function renderChrome(block: HTMLElement, panelId: string): string {
  const title = escapeHtml(t(isCols(block) ? 'workspace.columns' : 'workspace.alignment'))
  const settings = escapeHtml(t('preview.panel_settings'))
  return [
    `<div class="block-head">`,
    `<span class="block-head-title">${title}</span>`,
    `<span class="block-tools">`,
    `<button type="button" class="block-tool-btn" data-panel-action="toggle-settings" title="${settings}" aria-label="${settings}" aria-expanded="false" aria-controls="${panelId}">${SETTINGS_ICON}</button>`,
    `</span>`,
    `</div>`,
    `<div class="block-settings" id="${panelId}" hidden></div>`,
  ].join('')
}

function materializeSettings(wrapper: HTMLElement): void {
  const panel = wrapper.querySelector<HTMLElement>(':scope > .block-settings')
  const block = panelBlock(wrapper)
  if (!panel || !block || panel.dataset.rendered) return
  panel.innerHTML = isCols(block) ? colsRows(block) : alignRow(block.dataset.align ?? null)
  panel.dataset.rendered = 'true'
}

/** Commits one header rewrite, or tells the reader the block moved out from under the toolbar. */
function commit(
  block: HTMLElement,
  content: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
  rewrite: (source: string, line: number) => string | null,
): boolean {
  const line = Number(block.dataset.line)
  const next = Number.isInteger(line) && line >= 0 ? rewrite(content, line) : null
  if (next === null) {
    toast({ title: t('preview.panel_edit_unavailable'), tone: 'warning' })
    return true
  }
  setBlockOverlay(OVERLAY_SPEC, block.closest<HTMLElement>(PANEL_BLOCK) ?? block, null)
  onEdit(next)
  return true
}

export function executePanelAction(
  action: string,
  targetEl: HTMLElement,
  content: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
): boolean {
  const wrapper = targetEl.closest<HTMLElement>(PANEL_BLOCK)
  const block = wrapper ? panelBlock(wrapper) : null
  if (!wrapper || !block) return false
  if (action === 'toggle-settings') {
    toggleBlockOverlay(OVERLAY_SPEC, wrapper, 'settings')
    return true
  }
  const value = targetEl.dataset.panelVal ?? ''
  const cols = isCols(block)
  if (action === 'set-align') {
    if (!cols) return commit(block, content, onEdit, toast, (source, line) => updateAlignHeader(source, line, value as AlignValue))
    return commit(block, content, onEdit, toast, (source, line) => updateColsHeader(source, line, (current) => ({ ...current, align: value as AlignValue })))
  }
  if (!cols) return false
  if (action === 'set-gap' && GAPS.some(([gap]) => gap === value)) {
    return commit(block, content, onEdit, toast, (source, line) => updateColsHeader(source, line, (current) => ({ ...current, gap: value as ColsGap })))
  }
  if (action === 'set-divider') {
    const wanted = value === 'on'
    return commit(block, content, onEdit, toast, (source, line) => updateColsHeader(source, line, (current) => ({ ...current, divider: wanted })))
  }
  if (action === 'columns-add' || action === 'columns-remove') {
    // The stepper moves the number the reader can see, which is the count the block actually draws,
    // so a header that over-states its own body cannot make one click jump several columns.
    const current = Number(block.dataset.cols)
    if (!Number.isInteger(current) || current < 1) return commit(block, content, onEdit, toast, () => null)
    const next = current + (action === 'columns-add' ? 1 : -1)
    return commit(block, content, onEdit, toast, (source, line) => setColumnCount(source, line, next))
  }
  if (action === 'set-ratio' || action === 'apply-ratio') {
    const text = action === 'apply-ratio' ? (wrapper.querySelector<HTMLInputElement>('[data-panel-ratio-input]')?.value ?? '') : value
    if (!text) return commit(block, content, onEdit, toast, (source, line) => setColumnTracks(source, line, null))
    const tracks = parseColsRatio(text)
    // The count stays the stepper's business: a width list that does not have one part per column
    // would reshape the block, so it is refused rather than applied.
    if (!tracks || tracks.split(' ').length !== Number(block.dataset.cols || 1)) {
      toast({ title: t('preview.panel_ratio_invalid'), tone: 'warning' })
      return true
    }
    return commit(block, content, onEdit, toast, (source, line) => setColumnTracks(source, line, tracks))
  }
  return false
}

export function enhancePanelToolbarsInRoot(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(LAYOUT_BLOCK).forEach((block) => {
    if (block.closest('.note-embed-body') || block.parentElement?.classList.contains('panel-block')) return
    const wrapper = document.createElement('div')
    wrapper.className = 'panel-block'
    wrapper.innerHTML = renderChrome(block, `panel-settings-${block.dataset.line ?? '0'}`)
    block.replaceWith(wrapper)
    wrapper.append(block)
  })
}

export function dismissPanelOverlays(target: HTMLElement): void {
  dismissBlockOverlays(OVERLAY_SPEC, target)
}

export const panelBlockToolbar: BlockToolbarModule = {
  enhance: enhancePanelToolbarsInRoot,
  dismiss: dismissPanelOverlays,
  close: (target) => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
  handle: (event, target, ctx: BlockActionContext) => {
    const button = target.closest<HTMLButtonElement>('[data-panel-action]')
    if (!button) return false
    event.preventDefault()
    const editable = blockActionSource(ctx)
    if (!editable) return true
    return executePanelAction(
      button.dataset.panelAction!,
      button,
      editable.source,
      (next) => ctx.api.editContent(editable.noteId, next),
      ctx.api.toast,
    )
  },
}
