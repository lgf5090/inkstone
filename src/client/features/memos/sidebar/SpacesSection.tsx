import type { ReactElement } from 'react'
import { Folder } from 'lucide-react'
import type { MemoSpace } from '@shared/memos/types'
import { Button, SectionLabel } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { navigateMemoUrl } from '../url-state'
import type { MemoResourceStatus } from '../use-resource'
import { SidebarLink } from './SidebarLink'

export interface SpacesSectionProps {
  spaces: MemoSpace[]
  status: MemoResourceStatus
  error: string | null
  activeSpaceId: string | null
  onRetry: () => void
  onNavigate: () => void
}

export function SpacesSection({
  spaces,
  status,
  error,
  activeSpaceId,
  onRetry,
  onNavigate,
}: SpacesSectionProps): ReactElement {
  return (
    <div className="pt-2">
      <SectionLabel>{t('memos.nav.spaces')}</SectionLabel>
      {status === 'loading' && spaces.length === 0 ? (
        <div className="space-y-1 px-2 py-1">
          <Skeleton className="h-6" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      ) : null}
      {status === 'error' && spaces.length === 0 ? (
        <div className="px-2 py-1">
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
            {error ?? t('memos.sidebar.spaces_error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={onRetry}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {status === 'ready' && spaces.length === 0 ? (
        <p className="px-2 py-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
          {t('memos.sidebar.spaces_empty')}
        </p>
      ) : null}
      {spaces.length > 0 ? (
        <div className="space-y-0.5">
          {spaces.map((space) => {
            const path = `/memos/spaces/${encodeURIComponent(space.id)}`
            return (
              <SidebarLink
                key={space.id}
                href={path}
                active={space.id === activeSpaceId}
                icon={space.icon ? <span className="text-[length:var(--text-12)]">{space.icon}</span> : <Folder size={13} />}
                label={space.title}
                count={space.memoCount ?? null}
                onActivate={() => navigateMemoUrl(path, '')}
                onNavigate={onNavigate}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
