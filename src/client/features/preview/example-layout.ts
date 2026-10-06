import { escapeAttr, escapeHtml } from '../../lib/markdown/renderer'
import {
  EXAMPLE_RATIO_PRESETS,
  EXAMPLE_SPLIT_DEFAULTS,
  exampleRatioLabel,
  formatExampleSplitInfo,
  isExampleLayout,
  parseExampleRatio,
  parseExampleSplit,
} from '../../lib/markdown/example-split'
import type { ExampleFamily, ExampleLayout, ExampleSplitOptions } from '../../lib/markdown/example-split'
import { applyFencePatchAtSource, fenceAt } from '../../lib/markdown/fence-edit'
import { t } from '../../lib/i18n'
import {
  blockActionSource,
  closeBlockOverlayFromEvent,
  dismissBlockOverlays,
  setBlockOverlay,
  toggleBlockOverlay,
  type BlockOverlaySpec,
  type BlockToast,
  type BlockToolbarModule,
} from './block-overlay'

const LAYOUTS: ExampleLayout[] = ['lr', 'rl', 'tb', 'bt']

const EXAMPLE_LANGUAGES: Record<ExampleFamily, readonly string[]> = {
  md: ['md-example', 'markdown-example'],
  js: ['javascript-example', 'js-example'],
}

const SWAPPED_LAYOUT: Record<ExampleLayout, ExampleLayout> = { lr: 'rl', rl: 'lr', tb: 'bt', bt: 'tb' }

function layoutIcon(layout: ExampleLayout): string {
  const divider: Record<ExampleLayout, string> = {
    lr: '<path d="M10 3v18"/>',
    rl: '<path d="M14 3v18"/>',
    tb: '<path d="M3 10h18"/>',
    bt: '<path d="M3 14h18"/>',
  }
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/>${divider[layout]}</svg>`
}

const SETTINGS_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>'

function layoutLabel(layout: ExampleLayout): string {
  const labels: Record<ExampleLayout, string> = {
    lr: t('preview.example_dir_lr'),
    rl: t('preview.example_dir_rl'),
    tb: t('preview.example_dir_tb'),
    bt: t('preview.example_dir_bt'),
  }
  return labels[layout]
}

function layoutButton(layout: ExampleLayout, active: boolean): string {
  const label = escapeAttr(layoutLabel(layout))
  return `<button type="button" class="block-icon-opt${active ? ' is-active' : ''}" data-example-action="set-layout" data-example-val="${layout}" title="${label}" aria-label="${label}" aria-pressed="${active}">${layoutIcon(layout)}</button>`
}

function optionButton(action: string, value: string, label: string, active: boolean): string {
  return `<button type="button" class="block-opt-btn${active ? ' is-active' : ''}" data-example-action="${action}" data-example-val="${escapeAttr(value)}" aria-pressed="${active}">${escapeHtml(label)}</button>`
}

function ratioButtons(split: ExampleSplitOptions): string {
  const current = exampleRatioLabel(split.ratio)
  return EXAMPLE_RATIO_PRESETS
    .map((preset) => {
      const label = `${preset[0]}:${preset[1]}`
      return optionButton('set-ratio', label, label, current === label)
    })
    .join('')
}

function renderToolbarHtml(split: ExampleSplitOptions, popoverId: string): string {
  const trigger = escapeAttr(t('preview.example_layout_trigger'))
  const settings = escapeAttr(t('preview.example_settings'))
  const options = LAYOUTS.map((layout) => layoutButton(layout, layout === split.layout)).join('')
  return [
    `<div class="block-tools">`,
    `<button type="button" class="block-tool-btn is-layout-trigger" data-example-action="toggle-layout" title="${trigger}" aria-label="${trigger}" aria-haspopup="true" aria-expanded="false" aria-controls="${popoverId}">${layoutIcon(split.layout)}</button>`,
    `<button type="button" class="block-tool-btn" data-example-action="toggle-settings" title="${settings}" aria-label="${settings}" aria-expanded="false">${SETTINGS_ICON}</button>`,
    `<div class="block-popover" id="${popoverId}" hidden>${options}</div>`,
    `</div>`,
  ].join('')
}

function renderSettingsHtml(family: ExampleFamily, split: ExampleSplitOptions): string {
  const hint = family === 'js' ? t('preview.example_ratio_hint_js') : t('preview.example_ratio_hint_md')
  const directions = LAYOUTS.map((layout) => layoutButton(layout, layout === split.layout)).join('')
  const swap = `<button type="button" class="block-opt-btn" data-example-action="swap">${escapeHtml(t('preview.example_swap'))}</button>`
  const ratioFields = [
    `<div class="block-settings-fields">`,
    `<input type="text" class="block-text-input" data-example-ratio-input maxlength="7" value="${escapeAttr(exampleRatioLabel(split.ratio))}" placeholder="3:7" aria-label="${escapeAttr(t('preview.example_ratio'))}">`,
    `<button type="button" class="block-opt-btn" data-example-action="apply-ratio">${escapeHtml(t('preview.example_ratio_apply'))}</button>`,
    `<button type="button" class="block-opt-btn" data-example-action="reset">${escapeHtml(t('preview.example_reset'))}</button>`,
    `</div>`,
    `<p class="block-settings-hint">${escapeHtml(hint)}</p>`,
  ].join('')
  return [
    `<div class="block-settings" hidden>`,
    `<div class="block-settings-row"><span class="block-settings-title">${escapeHtml(t('preview.example_direction'))}</span><div class="block-settings-group">${directions}${swap}</div></div>`,
    `<div class="block-settings-row"><span class="block-settings-title">${escapeHtml(t('preview.example_ratio'))}</span><div class="block-settings-group">${ratioButtons(split)}</div></div>`,
    `<div class="block-settings-row is-column"><div class="block-settings-group is-fields">${ratioFields}</div></div>`,
    `</div>`,
  ].join('')
}

function exampleFamily(block: HTMLElement): ExampleFamily {
  return block.dataset.exampleFamily === 'js' ? 'js' : 'md'
}

function exampleGrid(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(':scope > .markdown-example-grid')
}

function readSplit(grid: HTMLElement): ExampleSplitOptions {
  const family: ExampleFamily = grid.closest('[data-example-family="js"]') ? 'js' : 'md'
  const defaults = EXAMPLE_SPLIT_DEFAULTS[family]
  const layout = grid.dataset.exampleLayout ?? ''
  return {
    layout: isExampleLayout(layout) ? layout : defaults.layout,
    ratio: parseExampleRatio(grid.dataset.exampleRatio ?? '') ?? [defaults.ratio[0], defaults.ratio[1]],
  }
}

function writeSplit(
  block: HTMLElement,
  content: string,
  update: (current: ExampleSplitOptions, defaults: ExampleSplitOptions) => ExampleSplitOptions,
): string | null {
  const family = exampleFamily(block)
  const line = Number(block.dataset.line)
  if (!Number.isInteger(line) || line < 0) return null
  const languages = EXAMPLE_LANGUAGES[family]
  const fence = fenceAt(content, line, languages)
  if (fence === null) return null
  const defaults = EXAMPLE_SPLIT_DEFAULTS[family]
  const nextInfo = formatExampleSplitInfo(fence.info, update(parseExampleSplit(fence.info, defaults), defaults), defaults)
  return applyFencePatchAtSource(content, { line, body: fence.body }, { info: nextInfo }, languages)
}

function commitSplit(
  block: HTMLElement,
  content: string,
  onEdit: (next: string) => void,
  update: (current: ExampleSplitOptions, defaults: ExampleSplitOptions) => ExampleSplitOptions,
  toast: BlockToast,
  done?: string,
): boolean {
  const next = writeSplit(block, content, update)
  if (next === null) {
    toast({ title: t('preview.example_edit_unavailable'), tone: 'warning' })
    return true
  }
  setOverlayOpen(block, null)
  onEdit(next)
  if (done) toast({ title: done, tone: 'success' })
  return true
}

function exampleTools(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(':scope > .markdown-example-head .block-tools')
}

function refreshRatioField(block: HTMLElement, overlay: string | null): void {
  if (overlay !== 'settings') return
  const input = block.querySelector<HTMLInputElement>('[data-example-ratio-input]')
  const grid = exampleGrid(block)
  if (input && grid) input.value = exampleRatioLabel(readSplit(grid).ratio)
}

const OVERLAY_SPEC: BlockOverlaySpec = {
  block: '.markdown-example[data-example-family]',
  panels: { layout: '.block-popover', settings: '.block-settings' },
  triggers: { layout: '[data-example-action="toggle-layout"]', settings: '[data-example-action="toggle-settings"]' },
  openClasses: { layout: 'is-block-layout-open', settings: 'is-block-settings-open' },
  onOpen: refreshRatioField,
  materialize: materializeExamplePanel,
}

function materializeExamplePanel(block: HTMLElement): void {
  if (block.querySelector(':scope > .block-settings')) return
  const head = block.querySelector<HTMLElement>(':scope > .markdown-example-head')
  const grid = exampleGrid(block)
  if (!head || !grid) return
  const panel = document.createElement('div')
  panel.innerHTML = renderSettingsHtml(exampleFamily(block), readSplit(grid))
  head.insertAdjacentElement('afterend', panel.firstElementChild ?? panel)
}

function setOverlayOpen(block: HTMLElement, overlay: 'layout' | 'settings' | null): void {
  setBlockOverlay(OVERLAY_SPEC, block, overlay)
}

function handleToggle(action: string, block: HTMLElement): boolean {
  toggleBlockOverlay(OVERLAY_SPEC, block, action === 'toggle-layout' ? 'layout' : 'settings')
  return true
}

function handleApplyRatio(block: HTMLElement, content: string, onEdit: (next: string) => void, toast: BlockToast): boolean {
  const input = block.querySelector<HTMLInputElement>('[data-example-ratio-input]')
  const ratio = parseExampleRatio(input?.value ?? '')
  if (!ratio) {
    toast({ title: t('preview.example_ratio_invalid'), tone: 'warning' })
    return true
  }
  return commitSplit(block, content, onEdit, (current) => ({ ...current, ratio }), toast, t('preview.example_ratio_applied'))
}

export function executeExampleLayoutAction(
  action: string,
  targetEl: HTMLElement,
  content: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
): boolean {
  const block = targetEl.closest<HTMLElement>('.markdown-example[data-example-family]')
  if (!block) return false
  if (action === 'toggle-layout' || action === 'toggle-settings') return handleToggle(action, block)
  if (action === 'swap')
    return commitSplit(block, content, onEdit, (current) => ({ ...current, layout: SWAPPED_LAYOUT[current.layout] }), toast)
  if (action === 'reset')
    return commitSplit(block, content, onEdit, (_current, defaults) => ({ ...defaults }), toast, t('preview.example_reset_done'))
  if (action === 'set-ratio') {
    const ratio = parseExampleRatio(targetEl.dataset.exampleVal ?? '')
    if (!ratio) return true
    return commitSplit(block, content, onEdit, (current) => ({ ...current, ratio }), toast, t('preview.example_ratio_applied'))
  }
  if (action === 'apply-ratio') return handleApplyRatio(block, content, onEdit, toast)
  if (action === 'set-layout') {
    const value = targetEl.dataset.exampleVal ?? ''
    if (!isExampleLayout(value)) return true
    return commitSplit(block, content, onEdit, (current) => ({ ...current, layout: value }), toast)
  }
  return false
}

export function enhanceExampleLayoutsInRoot(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.markdown-example[data-example-family][data-line]').forEach((block) => {
    if (block.closest('.note-embed-body') || exampleTools(block)) return
    const head = block.querySelector<HTMLElement>(':scope > .markdown-example-head')
    const grid = exampleGrid(block)
    if (!head || !grid) return
    const family = exampleFamily(block)
    const split = readSplit(grid)
    const line = block.dataset.line ?? '0'
    const tools = document.createElement('div')
    tools.innerHTML = renderToolbarHtml(split, `example-layout-menu-${family}-${line}`)
    const toolbar = tools.firstElementChild ?? tools
    const controls = head.querySelector<HTMLElement>('.js-example-controls')
    if (controls) controls.prepend(toolbar)
    else head.append(toolbar)
  })
}

export const exampleToolbar: BlockToolbarModule = {
  enhance: enhanceExampleLayoutsInRoot,
  dismiss: (target) => dismissBlockOverlays(OVERLAY_SPEC, target),
  close: (target) => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
  handle: (event, target, ctx) => {
    const button = target.closest<HTMLButtonElement>('[data-example-action]')
    if (!button) return false
    event.preventDefault()
    const editable = blockActionSource(ctx)
    if (!editable) return true
    return executeExampleLayoutAction(
      button.dataset.exampleAction!,
      button,
      editable.source,
      (next) => ctx.api.editContent(editable.noteId, next),
      ctx.api.toast,
    )
  },
}
