import { escapeAttr, escapeHtml } from '../../lib/markdown/renderer'
import { isValidTabsSync } from '../../lib/markdown/panel-options'
import type { TabsOptions, TabsPosition } from '../../lib/markdown/panel-options'
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
  type BlockToolbarOptions,
} from './block-overlay'
import { applyTabSelection, groupTabButtons, readSyncedTabChoice, selectedTabIndex } from './markdown-tabs'
import {
  addTabToSource,
  deleteTabInSource,
  getTabsTabCount,
  renameTabInSource,
  updateTabsSourceHeader,
} from './tabs-source'

/**
 * The settings toolbar for a `:::` tab block.
 *
 * Unlike the layout blocks, which wrap their content, a tab set draws its own frame and the prose
 * stylesheet owns it, so the toolbar is prepended inside the box and the tab strip reserves the right
 * hand end of its own row for it. Every edit rewrites the header line or a marker line, so a change
 * survives a reload, a share and an export.
 */

const TABS_BLOCK = '.markdown-tabs[data-tabs]'
const LAYOUT_POSITIONS: TabsPosition[] = ['top', 'bottom', 'left', 'right']
const VARIANTS = ['default', 'pills', 'cards', 'minimal'] as const
const TAB_ALIGNS = ['start', 'center', 'end', 'stretch'] as const

const OVERLAY_SPEC: BlockOverlaySpec = {
  block: TABS_BLOCK,
  panels: { layout: '.markdown-tabs-header-wrap > .block-popover', settings: '.markdown-tabs-header-wrap > .block-settings' },
  triggers: { layout: '[data-tabs-action="toggle-layout"]', settings: '[data-tabs-action="toggle-settings"]' },
  openClasses: { layout: 'is-layout-open', settings: 'is-settings-open' },
  onOpen: refreshRenameField,
  materialize: materializeSettings,
}

// Rect with a divider sitting on the named edge: the exact placement the tab strip will take.
function layoutIcon(position: TabsPosition): string {
  const divider: Record<TabsPosition, string> = {
    top: '<path d="M3 9h18"/>',
    bottom: '<path d="M3 15h18"/>',
    left: '<path d="M9 3v18"/>',
    right: '<path d="M15 3v18"/>',
  }
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/>${divider[position]}</svg>`
}

const SETTINGS_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>'
const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
const ADD_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>'

function positionLabel(position: TabsPosition): string {
  const labels: Record<TabsPosition, string> = {
    top: t('preview.tabs_position_top'),
    bottom: t('preview.tabs_position_bottom'),
    left: t('preview.tabs_position_left'),
    right: t('preview.tabs_position_right'),
  }
  return labels[position]
}

function variantLabel(variant: string): string {
  const labels: Record<string, string> = {
    default: t('preview.tabs_variant_default'),
    pills: t('preview.tabs_variant_pills'),
    cards: t('preview.tabs_variant_cards'),
    minimal: t('preview.tabs_variant_minimal'),
  }
  return labels[variant] ?? variant
}

function alignLabel(align: string): string {
  const labels: Record<string, string> = {
    start: t('preview.tabs_align_start'),
    center: t('preview.tabs_align_center'),
    end: t('preview.tabs_align_end'),
    stretch: t('preview.tabs_align_stretch'),
  }
  return labels[align] ?? align
}

function toolButton(action: string, label: string, icon: string, extra = ''): string {
  const safe = escapeAttr(label)
  return `<button type="button" class="block-tool-btn" data-tabs-action="${action}" title="${safe}" aria-label="${safe}"${extra}>${icon}</button>`
}

function optionButton(group: string, value: string, label: string, active: boolean, disabled = false): string {
  return `<button type="button" class="block-opt-btn${active ? ' is-active' : ''}" data-tabs-action="set-option" data-tabs-set="${group}" data-tabs-val="${escapeAttr(value)}" aria-pressed="${active}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
}

function settingsRow(label: string, content: string, extraClass = ''): string {
  return `<div class="block-settings-row${extraClass ? ` ${extraClass}` : ''}"><span class="block-settings-title">${escapeHtml(label)}</span><div class="block-settings-group">${content}</div></div>`
}

function renderChromeHtml(position: TabsPosition, popoverId: string): string {
  const layoutOptions = LAYOUT_POSITIONS.map((value) => {
    const label = escapeAttr(positionLabel(value))
    return `<button type="button" class="block-icon-opt${value === position ? ' is-active' : ''}" data-tabs-action="set-option" data-tabs-set="position" data-tabs-val="${value}" title="${label}" aria-label="${label}" aria-pressed="${value === position}">${layoutIcon(value)}</button>`
  }).join('')
  const trigger = escapeAttr(t('preview.tabs_layout_trigger'))
  return [
    `<div class="markdown-tabs-header-wrap">`,
    `<div class="block-tools">`,
    `<button type="button" class="block-tool-btn is-layout-trigger" data-tabs-action="toggle-layout" title="${trigger}" aria-label="${trigger}" aria-haspopup="true" aria-expanded="false" aria-controls="${popoverId}">${layoutIcon(position)}</button>`,
    toolButton('toggle-settings', t('preview.tabs_settings'), SETTINGS_ICON, ' aria-expanded="false"'),
    toolButton('copy-tab', t('preview.tabs_copy_tab'), COPY_ICON),
    toolButton('add-tab', t('preview.tabs_add_tab'), ADD_ICON),
    `</div>`,
    `<div class="block-popover" id="${popoverId}" role="group" aria-label="${trigger}" hidden>${layoutOptions}</div>`,
    `<div class="block-settings" hidden></div>`,
    `</div>`,
  ].join('')
}

function renderSettingsHtml(tabsEl: HTMLElement): string {
  const position = currentPosition(tabsEl)
  const variant = tabsEl.dataset.tabsVariant || 'default'
  const align = tabsEl.dataset.tabsAlign || 'start'
  const sync = tabsEl.dataset.tabsSync ?? ''
  const tabCount = groupTabButtons(tabsEl).length
  const positionGroup = LAYOUT_POSITIONS.map((value) => optionButton('position', value, positionLabel(value), position === value)).join('')
  const variantGroup = VARIANTS.map((value) => optionButton('variant', value, variantLabel(value), variant === value)).join('')
  const alignGroup = TAB_ALIGNS.map((value) => optionButton('align', value, alignLabel(value), align === value)).join('')
  const syncFields = [
    `<input type="text" class="block-text-input" data-tabs-sync-input maxlength="40" value="${escapeAttr(sync)}" placeholder="${escapeAttr(t('preview.tabs_sync_placeholder'))}" aria-label="${escapeAttr(t('preview.tabs_sync'))}">`,
    `<button type="button" class="block-opt-btn" data-tabs-action="set-sync">${escapeHtml(t('preview.tabs_sync_apply'))}</button>`,
    `<button type="button" class="block-opt-btn" data-tabs-action="clear-sync"${sync ? '' : ' disabled'}>${escapeHtml(t('preview.tabs_sync_clear'))}</button>`,
    `<p class="block-settings-hint">${escapeHtml(t('preview.tabs_sync_hint'))}</p>`,
  ].join('')
  const currentFields = [
    `<input type="text" class="block-text-input" data-tabs-rename-input maxlength="80" value="${escapeAttr(activeTabTitle(tabsEl))}" placeholder="${escapeAttr(t('preview.tabs_rename_placeholder'))}" aria-label="${escapeAttr(t('preview.tabs_rename'))}">`,
    `<button type="button" class="block-opt-btn" data-tabs-action="rename-tab">${escapeHtml(t('preview.tabs_rename'))}</button>`,
    `<button type="button" class="block-opt-btn is-danger" data-tabs-action="delete-tab"${tabCount <= 1 ? ' disabled' : ''}>${escapeHtml(t('preview.tabs_delete'))}</button>`,
  ].join('')
  return [
    settingsRow(t('preview.tabs_position'), positionGroup),
    settingsRow(t('preview.tabs_variant'), variantGroup),
    settingsRow(t('preview.tabs_align'), alignGroup),
    settingsRow(t('preview.tabs_sync'), syncFields, 'is-column'),
    settingsRow(t('preview.tabs_current'), currentFields, 'is-column'),
  ].join('')
}

function materializeSettings(tabsEl: HTMLElement): void {
  const panel = tabsEl.querySelector<HTMLElement>('.markdown-tabs-header-wrap > .block-settings')
  if (!panel || panel.dataset.rendered) return
  panel.innerHTML = renderSettingsHtml(tabsEl)
  panel.dataset.rendered = 'true'
}

function refreshRenameField(tabsEl: HTMLElement, overlay: string | null): void {
  if (overlay !== 'settings') return
  const input = tabsEl.querySelector<HTMLInputElement>('[data-tabs-rename-input]')
  if (input) input.value = activeTabTitle(tabsEl)
}

function activeTabTitle(tabsEl: HTMLElement): string {
  const buttons = groupTabButtons(tabsEl)
  return buttons.find((button) => button.getAttribute('aria-selected') === 'true')?.textContent?.trim()
    ?? buttons[0]?.textContent?.trim()
    ?? ''
}

function currentPosition(tabsEl: HTMLElement): TabsPosition {
  const explicit = tabsEl.dataset.tabsPosition
  if (explicit === 'top' || explicit === 'bottom' || explicit === 'left' || explicit === 'right') return explicit
  return tabsEl.dataset.tabsStyle === 'vertical' ? 'left' : 'top'
}

/** Applies the choice remembered for this sync group before the block is committed to the page. */
function restoreSyncedSelection(tabsEl: HTMLElement, options: Pick<BlockToolbarOptions, 'tabScope'>): void {
  const group = tabsEl.dataset.tabsSync
  if (!group) return
  const saved = readSyncedTabChoice(options.tabScope, group)
  if (saved !== null) applyTabSelection(tabsEl, saved, { reveal: false })
}

export function enhanceTabsToolbarsInRoot(root: HTMLElement, options: Pick<BlockToolbarOptions, 'tabScope'> = {}): void {
  root.querySelectorAll<HTMLElement>(`${TABS_BLOCK}[data-line]`).forEach((tabsEl) => {
    if (tabsEl.closest('.note-embed-body') || tabsEl.querySelector(':scope > .markdown-tabs-header-wrap')) return
    restoreSyncedSelection(tabsEl, options)
    const chrome = document.createElement('div')
    chrome.innerHTML = renderChromeHtml(currentPosition(tabsEl), `tabs-layout-menu-${tabsEl.dataset.line}`)
    tabsEl.prepend(chrome.firstElementChild as HTMLElement)
  })
}

export function dismissTabsOverlays(target: HTMLElement): void {
  dismissBlockOverlays(OVERLAY_SPEC, target)
}

function sourceLineOf(tabsEl: HTMLElement): number | null {
  const line = Number(tabsEl.dataset.line)
  return Number.isInteger(line) && line >= 0 ? line : null
}

/** Commits one source rewrite, or tells the reader the block moved out from under the toolbar. */
function commit(
  content: string,
  sourceLine: number,
  onEdit: (next: string) => void,
  toast: BlockToast,
  rewrite: (source: string, line: number) => string | null,
  done?: string,
): boolean {
  const next = rewrite(content, sourceLine)
  if (next === null) {
    toast({ title: t('preview.tabs_edit_unavailable'), tone: 'warning' })
    return true
  }
  onEdit(next)
  if (done) toast({ title: done, tone: 'success' })
  return true
}

async function copyActivePanel(tabsEl: HTMLElement, toast: BlockToast): Promise<void> {
  const active = [...tabsEl.querySelectorAll<HTMLElement>(':scope > [data-tab-panel]')].find((panel) => !panel.hidden)
  const text = active?.innerText?.trim() ?? ''
  if (!navigator.clipboard?.writeText) {
    toast({ title: t('preview.tabs_copy_unavailable'), tone: 'warning' })
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast({ title: t('common.copied'), tone: 'success' })
  }
  catch {
    // A sandboxed or insecure context refuses the write, which is the one outcome the reader has to
    // hear about rather than watch silently do nothing.
    toast({ title: t('preview.tabs_copy_unavailable'), tone: 'warning' })
  }
}

export function executeTabsAction(
  action: string,
  targetEl: HTMLElement,
  content: string,
  onEdit: (next: string) => void,
  toast: BlockToast,
): boolean {
  const tabsEl = targetEl.closest<HTMLElement>(TABS_BLOCK)
  if (!tabsEl) return false
  const sourceLine = sourceLineOf(tabsEl)
  if (sourceLine === null) return false
  if (action === 'toggle-layout' || action === 'toggle-settings') {
    toggleBlockOverlay(OVERLAY_SPEC, tabsEl, action === 'toggle-layout' ? 'layout' : 'settings')
    return true
  }
  if (action === 'copy-tab') {
    void copyActivePanel(tabsEl, toast)
    return true
  }
  if (action === 'add-tab')
    return commit(content, sourceLine, onEdit, toast, (source, line) => addTabToSource(source, line), t('preview.tabs_added'))
  if (action === 'set-option') {
    const setKey = targetEl.dataset.tabsSet as 'variant' | 'align' | 'position' | undefined
    const setVal = targetEl.dataset.tabsVal
    if (!setKey || !setVal) return true
    const handled = commit(content, sourceLine, onEdit, toast, (source, line) => updateTabsSourceHeader(source, line, () => ({ [setKey]: setVal } as Partial<TabsOptions>)))
    // The DOM is re-rendered from source shortly; close on the live node now too so the popover never
    // lingers over the block while the edit commits.
    setBlockOverlay(OVERLAY_SPEC, tabsEl, null)
    return handled
  }
  if (action === 'set-sync' || action === 'clear-sync') {
    const value = action === 'clear-sync' ? '' : (tabsEl.querySelector<HTMLInputElement>('[data-tabs-sync-input]')?.value ?? '').trim()
    if (value && !isValidTabsSync(value)) {
      toast({ title: t('preview.tabs_sync_invalid'), tone: 'warning' })
      return true
    }
    return commit(
      content,
      sourceLine,
      onEdit,
      toast,
      (source, line) => updateTabsSourceHeader(source, line, () => ({ sync: value || undefined })),
      value ? t('preview.tabs_sync_enabled') : t('preview.tabs_sync_cleared'),
    )
  }
  if (action === 'rename-tab') {
    const title = (tabsEl.querySelector<HTMLInputElement>('[data-tabs-rename-input]')?.value ?? '').trim()
    if (!title) {
      toast({ title: t('preview.tabs_name_required'), tone: 'warning' })
      return true
    }
    return commit(content, sourceLine, onEdit, toast, (source, line) => renameTabInSource(source, line, selectedTabIndex(tabsEl), title), t('preview.tabs_renamed'))
  }
  if (action === 'delete-tab') {
    const count = getTabsTabCount(content, sourceLine)
    if (count === null) {
      toast({ title: t('preview.tabs_edit_unavailable'), tone: 'warning' })
      return true
    }
    if (count <= 1) {
      toast({ title: t('preview.tabs_cannot_delete_last'), tone: 'warning' })
      return true
    }
    return commit(content, sourceLine, onEdit, toast, (source, line) => deleteTabInSource(source, line, selectedTabIndex(tabsEl)), t('preview.tabs_deleted'))
  }
  return false
}

export const tabsBlockToolbar: BlockToolbarModule = {
  enhance: enhanceTabsToolbarsInRoot,
  dismiss: dismissTabsOverlays,
  close: (target) => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
  handle: (event, target, ctx) => {
    const button = target.closest<HTMLButtonElement>('[data-tabs-action]')
    if (!button) return false
    event.preventDefault()
    const editable = blockActionSource(ctx)
    if (!editable) return true
    return executeTabsAction(
      button.dataset.tabsAction!,
      button,
      editable.source,
      (next) => ctx.api.editContent(editable.noteId, next),
      ctx.api.toast,
    )
  },
}
