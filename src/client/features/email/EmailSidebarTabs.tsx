import { useRef } from 'react'
import { Bookmark, ContactRound, FolderClosed, Star, Tags, Users } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t, type MessageKey } from '../../lib/i18n'
import { Tooltip } from '../../components/overlay'

export type EmailSidebarTab = 'folders' | 'tags' | 'favorites' | 'contacts' | 'groups' | 'searches'

interface TabSpec {
  id: EmailSidebarTab
  labelKey: MessageKey
  icon: React.ReactNode
}

export const EMAIL_SIDEBAR_PANEL_ID = 'email-sidebar-panel'

export function emailSidebarTabId(tab: EmailSidebarTab): string {
  return `email-sidebar-tab-${tab}`
}

const TAB_SPECS: readonly TabSpec[] = [
  { id: 'folders', labelKey: 'email.sidebar.tab_folders', icon: <FolderClosed size={14} /> },
  { id: 'tags', labelKey: 'email.sidebar.tab_tags', icon: <Tags size={14} /> },
  { id: 'favorites', labelKey: 'email.sidebar.tab_favorites', icon: <Star size={14} /> },
  { id: 'contacts', labelKey: 'email.sidebar.tab_contacts', icon: <ContactRound size={14} /> },
  { id: 'groups', labelKey: 'email.sidebar.tab_groups', icon: <Users size={14} /> },
  { id: 'searches', labelKey: 'email.sidebar.tab_searches', icon: <Bookmark size={14} /> },
]

export function EmailSidebarTabs({
  active,
  onSelect,
}: {
  active: EmailSidebarTab
  onSelect: (tab: EmailSidebarTab) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  const focusTab = (index: number): void => {
    const tabs = ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
    const target = tabs[(index + tabs.length) % tabs.length]
    if (!target) return
    target.focus()
    const id = target.dataset.tab as EmailSidebarTab | undefined
    if (id) onSelect(id)
  }

  const positionOf = (): number => {
    const tabs = [...ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []]
    const focused = tabs.findIndex((tab) => tab === document.activeElement)
    return focused >= 0 ? focused : TAB_SPECS.findIndex((spec) => spec.id === active)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const at = positionOf()
    if (event.key === 'ArrowRight') focusTab(at + 1)
    else if (event.key === 'ArrowLeft') focusTab(at - 1)
    else if (event.key === 'Home') focusTab(0)
    else if (event.key === 'End') focusTab(TAB_SPECS.length - 1)
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={t('email.sidebar.tabs_aria')}
      onKeyDown={onKeyDown}
      className="mx-2 mb-1.5 flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] bg-[var(--bg-inset)] p-0.5"
    >
      {TAB_SPECS.map((spec) => {
        const label = t(spec.labelKey)
        const selected = spec.id === active
        return (
          <Tooltip key={spec.id} label={label} side="bottom">
            <button
              type="button"
              role="tab"
              id={emailSidebarTabId(spec.id)}
              data-email-sidebar-tab={spec.id}
              aria-selected={selected}
              aria-controls={EMAIL_SIDEBAR_PANEL_ID}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(spec.id)}
              className={cn(
                'flex h-7 min-w-0 flex-1 items-center justify-center rounded-[var(--r-sm)] transition-colors',
                selected
                  ? 'bg-[var(--bg-raised)] text-[var(--text-primary)] shadow-[var(--shadow-xs)]'
                  : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
              )}
            >
              <span className="sr-only">{label}</span>
              {spec.icon}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
