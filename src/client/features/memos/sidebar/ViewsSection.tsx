import type { ReactElement } from 'react'
import { ListFilter } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoView } from '@shared/memos/types'
import { Button, SectionLabel } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'
import { useRevision } from '../events'
import { useMemoResource } from '../use-resource'
import { buildMemoSearch, memoHref, navigateMemoUrl, readMemoUrlState } from '../url-state'
import { SidebarLink } from './SidebarLink'

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
  const activeFilter = readMemoUrlState(search).filter.trim()
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
        <p className="px-2 py-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
          {t('memos.sidebar.views_empty')}
        </p>
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
    </div>
  )
}
