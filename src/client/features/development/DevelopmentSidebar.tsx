import { Database, PanelLeftClose, PanelLeft, Terminal, Zap } from 'lucide-react'
import { usePathname, navigateToPath } from '../../lib/app-history'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { developmentModuleForPath, useDevelopmentStore } from './store'

interface DevelopmentSidebarProps {
  collapsed?: boolean
  onCollapse?: () => void
  onExpand?: () => void
  onNavigate?: () => void
}

const NAV_ITEMS = [
  {
    id: 'database',
    path: '/development/database',
    labelKey: 'development.database.module_name',
    icon: Database,
  },
  {
    id: 'xget',
    path: '/development/xget',
    labelKey: 'development.xget.module_name',
    icon: Zap,
  },
] as const

export function DevelopmentSidebar({
  collapsed = false,
  onCollapse,
  onExpand,
  onNavigate,
}: DevelopmentSidebarProps) {
  const pathname = usePathname()
  const navWidth = useDevelopmentStore((state) => state.navWidth)
  const activeId = developmentModuleForPath(pathname)

  const go = (path: string) => {
    navigateToPath(path)
    onNavigate?.()
  }

  if (collapsed) {
    return (
      <aside
        aria-label={t('development.sidebar.title')}
        className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
      >
        <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-[var(--border-subtle)]">
          <Tooltip label={t('development.sidebar.expand')} side="right">
            <IconButton label={t('development.sidebar.expand')} size="sm" onClick={onExpand}>
              <PanelLeft size={16} />
            </IconButton>
          </Tooltip>
        </div>
        <div className="flex w-full flex-col items-center gap-1 py-2">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <Tooltip key={item.id} label={t(item.labelKey)} side="right">
                <IconButton
                  label={t(item.labelKey)}
                  size="sm"
                  active={activeId === item.id}
                  onClick={() => go(item.path)}
                >
                  <Icon size={16} />
                </IconButton>
              </Tooltip>
            )
          })}
        </div>
      </aside>
    )
  }

  return (
    <aside
      aria-label={t('development.sidebar.title')}
      className="flex h-full min-h-0 w-full flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
      style={{ width: navWidth }}
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <h2 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('development.sidebar.title')}
          </h2>
        </div>
        {onCollapse && (
          <Tooltip label={t('development.sidebar.collapse')}>
            <IconButton label={t('development.sidebar.collapse')} size="sm" onClick={onCollapse}>
              <PanelLeftClose size={15} />
            </IconButton>
          </Tooltip>
        )}
      </header>
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2" aria-label={t('development.sidebar.title')}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const selected = activeId === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => go(item.path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 py-2 text-left text-[length:var(--text-13)]',
                'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                selected
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <Icon size={16} className="shrink-0" />
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
