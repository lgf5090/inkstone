import type { ReactElement, Ref } from 'react'
import { MEMOS_MESSAGE_KEYS } from '@shared/memos/keys'
import type { Memo } from '@shared/memos/types'
import { Badge } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import { fullTime } from '../../../lib/time'
import { MemoBody } from './MemoBody'

export const MEMO_SHARE_IMAGE_WIDTH = 420
export const MEMO_SHARE_IMAGE_MIN_HEIGHT = 240

export interface MemoShareImageAuthor {
  name: string
  username: string
}

export interface MemoShareImageProps {
  memo: Memo
  author: MemoShareImageAuthor | null
  ref?: Ref<HTMLDivElement>
}

export function MemoShareImage({ memo, author, ref }: MemoShareImageProps): ReactElement {
  const createdMs = memo.createdAt * 1000
  const name = author?.name.trim() || author?.username || ''
  return (
    <div ref={ref} className="w-[var(--memo-share-image-width)] bg-[var(--bg-base)] p-4" data-memo-share-image="">
      <article className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-sm">
        <header className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2">
          <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
            {t(MEMOS_MESSAGE_KEYS.appTab)}
          </span>
          <time
            dateTime={new Date(createdMs).toISOString()}
            className="text-[length:var(--text-11)] text-[var(--text-tertiary)]"
          >
            {fullTime(createdMs)}
          </time>
        </header>
        <MemoBody content={memo.content} className="mt-3 text-[length:var(--text-12-5)]" />
        {memo.tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {memo.tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}
          </div>
        ) : null}
        {name ? (
          <footer className="mt-3 border-t border-[var(--border-subtle)] pt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {author?.username
              ? t('memos.share.image_author', { name, username: author.username })
              : name}
          </footer>
        ) : null}
      </article>
    </div>
  )
}
