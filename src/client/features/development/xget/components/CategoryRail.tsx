import type { ReactNode } from 'react'
import { BarChart3, Settings2, Zap } from 'lucide-react'
import type { XgetCategory } from '@shared/development/xget/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { useThemeDark } from '../../../../lib/hooks'
import { Badge, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { categoryColor, CATEGORY_ICONS, CATEGORY_LABEL_KEYS, CATEGORY_ORDER } from '../lib/category'

export type XgetView = 'stats' | 'platforms' | 'settings'

interface RailProps {
  view: XgetView
  activeCategory: XgetCategory
  counts: Record<XgetCategory, number>
  total: number
  onSelectCategory: (category: XgetCategory) => void
  onShowStats: () => void
  onShowSettings: () => void
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-left text-[length:var(--text-13)]',
        'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      {children}
    </button>
  )
}

export function CategoryRail({
  view,
  activeCategory,
  counts,
  total,
  onSelectCategory,
  onShowStats,
  onShowSettings,
}: RailProps) {
  const dark = useThemeDark()
  return (
    <aside
      aria-label={t('development.xget.platforms.title')}
      className="hidden w-56 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] md:flex"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        <Zap size={16} className="shrink-0 text-[var(--accent)]" />
        <span className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('development.xget.module_name')}
        </span>
        <Badge className="ml-auto">{total}</Badge>
      </div>

      <div className="border-b border-[var(--border-subtle)] p-2">
        <NavButton active={view === 'stats'} onClick={onShowStats}>
          <BarChart3 size={15} className="shrink-0" />
          <span className="text-left">{t('development.xget.nav.stats')}</span>
        </NavButton>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label={t('development.xget.platforms.title')}>
        {CATEGORY_ORDER.map((category) => {
          const Icon = CATEGORY_ICONS[category]
          return (
            <NavButton
              key={category}
              active={view === 'platforms' && activeCategory === category}
              onClick={() => onSelectCategory(category)}
            >
              <Icon size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{t(CATEGORY_LABEL_KEYS[category])}</span>
              <span
                className="shrink-0 rounded-full px-1.5 text-[length:var(--text-10)] tabular"
                style={{ color: categoryColor(category, dark), backgroundColor: 'var(--bg-raised)' }}
              >
                {counts[category]}
              </span>
            </NavButton>
          )
        })}
      </nav>

      <div className="border-t border-[var(--border-subtle)] p-2">
        <NavButton active={view === 'settings'} onClick={onShowSettings}>
          <Settings2 size={15} className="shrink-0" />
          <span className="text-left">{t('development.xget.nav.settings')}</span>
        </NavButton>
      </div>
    </aside>
  )
}

export function CategoryBar({
  view,
  activeCategory,
  counts,
  onSelectCategory,
  onShowStats,
  onShowSettings,
}: Omit<RailProps, 'total'>) {
  const dark = useThemeDark()
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-2 md:hidden">
      <div className="flex items-center gap-1.5">
        <Zap size={16} className="shrink-0 text-[var(--accent)]" />
        <span className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('development.xget.module_name')}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip label={t('development.xget.nav.stats')}>
            <IconButton
              label={t('development.xget.nav.stats')}
              size="sm"
              active={view === 'stats'}
              onClick={onShowStats}
            >
              <BarChart3 size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('development.xget.nav.settings')}>
            <IconButton
              label={t('development.xget.nav.settings')}
              size="sm"
              active={view === 'settings'}
              onClick={onShowSettings}
            >
              <Settings2 size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-0.5">
        {CATEGORY_ORDER.map((category) => {
          const Icon = CATEGORY_ICONS[category]
          const active = view === 'platforms' && activeCategory === category
          return (
            <button
              key={category}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectCategory(category)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--text-12)]',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                  : 'border-[var(--border-subtle)] text-[var(--text-secondary)]',
              )}
            >
              <Icon size={13} />
              <span>{t(CATEGORY_LABEL_KEYS[category])}</span>
              <span className="tabular" style={{ color: categoryColor(category, dark) }}>
                {counts[category]}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
