import { escapeAttr, escapeHtml } from '../../lib/markdown/renderer'
import {
  codeTheme,
  parseCollapseValue,
  readCodeOptions,
  readHighlightInput,
  writeCodeOptions,
  type CodeBlockOptions,
  type CodeTheme,
} from '../../lib/markdown/code-options'
import { applyFencePatchAtSource, fenceAt } from '../../lib/markdown/fence-edit'
import { parseFenceInfo } from '../../lib/markdown/fence-info'
import { CODE_FORMAT_FAILURE_MESSAGES, formatCodeResult } from '../../lib/markdown/code-formatter'
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
  type CodeFormatToolbarOptions,
} from './block-overlay'

const CODE_BLOCK = '.code-block[data-line]:not(.markdown-example-code)'

const SETTINGS_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>'

const DEFAULT_FORMAT_OPTIONS: CodeFormatToolbarOptions = { enabled: true, tabSize: 2, keywordCase: 'upper' };

const FORMAT_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/></svg>';

const OVERLAY_SPEC: BlockOverlaySpec = {
  block: CODE_BLOCK,
  panels: { settings: '.block-settings' },
  triggers: { settings: '[data-code-action="toggle-settings"]' },
  openClasses: { settings: 'is-block-settings-open' },
  materialize: materializeCodePanel,
}

function optionButton(action: string, value: string, label: string, active: boolean): string {
  return `<button type="button" class="block-opt-btn${active ? ' is-active' : ''}" data-code-action="${action}" data-code-val="${escapeAttr(value)}" aria-pressed="${active}">${escapeHtml(label)}</button>`
}

function textField(name: string, value: string, extraClass = ''): string {
  return `<input type="text" class="block-text-input${extraClass ? ` ${extraClass}` : ''}" data-code-input="${name}" maxlength="200" value="${escapeAttr(value)}" aria-label="${escapeAttr(`${t('preview.code_field')} ${name}`)}">`
}

function applyButton(action: string): string {
  return `<button type="button" class="block-opt-btn" data-code-action="${action}">${escapeHtml(t('preview.code_apply'))}</button>`
}

function settingsRow(label: string, content: string): string {
  return `<div class="block-settings-row"><span class="block-settings-title">${escapeHtml(label)}</span><div class="block-settings-group">${content}</div></div>`
}

function renderPanelHtml(block: HTMLElement, panelId: string): string {
  const wrap = block.dataset.codeWrap === 'true'
  const numbered = block.dataset.lineNumbers === 'true'
  const theme = codeTheme(block.dataset.codeTheme ?? '') ?? 'auto'
  const collapse = block.dataset.codeCollapseAt
  const themes: Array<[CodeTheme, string]> = [
    ['auto', t('preview.code_theme_auto')],
    ['light', t('preview.code_theme_light')],
    ['dark', t('preview.code_theme_dark')],
  ]
  return [
    `<div class="block-settings" id="${panelId}" hidden>`,
    settingsRow(t('preview.code_title'), `${textField('title', block.dataset.codeTitle ?? '', 'is-title')}${applyButton('apply-title')}`),
    settingsRow(t('preview.code_line_numbers'), `${optionButton('set-line-numbers', 'on', t('preview.code_show'), numbered)}${optionButton('set-line-numbers', 'off', t('preview.code_hide'), !numbered)}${textField('start', block.dataset.codeStart ?? '1', 'is-narrow')}${applyButton('apply-start')}`),
    settingsRow(t('preview.code_highlight'), `${textField('highlight', block.dataset.highlightLines ?? '', 'is-narrow')}${applyButton('apply-highlight')}`),
    settingsRow(t('preview.code_collapse'), `${optionButton('set-collapse', 'auto', t('preview.code_collapse_auto'), collapse === undefined)}${optionButton('set-collapse', 'never', t('preview.code_collapse_never'), collapse === '0')}${textField('collapse', collapse ?? '', 'is-narrow')}${applyButton('apply-collapse')}`),
    settingsRow(t('preview.code_theme'), themes.map(([value, label]) => optionButton('set-theme', value, label, theme === value)).join('')),
    settingsRow(t('preview.code_wrap'), `${optionButton('set-wrap', 'wrap', t('preview.code_wrap_on'), wrap)}${optionButton('set-wrap', 'nowrap', t('preview.code_wrap_off'), !wrap)}`),
    `</div>`,
  ].join('')
}

function codeBlockTools(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(':scope > .code-block-head > .block-tools')
}

function materializeCodePanel(block: HTMLElement): void {
  if (block.querySelector(':scope > .block-settings')) return
  const head = block.querySelector<HTMLElement>(':scope > .code-block-head')
  if (!head) return
  const panel = document.createElement('div')
  panel.innerHTML = renderPanelHtml(block, `code-settings-${block.dataset.line ?? '0'}`)
  head.insertAdjacentElement('afterend', panel.firstElementChild ?? panel)
}

function numberField(block: HTMLElement, name: string, fallback: number | null): number | null {
  const input = block.querySelector<HTMLInputElement>(`[data-code-input="${name}"]`)
  const raw = (input?.value ?? '').trim()
  if (!/^\d{1,6}$/.test(raw)) return fallback
  return Number(raw)
}

function updateCodeFence(
  block: HTMLElement,
  content: string,
  update: (current: CodeBlockOptions) => CodeBlockOptions,
): string | null {
  const line = Number(block.dataset.line)
  if (!Number.isInteger(line) || line < 0) return null
  const fence = fenceAt(content, line, [])
  if (fence === null) return null
  const nextInfo = writeCodeOptions(fence.info, update(readCodeOptions(fence.info)))
  return applyFencePatchAtSource(content, { line, body: fence.body }, { info: nextInfo }, [])
}

function commitCode(
  block: HTMLElement,
  content: string,
  onEdit: (next: string) => void,
  update: (current: CodeBlockOptions) => CodeBlockOptions,
  toast: BlockToast,
): boolean {
  const next = updateCodeFence(block, content, update)
  if (next === null) {
    toast({ title: t('preview.code_edit_unavailable'), tone: 'warning' })
    return true
  }
  setBlockOverlay(OVERLAY_SPEC, block, null)
  onEdit(next)
  return true
}

type CodeAction = (
  block: HTMLElement,
  value: string,
  content: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
  format: CodeFormatToolbarOptions,
) => boolean

const ACTIONS: Record<string, CodeAction> = {
  'format-code': (block, _value, content, onEdit, toast, format) => {
    const line = Number(block.dataset.line)
    if (!Number.isInteger(line) || line < 0) {
      toast({ title: t('preview.code_edit_unavailable'), tone: 'warning' })
      return true
    }
    const fence = fenceAt(content, line, [])
    if (fence === null) {
      toast({ title: t('preview.code_edit_unavailable'), tone: 'warning' })
      return true
    }
    const result = formatCodeResult(fence.body, parseFenceInfo(fence.info).language, {
      tabSize: format.tabSize,
      sqlKeywordCase: format.keywordCase,
    })
    if (!result.ok) {
      toast({ title: t(CODE_FORMAT_FAILURE_MESSAGES[result.reason ?? 'failed']), tone: 'warning' })
      return true
    }
    const next = applyFencePatchAtSource(content, { line, body: fence.body }, { body: result.text }, [])
    if (next === null) {
      toast({ title: t('preview.code_edit_unavailable'), tone: 'warning' })
      return true
    }
    setBlockOverlay(OVERLAY_SPEC, block, null)
    onEdit(next)
    toast({
      title: t('preview.code_format_done'),
      tone: 'success',
      duration: 5000,
      action: { label: t('common.undo'), run: () => onEdit(content) },
    })
    return true
  },
  'apply-title': (block, _value, content, onEdit, toast) => {
    const title = block.querySelector<HTMLInputElement>('[data-code-input="title"]')?.value ?? ''
    return commitCode(block, content, onEdit, (current) => ({ ...current, title: title.trim() }), toast)
  },
  'set-line-numbers': (block, value, content, onEdit, toast) =>
    commitCode(block, content, onEdit, (current) => ({ ...current, lineNumbers: value === 'on' }), toast),
  'apply-start': (block, _value, content, onEdit, toast) => {
    const startLine = numberField(block, 'start', 1) ?? 1
    return commitCode(block, content, onEdit, (current) => ({ ...current, startLine: Math.max(1, startLine) }), toast)
  },
  'apply-highlight': (block, _value, content, onEdit, toast) => {
    const highlighted = readHighlightInput(block.querySelector<HTMLInputElement>('[data-code-input="highlight"]')?.value ?? '')
    return commitCode(block, content, onEdit, (current) => ({ ...current, highlighted }), toast)
  },
  'set-collapse': (block, value, content, onEdit, toast) =>
    commitCode(block, content, onEdit, (current) => ({ ...current, collapse: value === 'never' ? 0 : null }), toast),
  'apply-collapse': (block, _value, content, onEdit, toast) => {
    const collapse = parseCollapseValue(block.querySelector<HTMLInputElement>('[data-code-input="collapse"]')?.value ?? '')
    if (collapse === null) {
      toast({ title: t('preview.code_collapse_invalid'), tone: 'warning' })
      return true
    }
    return commitCode(block, content, onEdit, (current) => ({ ...current, collapse }), toast)
  },
  'set-theme': (block, value, content, onEdit, toast) =>
    commitCode(block, content, onEdit, (current) => ({ ...current, theme: codeTheme(value) ?? 'auto' }), toast),
  'set-wrap': (block, value, content, onEdit, toast) =>
    commitCode(block, content, onEdit, (current) => ({ ...current, wrap: value === 'wrap' }), toast),
}

export function executeCodeBlockAction(
  action: string,
  targetEl: HTMLElement,
  content: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
  format: CodeFormatToolbarOptions = DEFAULT_FORMAT_OPTIONS,
): boolean {
  const block = targetEl.closest<HTMLElement>(CODE_BLOCK)
  if (!block) return false
  if (action === 'toggle-settings') {
    toggleBlockOverlay(OVERLAY_SPEC, block, 'settings')
    return true
  }
  return ACTIONS[action]?.(block, targetEl.dataset.codeVal ?? '', content, onEdit, toast, format) ?? false
}

function formatButtonHtml(enabled: boolean): string {
  if (!enabled) return ''
  const label = escapeAttr(t('preview.code_format'))
  return `<button type="button" class="block-tool-btn" data-code-action="format-code" title="${label}" aria-label="${label}">${FORMAT_ICON}</button>`
}

export function enhanceCodeBlockToolbarsInRoot(root: HTMLElement, options?: { codeFormat?: Partial<CodeFormatToolbarOptions> }): void {
  const format = { ...DEFAULT_FORMAT_OPTIONS, ...options?.codeFormat };
  root.querySelectorAll<HTMLElement>(CODE_BLOCK).forEach((block) => {
    if (block.closest('.note-embed-body') || codeBlockTools(block)) return
    const head = block.querySelector<HTMLElement>(':scope > .code-block-head')
    if (!head) return
    const panelId = `code-settings-${block.dataset.line ?? '0'}`
    const label = escapeAttr(t('preview.code_settings'))
    const tools = document.createElement('div')
    tools.innerHTML = `<div class="block-tools">${formatButtonHtml(format.enabled)}<button type="button" class="block-tool-btn" data-code-action="toggle-settings" title="${label}" aria-label="${label}" aria-expanded="false" aria-controls="${panelId}">${SETTINGS_ICON}</button></div>`
    const toolbar = tools.firstElementChild ?? tools
    head.insertBefore(toolbar, head.querySelector('[data-code-collapse], [data-copy]'))
  })
}

export const codeBlockToolbar: BlockToolbarModule = {
  enhance: enhanceCodeBlockToolbarsInRoot,
  dismiss: (target) => dismissBlockOverlays(OVERLAY_SPEC, target),
  close: (target) => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
  handle: (event, target, ctx) => {
    const button = target.closest<HTMLButtonElement>('[data-code-action]')
    if (!button) return false
    event.preventDefault()
    const editable = blockActionSource(ctx)
    if (!editable) return true
    return executeCodeBlockAction(
      button.dataset.codeAction!,
      button,
      editable.source,
      (next) => ctx.api.editContent(editable.noteId, next),
      ctx.api.toast,
      ctx.codeFormat,
    )
  },
}
