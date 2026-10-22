import type { MouseEvent, ReactElement } from 'react'
import { CornerDownRight } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { ApiError } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'
import { useMemoResource } from '../use-resource'

export interface MemoParentLinkProps {
  parentId: string
  onOpen: (id: string) => void
  className?: string
}

function parentLabel(parent: Memo): string {
  return parent.title.trim()
    || parent.snippet.trim()
    || t('memos.attachments.library.source_memo_untitled')
}

export function MemoParentLink({ parentId, onOpen, className }: MemoParentLinkProps): ReactElement {
  const parent = useMemoResource<Memo | null>(async (signal) => {
    try {
      return await memosApi.get(parentId, signal)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  }, [parentId])

  if (parent.status === 'loading' && parent.data === null) {
    return (
      <div className={className} role="status" aria-label={t('memos.common.loading')}>
        <Skeleton className="h-5 w-48" />
      </div>
    )
  }

  if (parent.status === 'error' && parent.data === null) {
    return (
      <div className={className}>
        <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {parent.error ?? t('memos.parent.error')}
        </p>
        <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={parent.reload}>
          {t('memos.common.retry')}
        </Button>
      </div>
    )
  }

  if (parent.data === null) {
    return (
      <p className={className} role="status">
        <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('memos.parent.unavailable')}
        </span>
      </p>
    )
  }

  const parentMemo = parent.data
  const href = `${MEMOS_APP_PATH}/m/${encodeURIComponent(parentMemo.id)}`
  const openParent = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen(parentMemo.id)
  }

  return (
    <div className={className}>
      <a
        href={href}
        onClick={openParent}
        className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--bg-raised)] px-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
        <span className="shrink-0 text-[var(--text-quaternary)]">{t('memos.parent.label')}</span>
        <span className="min-w-0 truncate text-[var(--text-primary)]">{parentLabel(parentMemo)}</span>
      </a>
    </div>
  )
}
