import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { X } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Spinner } from '../../components/primitives'
import { Menu, useContextMenu, type MenuItem } from '../../components/overlay'
import { editorTabMenuItems, officeTypeIcon } from './office-menus'
import type { OfficeOpenTab } from './office-prefs'

export type OfficeSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed'

const SAVE_LABEL_KEYS: Record<Exclude<OfficeSaveState, 'idle'>, MessageKey> = {
  dirty: 'office.save.unsaved',
  saving: 'office.save.saving',
  saved: 'office.save.saved',
  failed: 'office.save.failed',
}

export function officeSaveStateLabel(state: OfficeSaveState): string | null {
  if (state === 'idle') return null
  return t(SAVE_LABEL_KEYS[state])
}

export interface OfficeTabState {
  dirty: boolean
  save: OfficeSaveState
}

export interface OfficeEditorTabsProps {
  tabs: readonly OfficeOpenTab[]
  activeId: string | null
  states: Readonly<Record<string, OfficeTabState>>
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onDuplicate: (tab: OfficeOpenTab) => void
  onShowInList: (tab: OfficeOpenTab) => void
}

function SaveIndicator({ state }: { state: OfficeTabState | undefined }) {
  if (!state || state.save === 'idle') return null
  if (state.save === 'saving') {
    return <Spinner size={10} className="text-[var(--accent)]" />
  }
  if (state.save === 'failed') {
    return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
  }
  if (state.dirty || state.save === 'dirty') {
    return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
  }
  return null
}

/**
 * The workbench's tab strip.
 *
 * `Tabs` cannot be reused: its items only hold a label, and a tab needs a close button and a dirty
 * marker beside the name. The semantics stay the same — a `tablist` of `role="tab"` buttons with a
 * roving tab stop and arrow-key movement.
 */
export function OfficeEditorTabs({
  tabs, activeId, states, onActivate, onClose, onCloseOthers, onCloseRight, onDuplicate, onShowInList,
}: OfficeEditorTabsProps) {
  const [menuTabId, setMenuTabId] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>(`[data-office-tab="${CSS.escape(activeId ?? '')}"]`)
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  const activateAt = (index: number) => {
    const target = tabs[(index + tabs.length) % tabs.length]
    if (target) onActivate(target.id)
  }

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      activateAt(index + (event.key === 'ArrowRight' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      activateAt(event.key === 'Home' ? 0 : tabs.length - 1)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      onClose(tabs[index]!.id)
    }
  }

  const menuItemsFor = (tab: OfficeOpenTab, index: number): MenuItem[] => editorTabMenuItems({
    index,
    count: tabs.length,
    onClose: () => onClose(tab.id),
    onCloseOthers: () => onCloseOthers(tab.id),
    onCloseRight: () => onCloseRight(tab.id),
    onDuplicate: () => onDuplicate(tab),
    onShowInList: () => onShowInList(tab),
  })

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={t('office.title')}
      className="office-tab-strip flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1"
    >
      {tabs.map((tab, index) => (
        <TabItem
          key={tab.id}
          tab={tab}
          selected={tab.id === activeId}
          state={states[tab.id]}
          menuOpen={menuTabId === tab.id}
          setMenuOpen={(open) => setMenuTabId(open ? tab.id : null)}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onClose(tab.id)}
          onKeyDown={(event) => onTabKeyDown(event, index)}
          menuItems={menuItemsFor(tab, index)}
        />
      ))}
      {tabs.length === 0 && (
        <span className="px-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('office.editor.loading')}</span>
      )}
    </div>
  )
}

function TabItem({
  tab, selected, state, menuOpen, setMenuOpen, onActivate, onClose, onKeyDown, menuItems,
}: {
  tab: OfficeOpenTab
  selected: boolean
  state: OfficeTabState | undefined
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  onActivate: () => void
  onClose: () => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  menuItems: MenuItem[]
}) {
  const menu = useContextMenu()
  const rowRef = useRef<HTMLDivElement>(null)
  const dirty = Boolean(state?.dirty || state?.save === 'dirty')

  const openAtTab = () => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) menu.openAt({ x: rect.left + 16, y: rect.bottom })
  }

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    setMenuOpen(false)
    if (event.clientX !== 0 || event.clientY !== 0) {
      menu.onContextMenu(event)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    openAtTab()
  }

  return (
    <div
      ref={rowRef}
      onContextMenu={onContextMenu}
      className={cn(
        'group relative flex h-8 shrink-0 items-center rounded-[var(--r-sm)] border transition-colors duration-[var(--dur-fast)]',
        selected
          ? 'border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[0_1px_2px_rgba(0,0,0,.08)]'
          : 'border-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        data-office-tab={tab.id}
        onClick={onActivate}
        onKeyDown={onKeyDown}
        title={tab.title}
        className="flex min-w-0 max-w-[180px] items-center gap-1.5 py-1 pr-1 pl-2 text-left text-[length:var(--text-12)] font-medium text-[var(--text-primary)]"
      >
        <span className="shrink-0 text-[var(--text-tertiary)]">{officeTypeIcon(tab.type, 13)}</span>
        <span className="truncate">{tab.title}</span>
        <SaveIndicator state={state} />
        {dirty && <span className="sr-only">{t('office.save.unsaved')}</span>}
      </button>
      <button
        type="button"
        aria-label={`${t('office.menu.tab.close')} ${tab.title}`}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <X size={11} />
      </button>
      <Menu anchor={rowRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} width={208} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={menuItems} width={208} />}
    </div>
  )
}