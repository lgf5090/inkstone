import type { ReactElement } from 'react'
import { ListFilter, Plus, Settings2 } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoView } from '@shared/memos/types'
import { Button, SectionLabel } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'
import { useRevision } from '../events'
import { useMemoResource } from '../use-resource'
import {
  buildMemoSearch,
  memoHref,
  memoQueryFilter,
  navigateMemoUrl,
  readMemoUrlState,
} from '../url-state'
import { SidebarLink } from './SidebarLink'

const VIEWS_PAGE_PATH = `${MEMOS_APP_PATH}/views`

function saveFilterSearch(filter: string): string {
  return `?filter=${encodeURIComponent(filter)}`
}

export interface ViewsSectionProps {
  search: string
  onNavigate: () => void
}

export function ViewsSection({ search, onNavigate }: ViewsSectionProps): ReactElement {
  const revision = useRevision('views')
  const views = useMemoResource(
    (signal) => memosApi.views.list(signal).then((page) => page.views),
    [revision],
  )
  const urlState = readMemoUrlState(search)
  const activeFilter = urlState.filter.trim()
  const currentFilter = memoQueryFilter(urlState)
  const items: MemoView[] = views.data ?? []
  return (
    <div className="pt-2">
      <SectionLabel>{t('memos.nav.saved_views')}</SectionLabel>
      {views.status === 'loading' && items.length === 0 ? (
        <div className="space-y-1 px-2 py-1">
          <Skeleton className="h-6" />
        </div>
      ) : null}
      {views.status === 'error' && items.length === 0 ? (
        <div className="px-2 py-1">
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
            {views.error ?? t('memos.sidebar.views_error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={views.reload}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {views.status === 'ready' && items.length === 0 ? (
        <div className="mx-2 mt-1 rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] px-2 py-2">
          <p className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
            {t('memos.sidebar.views_empty')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
            {t('memos.sidebar.views_empty_hint')}
          </p>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={12} />}
            className="mt-1.5 h-7 px-2"
            onClick={() => navigateMemoUrl(VIEWS_PAGE_PATH, '')}
          >
            {t('memos.sidebar.views_create')}
          </Button>
        </div>
      ) : null}
      {items.length > 0 ? (
        <div className="space-y-0.5">
          {items.map((view) => {
            const viewSearch = buildMemoSearch({ filter: view.filter })
            return (
              <SidebarLink
                key={view.id}
                href={memoHref(MEMOS_APP_PATH, viewSearch)}
                active={activeFilter !== '' && activeFilter === view.filter.trim()}
                icon={view.icon ? <span className="text-[length:var(--text-12)]">{view.icon}</span> : <ListFilter size={13} />}
                label={view.title}
                onActivate={() => navigateMemoUrl(MEMOS_APP_PATH, viewSearch)}
                onNavigate={onNavigate}
              />
            )
          })}
        </div>
      ) : null}
      {currentFilter ? (
        <SidebarLink
          href={`${VIEWS_PAGE_PATH}${saveFilterSearch(currentFilter)}`}
          active={false}
          icon={<Plus size={13} />}
          label={t('memos.sidebar.views_save_current')}
          onActivate={() => navigateMemoUrl(VIEWS_PAGE_PATH, saveFilterSearch(currentFilter))}
          onNavigate={onNavigate}
        />
      ) : null}
      <SidebarLink
        href={VIEWS_PAGE_PATH}
        active={false}
        icon={<Settings2 size={13} />}
        label={t('memos.views.manage')}
        onActivate={() => navigateMemoUrl(VIEWS_PAGE_PATH, '')}
        onNavigate={onNavigate}
      />
    </div>
  )
}
