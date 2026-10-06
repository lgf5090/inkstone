import { fitMindmapBlock } from '../../lib/markdown/mindmap/registry'

const SYNC_STORAGE_PREFIX = 'inkstone:tabs-sync:v1:'

/** Where a tab block's choice should be remembered, when the surface knows whose note it is. */
export interface TabScope {
  noteId?: string | null
  userId?: string | null
}

export function groupTabButtons(group: HTMLElement): HTMLButtonElement[] {
  return [...group.querySelectorAll<HTMLButtonElement>('[data-tab-button]')]
    .filter((button) => button.closest('[data-tabs]') === group)
}

export function groupTabPanels(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>('[data-tab-panel]')]
    .filter((panel) => panel.closest('[data-tabs]') === group)
}

export function selectedTabIndex(group: HTMLElement): number {
  const index = groupTabButtons(group).find((button) => button.getAttribute('aria-selected') === 'true')?.dataset.tabButton
  return index === undefined ? 0 : Number(index)
}

/**
 * Applies a selection to one tab block: no coordination with its sync group, no persistence. Returns
 * false when the index is out of range or the block was already showing that panel, which is what lets
 * a caller tell a real change from a repeat of the state it restored.
 */
export function applyTabSelection(tabs: HTMLElement, index: number, options: { reveal?: boolean } = {}): boolean {
  const buttons = groupTabButtons(tabs)
  if (index < 0 || index >= buttons.length) return false
  const already = buttons[index]!.getAttribute('aria-selected') === 'true'
  buttons.forEach((candidate, candidateIndex) => {
    const selected = candidateIndex === index
    candidate.setAttribute('aria-selected', String(selected))
    candidate.tabIndex = selected ? 0 : -1
  })
  const panels = groupTabPanels(tabs)
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== String(index)
  })
  syncRenameField(tabs, buttons[index]!)
  if (!already && options.reveal !== false) {
    const active = panels[index]
    if (active) revealActiveTabContent(active)
  }
  return !already
}

// The settings panel's rename field always names the tab being shown. The field and the tab block are
// committed together, so only a read of the live DOM can keep the two in step.
function syncRenameField(tabs: HTMLElement, activeButton: HTMLButtonElement): void {
  const input = tabs.querySelector<HTMLInputElement>('[data-tabs-rename-input]')
  if (!input || input.ownerDocument.activeElement === input) return
  const title = activeButton.textContent?.trim()
  if (title !== undefined) input.value = title
}

export function selectMarkdownTab(button: HTMLButtonElement, scope?: TabScope): void {
  const tabs = button.closest<HTMLElement>('[data-tabs]')
  if (!tabs) return
  const index = button.dataset.tabButton
  if (index === undefined || !Number.isInteger(Number(index))) return
  // A nested group numbers its own panels from zero, so an outer click that reached inside
  // would relabel the inner buttons and hide the panel the inner group has selected.
  applyTabSelection(tabs, Number(index))
  coordinateSyncedTabs(tabs, Number(index))
  rememberSyncedChoice(tabs, Number(index), scope)
}

/** Blocks sharing a sync id inside the same prose surface switch to the same panel together. */
function coordinateSyncedTabs(source: HTMLElement, index: number): void {
  const group = source.dataset.tabsSync
  if (!group) return
  const scope = source.closest<HTMLElement>('.ink-prose') ?? source.ownerDocument?.documentElement
  if (!scope) return
  let peers: HTMLElement[]
  try {
    peers = [...scope.querySelectorAll<HTMLElement>(`[data-tabs-sync="${CSS.escape(group)}"]`)]
  }
  catch {
    // The sync id is validated at parse time, so an escape failure means malformed hand-built DOM.
    return
  }
  for (const peer of peers) {
    if (peer === source || source.contains(peer)) continue
    applyTabSelection(peer, index)
  }
}

function syncedStorageKey(userId: string, noteId: string, group: string): string {
  return `${SYNC_STORAGE_PREFIX}${userId}:${noteId}:${group}`
}

/** The remembered choice is scoped by account as well as note, so two people sharing a browser do not
 * read each other's open tab. */
function scopedKey(scope: TabScope | undefined, group: string): string | null {
  const { noteId, userId } = scope ?? {}
  if (!noteId || !userId) return null
  return syncedStorageKey(userId, noteId, group)
}

export function readSyncedTabChoice(scope: TabScope | undefined, group: string): number | null {
  const key = scopedKey(scope, group)
  if (!key) return null
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    const index = Number(raw)
    return Number.isInteger(index) && index >= 0 ? index : null
  }
  catch {
    // Storage can be unavailable (private mode / quota); the remembered choice is best-effort.
    return null
  }
}

function rememberSyncedChoice(tabs: HTMLElement, index: number, scope: TabScope | undefined): void {
  const key = scopedKey(scope, tabs.dataset.tabsSync ?? '')
  if (!key) return
  try {
    window.localStorage.setItem(key, String(index))
  }
  catch {
    // Persisting the choice is best-effort; in-session coordination still works.
  }
}

/**
 * A panel that was hidden while its block was measured comes back with the size of nothing at all, so
 * everything that lays itself out on a real box has to be told here. Chart.js is configured
 * `responsive`, which is the resize event below; a mind map needs the direct nudge, because its
 * container watcher cannot fire — the box it watches only changes once the panel is already visible.
 */
export function revealActiveTabContent(panel: HTMLElement): void {
  panel.querySelectorAll<HTMLElement>('[data-mindmap]').forEach(fitMindmapBlock)
  if (panel.querySelectorAll<HTMLElement>('[data-chart], [data-mermaid], [data-mindmap]').length)
    window.dispatchEvent(new Event('resize'))
}

/** Opens every collapsed block and selects every tab panel the target sits inside. */
export function revealPreviewTarget(target: Element | null | undefined): void {
  for (let node = target?.parentElement ?? null; node; node = node.parentElement) {
    if (node.matches('details'))
      (node as HTMLDetailsElement).open = true
    if (!node.matches('[data-tab-panel]'))
      continue
    const group = node.parentElement?.closest<HTMLElement>('[data-tabs]')
    const button = group && groupTabButtons(group).find((candidate) => candidate.dataset.tabButton === node.dataset.tabPanel)
    if (button && button.getAttribute('aria-selected') !== 'true')
      selectMarkdownTab(button)
  }
}

export function moveMarkdownTabFocus(button: HTMLButtonElement, key: string, scope?: TabScope): void {
  const buttons = [
    ...(button.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[data-tab-button]') ?? []),
  ]
  if (!buttons.length) return
  const current = Math.max(0, buttons.indexOf(button))
  const forward = key === 'ArrowRight' || key === 'ArrowDown'
  const backward = key === 'ArrowLeft' || key === 'ArrowUp'
  if (!forward && !backward && key !== 'Home' && key !== 'End') return
  const index =
    key === 'Home'
      ? 0
      : key === 'End'
        ? buttons.length - 1
        : (current + (forward ? 1 : -1) + buttons.length) % buttons.length
  const next = buttons[index]!
  selectMarkdownTab(next, scope)
  next.focus()
}
