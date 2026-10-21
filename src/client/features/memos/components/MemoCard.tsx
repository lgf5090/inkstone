import type { MouseEvent, ReactElement } from 'react'
import { MessageCircle, Pin } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo, MemoOrderField, MemoVisibility } from '@shared/memos/types'
import { Badge } from '../../../components/primitives'
import { TagChip } from '../../../components/TagChip'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { fullTime, shortTime } from '../../../lib/time'
import { useMemoTaskToggle } from '../use-memo-task-toggle'
import { MemoAttachments } from './MemoAttachments'
import { MemoBody } from './MemoBody'
import { MemoCardActions } from './MemoCardActions'
import { MemoComposer } from './MemoComposer'
import { MemoReactions } from './MemoReactions'

const VISIBILITY_KEYS: Record<MemoVisibility, MessageKey> = {
  private: 'memos.visibility.private',
  protected: 'memos.visibility.protected',
  public: 'memos.visibility.public',
}

const VISIBILITY_TONES: Record<MemoVisibility, 'neutral' | 'accent' | 'warning'> = {
  private: 'neutral',
  protected: 'warning',
  public: 'accent',
}

export interface MemoCardProps {
  memo: Memo
  spaceName: string | null
  isNew: boolean
  compact: boolean
  timeBasis: MemoOrderField
  editing: boolean
  onOpen: (id: string) => void
  onStartEdit: () => void
  onEndEdit: () => void
  onTagPress: (tag: string) => void
}

export function MemoCard({
  memo,
  spaceName,
  isNew,
  compact,
  timeBasis,
  editing,
  onOpen,
  onStartEdit,
  onEndEdit,
  onTagPress,
}: MemoCardProps): ReactElement {
  const href = `${MEMOS_APP_PATH}/m/${encodeURIComponent(memo.id)}`
  const onToggleTask = useMemoTaskToggle(memo)
  const shownAt = timeBasis === 'updated' ? memo.updatedAt : memo.createdAt
  const shownMs = shownAt * 1000
  const shownLabel = t(timeBasis === 'updated' ? 'memos.card.updated_at' : 'memos.card.created_at', {
    time: fullTime(shownMs),
  })
  const shownShort = shortTime(shownMs)
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen(memo.id)
  }
  const commentLabel = t(memo.commentCount === 1 ? 'memos.card.comments_one' : 'memos.card.comments', {
    count: memo.commentCount,
  })
  return (
    <article
      data-memo-id={memo.id}
      className={cn(
        'flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-sm',
        compact ? 'p-2.5' : 'p-3',
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-1.5">
        <a
          href={href}
          onClick={onLinkClick}
          aria-label={`${shownShort} · ${t('memos.card.open')}`}
          title={shownLabel}
          className="min-w-0 truncate rounded-[var(--r-xs)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <time dateTime={new Date(shownMs).toISOString()}>{shownShort}</time>
        </a>
        {memo.pinned ? (
          <span role="img" aria-label={t('memos.card.pinned')} className="shrink-0 text-[var(--accent)]">
            <Pin size={12} />
          </span>
        ) : null}
        {isNew ? <Badge tone="accent">{t('memos.card.new')}</Badge> : null}
        <Badge tone={VISIBILITY_TONES[memo.visibility]}>{t(VISIBILITY_KEYS[memo.visibility])}</Badge>
        {spaceName ? <Badge>{spaceName}</Badge> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <MemoCardActions memo={memo} onEdit={memo.state === 'normal' ? onStartEdit : undefined} />
        </div>
      </header>
      {editing ? (
        <div className="mt-2">
          <MemoComposer memo={memo} onSaved={onEndEdit} onCancel={onEndEdit} />
        </div>
      ) : (
        <>
          <MemoBody content={memo.content} onTagPress={onTagPress} onToggleTask={onToggleTask} className="mt-2" />
          {memo.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {memo.tags.map((tag) => (
                <TagChip
                  key={tag}
                  label={tag}
                  sigil
                  onPress={() => onTagPress(tag)}
                  ariaLabel={t('memos.card.filter_tag', { tag })}
                />
              ))}
            </div>
          ) : null}
          <MemoAttachments attachments={memo.attachments} compact className="mt-2" />
          <footer className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] pt-1.5">
            <MemoReactions memo={memo} readOnly={memo.state === 'archived'} />
            <a
              href={href}
              onClick={onLinkClick}
              aria-label={commentLabel}
              className="ml-auto inline-flex min-h-10 items-center gap-1 rounded-[var(--r-sm)] px-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:min-h-0 md:h-6"
            >
              <MessageCircle size={13} aria-hidden="true" />
              <span className="tabular">{memo.commentCount}</span>
            </a>
          </footer>
        </>
      )}
    </article>
  )
}
