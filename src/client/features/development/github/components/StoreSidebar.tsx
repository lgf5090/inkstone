import { Compass, Flame, Hash, Heart, Laptop, Layers, Monitor, Package, Rocket, Smartphone, Terminal, Trophy } from 'lucide-react'
import type { GithubDiscoverCategory, GithubDiscoverChart, GithubPlatformFilter } from '@shared/development/github/types'
import { GITHUB_DISCOVER_CATEGORIES, GITHUB_DISCOVER_TOPICS } from '@shared/development/github/types'
import { GITHUB_PLATFORM_FILTERS } from '@shared/development/github/platforms'
import { t } from '../../../../lib/i18n'
import { Badge } from '../../../../components/primitives'
import { SidebarItem, SectionLabel } from './TagSidebarParts'

const PLATFORM_LABEL_KEYS: Record<GithubPlatformFilter, string> = {
  all: 'development.github.store.platform.all',
  android: 'development.github.store.platform.android',
  windows: 'development.github.store.platform.windows',
  macos: 'development.github.store.platform.macos',
  linux: 'development.github.store.platform.linux',
}

const CHART_ICONS: Record<GithubDiscoverChart, React.ReactNode> = {
  trending: <Flame size={13} />,
  releases: <Rocket size={13} />,
  popular: <Trophy size={13} />,
}

const PLATFORM_ICONS: Record<GithubPlatformFilter, React.ReactNode> = {
  all: <Layers size={13} />,
  android: <Smartphone size={13} />,
  windows: <Monitor size={13} />,
  macos: <Laptop size={13} />,
  linux: <Terminal size={13} />,
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
  category,
  onCategoryChange,
  updateCount,
  favoriteCount,
  filteredCount,
}: {
  view: 'discover' | 'apps' | 'favorites'
  onViewChange: (view: 'discover' | 'apps' | 'favorites') => void
  chart: GithubDiscoverChart
  onChartChange: (chart: GithubDiscoverChart) => void
  platform: GithubPlatformFilter
  onPlatformChange: (platform: GithubPlatformFilter) => void
  topic: string
  onTopicChange: (topic: string) => void
  category: GithubDiscoverCategory
  onCategoryChange: (category: GithubDiscoverCategory) => void
  updateCount: number
  favoriteCount: number
  filteredCount?: number
}) {
  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-sunken)]" data-slot="store-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-1 p-2">
          <SidebarItem icon={<Compass size={14} />} label={t('development.github.store.discover')} count={filteredCount} active={view === 'discover'} onClick={() => onViewChange('discover')} />
          <SidebarItem
            icon={<Package size={14} />}
            label={t('development.github.store.my_apps')}
            active={view === 'apps'}
            onClick={() => onViewChange('apps')}
            badge={updateCount > 0 ? <Badge tone="warning" className="shrink-0 tabular">{t('development.github.apps.updates_count', { count: updateCount })}</Badge> : undefined}
          />
          <SidebarItem
            icon={<Heart size={14} />}
            label={t('development.github.store.favorites')}
            count={favoriteCount}
            active={view === 'favorites'}
            onClick={() => onViewChange('favorites')}
          />
          {view === 'discover' && (
            <>
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <SectionLabel>{t('development.github.store.category.label')}</SectionLabel>
              {GITHUB_DISCOVER_CATEGORIES.map((entry) => (
                <SidebarItem
                  key={entry.value}
                  icon={<Layers size={13} />}
                  label={t(entry.labelKey)}
                  active={category === entry.value}
                  pressed={category === entry.value}
                  onClick={() => onCategoryChange(entry.value)}
                />
              ))}
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <SectionLabel>{t('development.github.store.chart.label')}</SectionLabel>
              {(['trending', 'releases', 'popular'] as const).map((value) => (
                <SidebarItem
                  key={value}
                  icon={CHART_ICONS[value]}
                  label={t(`development.github.store.chart.${value}` as Parameters<typeof t>[0])}
                  active={chart === value}
                  pressed={chart === value}
                  onClick={() => onChartChange(value)}
                />
              ))}
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <SectionLabel>{t('development.github.store.platform.label')}</SectionLabel>
              {GITHUB_PLATFORM_FILTERS.map((value) => (
                <SidebarItem
                  key={value}
                  icon={PLATFORM_ICONS[value]}
                  label={platformLabel(value)}
                  active={platform === value}
                  pressed={platform === value}
                  onClick={() => onPlatformChange(value)}
                />
              ))}
              <div className="my-2 border-t border-[var(--border-subtle)]" />
              <SectionLabel>{t('development.github.store.topic.label')}</SectionLabel>
              <SidebarItem icon={<Layers size={13} />} label={t('development.github.store.topic.all')} active={topic === ''} pressed={topic === ''} onClick={() => onTopicChange('')} />
              {GITHUB_DISCOVER_TOPICS.map((entry) => (
                <SidebarItem
                  key={entry.value}
                  icon={<Hash size={13} />}
                  label={t(entry.labelKey)}
                  active={topic === entry.value}
                  pressed={topic === entry.value}
                  onClick={() => onTopicChange(topic === entry.value ? '' : entry.value)}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
