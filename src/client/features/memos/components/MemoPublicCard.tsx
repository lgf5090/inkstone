import type { ReactElement } from 'react'
import { ArrowLeft, Pin } from 'lucide-react'
import type { Memo, MemoAttachment } from '@shared/memos/types'
import { Avatar, Badge } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import { fullTime, shortTime } from '../../../lib/time'
import { MemoAttachments } from './MemoAttachments'
import { MemoBody } from './MemoBody'

export function memoAttachmentUrl(url: string, shareToken: string): string {
  const hashIndex = url.indexOf('#')
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}share=${encodeURIComponent(shareToken)}${hash}`
}

export function applyShareToken(memo: Memo, shareToken: string): Memo {
  const attachments: MemoAttachment[] = memo.attachments.map((attachment) => ({
    ...attachment,
    url: memoAttachmentUrl(attachment.url, shareToken),
    thumbnailUrl: attachment.thumbnailUrl ? memoAttachmentUrl(attachment.thumbnailUrl, shareToken) : null,
  }))
  return { ...memo, attachments }
}

function MemoCreator({ memo }: { memo: Memo }): ReactElement | null {
  const creator = memo.creator
  if (!creator) return null
  const name = creator.name.trim() || creator.username
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar src={creator.avatarUrl} name={name} size={22} />
      <span className="min-w-0 truncate text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{name}</span>
      <span className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {t('memos.public.handle', { username: creator.username })}
      </span>
    </span>
  )
}

function MemoTime({ memo, short }: { memo: Memo; short: boolean }): ReactElement {
  const createdMs = memo.createdAt * 1000
  return (
    <time
      dateTime={new Date(createdMs).toISOString()}
      title={t('memos.card.created_at', { time: fullTime(createdMs) })}
      className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]"
    >
      {short ? shortTime(createdMs) : fullTime(createdMs)}
    </time>
  )
}

function MemoTags({ tags }: { tags: string[] }): ReactElement | null {
  if (tags.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}
    </div>
  )
}

function MemoPin(): ReactElement {
  return (
    <span role="img" aria-label={t('memos.card.pinned')} className="shrink-0 text-[var(--accent)]">
      <Pin size={12} />
    </span>
  )
}

export interface MemoPublicCardProps {
  memo: Memo
  href?: string
}

export function MemoPublicCard({ memo, href }: MemoPublicCardProps): ReactElement {
  return (
    <article
      data-public-memo-id={memo.id}
      className="flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 shadow-sm"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-1.5">
        <MemoCreator memo={memo} />
        {memo.pinned ? <MemoPin /> : null}
        <span className="ml-auto">
          <MemoTime memo={memo} short />
        </span>
      </header>
      <MemoBody content={memo.content} className="mt-2" />
      <MemoTags tags={memo.tags} />
      <MemoAttachments attachments={memo.attachments} compact className="mt-2" />
      {href ? (
        <footer className="mt-2 border-t border-[var(--border-subtle)] pt-1.5">
          <a
            href={href}
            className="inline-flex min-h-10 items-center rounded-[var(--r-sm)] text-[length:var(--text-11-5)] font-medium text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-0"
          >
            {t('memos.public.open_memo')}
          </a>
        </footer>
      ) : null}
    </article>
  )
}

export interface MemoPublicArticleProps {
  memo: Memo
  backHref?: string
  backLabel?: string
}

export function MemoPublicArticle({ memo, backHref, backLabel }: MemoPublicArticleProps): ReactElement {
  const createdMs = memo.createdAt * 1000
  const updatedMs = memo.updatedAt * 1000
  return (
    <article
      data-public-memo-id={memo.id}
      className="min-w-0 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 shadow-sm md:p-4"
    >
      {backHref && backLabel ? (
        <a
          href={backHref}
          className="mb-3 inline-flex min-h-10 items-center gap-1 rounded-[var(--r-sm)] text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-0"
        >
          <ArrowLeft size={13} aria-hidden="true" />
          {backLabel}
        </a>
      ) : null}
      <header className="flex min-w-0 flex-wrap items-center gap-1.5">
        <MemoCreator memo={memo} />
        {memo.pinned ? <MemoPin /> : null}
        <span className="ml-auto">
          <MemoTime memo={memo} short={false} />
        </span>
      </header>
      {updatedMs !== createdMs ? (
        <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {t('memos.card.updated_at', { time: fullTime(updatedMs) })}
        </p>
      ) : null}
      <MemoBody content={memo.content} className="mt-3" />
      <MemoTags tags={memo.tags} />
      <MemoAttachments attachments={memo.attachments} className="mt-3" />
    </article>
  )
}
