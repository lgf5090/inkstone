import { Compass, Flame, Package, Rocket, Trophy } from 'lucide-react'
import type { GithubDiscoverChart, GithubPlatformFilter } from '@shared/development/github/types'
import { GITHUB_DISCOVER_TOPICS } from '@shared/development/github/types'
import { GITHUB_PLATFORM_FILTERS } from '@shared/development/github/platforms'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { SidebarItem, SectionLabel } from './TagSidebarParts'

const PLATFORM_LABEL_KEYS: Record<GithubPlatformFilter, string> = {
  all: 'development.github.store.platform.all',
  android: 'development.github.store.platform.android',
  windows: 'development.github.store.platform.windows',
  macos: 'development.github.store.platform.macos',
  linux: 'development.github.store.platform.linux',
}

const CHART_ICONS: Record<GithubDiscoverChart, React.ReactNode> = {
  trending: <Flame size={14} className="text-[var(--warning)]" />,
  releases: <Rocket size={14} className="text-[var(--accent)]" />,
  popular: <Trophy size={14} className="text-[var(--warning)]" />,
}

export function platformLabel(platform: GithubPlatformFilter): string {
  return t(PLATFORM_LABEL_KEYS[platform] as Parameters<typeof t>[0])
}

export function StoreSidebar({
  view,
  onViewChange,
  chart,
  onChartChange,
  platform,
  onPlatformChange,
  topic,
  onTopicChange,
  appCount,
  updateCount,
  filteredCount,
}: {
  view: 'discover' | 'apps'
  onViewChange: (view: 'discover' | 'apps') => void
  chart: GithubDiscoverChart
  onChartChange: (chart: GithubDiscoverChart) => void
  platform: GithubPlatformFilter
  onPlatformChange: (platform: GithubPlatformFilter) => void
  topic: string
  onTopicChange: (topic: string) => void
  appCount: number
  updateCount: number
  filteredCount: number
}) {
  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-sunken)]" data-slot="store-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-1 p-2">
          <SidebarItem icon={<Compass size={14} className="text-[var(--accent)]" />} label={t('development.github.store.discover')} count={filteredCount} active={view === 'discover'} onClick={() => onViewChange('discover')} />
          <SidebarItem
            icon={<Package size={14} />}
            label={t('development.github.store.my_apps')}
            count={appCount}
            active={view === 'apps'}
            onClick={() => onViewChange('apps')}
            badge={updateCount > 0
              ? <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--warning)_18%,transparent)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--warning)]">{updateCount}</span>
              : undefined}
          />
          {view === 'discover' && (
            <>
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <SectionLabel>{t('development.github.store.chart.label')}</SectionLabel>
              {(['trending', 'releases', 'popular'] as const).map((value) => (
                <SidebarItem
                  key={value}
                  icon={CHART_ICONS[value]}
                  label={t(`development.github.store.chart.${value}` as Parameters<typeof t>[0])}
                  active={chart === value}
                  onClick={() => onChartChange(value)}
                />
              ))}
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <SectionLabel>{t('development.github.store.platform.label')}</SectionLabel>
              <div className="grid grid-cols-2 gap-1 px-1">
                {GITHUB_PLATFORM_FILTERS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={platform === value}
                    onClick={() => onPlatformChange(value)}
                    className={cn(
                      'rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-11)] transition-colors',
                      platform === value
                        ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    {platformLabel(value)}
                  </button>
                ))}
              </div>
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <SectionLabel>{t('development.github.store.topic.label')}</SectionLabel>
              <div className="space-y-0.5">
                <SidebarItem icon={<span className="block size-2 rounded-full bg-[var(--text-quaternary)]" />} label={t('development.github.store.topic.all')} active={topic === ''} onClick={() => onTopicChange('')} />
                {GITHUB_DISCOVER_TOPICS.map((entry) => (
                  <SidebarItem
                    key={entry.value}
                    icon={<span className="block size-2 rounded-full bg-[var(--accent)]" />}
                    label={t(entry.labelKey)}
                    active={topic === entry.value}
                    onClick={() => onTopicChange(topic === entry.value ? '' : entry.value)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
