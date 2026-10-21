import type { ReactElement } from 'react'
import {
  Archive,
  CalendarDays,
  Compass,
  Home,
  Inbox,
  ListFilter,
  Map,
  Paperclip,
  Settings,
} from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoSpace } from '@shared/memos/types'
import type { MessageKey } from '../../../lib/i18n'
import { t } from '../../../lib/i18n'
import { parseMemoPath } from '../route'
import { navigateMemoUrl } from '../url-state'
import type { MemoResourceStatus } from '../use-resource'
import { SpacesSection } from './SpacesSection'
import { StatsSection } from './StatsSection'
import { TagsSection } from './TagsSection'
import { ViewsSection } from './ViewsSection'
import { SidebarLink } from './SidebarLink'

export interface MemoSidebarProps {
  pathname: string
  search: string
  spaces: MemoSpace[]
  spacesStatus: MemoResourceStatus
  spacesError: string | null
  onRetrySpaces: () => void
  onNavigate: () => void
}

interface NavEntry {
  id: string
  path: string
  labelKey: MessageKey
  icon: ReactElement
  active: boolean
}

export function MemoSidebar({
  pathname,
  search,
  spaces,
  spacesStatus,
  spacesError,
  onRetrySpaces,
  onNavigate,
}: MemoSidebarProps): ReactElement {
  const route = parseMemoPath(pathname)
  const spaceId = route.kind === 'space' || route.kind === 'calendar' || route.kind === 'attachments' || route.kind === 'map'
    ? route.spaceId
    : null
  const spaceBase = spaceId ? `${MEMOS_APP_PATH}/spaces/${encodeURIComponent(spaceId)}` : MEMOS_APP_PATH
  const entries: NavEntry[] = [
    {
      id: 'home',
      path: spaceBase,
      labelKey: 'memos.nav.home',
      icon: <Home size={14} />,
      active: route.kind === 'home' || route.kind === 'space',
    },
    {
      id: 'explore',
      path: `${MEMOS_APP_PATH}/explore`,
      labelKey: 'memos.nav.explore',
      icon: <Compass size={14} />,
      active: route.kind === 'explore',
    },
    {
      id: 'archived',
      path: `${MEMOS_APP_PATH}/archived`,
      labelKey: 'memos.nav.archived',
      icon: <Archive size={14} />,
      active: route.kind === 'archived',
    },
    {
      id: 'calendar',
      path: `${spaceBase}/calendar`,
      labelKey: 'memos.nav.calendar',
      icon: <CalendarDays size={14} />,
      active: route.kind === 'calendar',
    },
    {
      id: 'attachments',
      path: `${spaceBase}/attachments`,
      labelKey: 'memos.nav.attachments',
      icon: <Paperclip size={14} />,
      active: route.kind === 'attachments',
    },
    {
      id: 'map',
      path: `${spaceBase}/map`,
      labelKey: 'memos.nav.map',
      icon: <Map size={14} />,
      active: route.kind === 'map',
    },
    {
      id: 'views',
      path: `${MEMOS_APP_PATH}/views`,
      labelKey: 'memos.nav.views',
      icon: <ListFilter size={14} />,
      active: route.kind === 'views',
    },
    {
      id: 'inbox',
      path: `${MEMOS_APP_PATH}/inbox`,
      labelKey: 'memos.nav.inbox',
      icon: <Inbox size={14} />,
      active: route.kind === 'inbox',
    },
    {
      id: 'setting',
      path: `${MEMOS_APP_PATH}/setting`,
      labelKey: 'memos.nav.settings',
      icon: <Settings size={14} />,
      active: route.kind === 'setting',
    },
  ]
  const activeSpaceId = route.kind === 'space' || route.kind === 'calendar' || route.kind === 'attachments' || route.kind === 'map'
    ? route.spaceId
    : null
  return (
    <div className="flex h-full min-h-0 flex-col" data-memos-sidebar="">
      <div className="shrink-0 px-3 pt-3 pb-1">
        <p className="text-[length:var(--text-14-5)] font-semibold text-[var(--text-primary)]">{t('memos.sidebar.product')}</p>
        <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
          {t('memos.sidebar.description')}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <nav aria-label={t('memos.sidebar.navigation')} className="space-y-0.5">
          {entries.map((entry) => (
            <SidebarLink
              key={entry.id}
              href={entry.path}
              active={entry.active}
              icon={entry.icon}
              label={t(entry.labelKey)}
              onActivate={() => navigateMemoUrl(entry.path, '')}
              onNavigate={onNavigate}
            />
          ))}
          <div className="mt-2 border-t border-[var(--border-subtle)] pt-1" />
          <SpacesSection
            spaces={spaces}
            status={spacesStatus}
            error={spacesError}
            activeSpaceId={activeSpaceId}
            onRetry={onRetrySpaces}
            onNavigate={onNavigate}
          />
          <ViewsSection search={search} onNavigate={onNavigate} />
        </nav>
        <TagsSection />
        <StatsSection />
      </div>
    </div>
  )
}
