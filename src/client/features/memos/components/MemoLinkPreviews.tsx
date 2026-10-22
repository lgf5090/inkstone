import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ExternalLink } from 'lucide-react'
import type { MemoLinkMetadata } from '@shared/memos/types'
import { Skeleton } from '../../../components/feedback'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { memoIsAbortError } from '../errors'
import { fetchMemoLinkMetadata } from '../link-meta-client'
import { extractMemoLinkUrls, parseMemoHttpUrl } from '../link-urls'

interface PreviewState {
  key: string
  status: 'loading' | 'ready' | 'error'
  items: MemoLinkMetadata[]
}

export interface MemoLinkPreviewsProps {
  content: string
  enabled?: boolean
  excludeUrls?: readonly string[]
  compact?: boolean
  className?: string
}

function safeHref(value: string): string | null {
  const parsed = parseMemoHttpUrl(value)
  if (!parsed || parsed.username || parsed.password) return null
  return parsed.href
}

function safeImageUrl(value: string): string | null {
  const href = safeHref(value)
  return href !== null && href.startsWith('https:') ? href : null
}

function domainOf(url: string): string {
  const parsed = parseMemoHttpUrl(url)
  return parsed ? parsed.hostname.replace(/^www\./i, '') : url
}

function hasMetadata(item: MemoLinkMetadata | undefined): item is MemoLinkMetadata {
  return item !== undefined
    && (item.title.trim() !== '' || item.description.trim() !== '' || safeImageUrl(item.image) !== null)
}

function PlainLink({ url }: { url: string }): ReactElement {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-8 max-w-full min-w-0 items-center gap-1 rounded-[var(--r-xs)] py-1 text-[length:var(--text-11)] text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    >
      <ExternalLink size={11} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{url}</span>
      <span className="sr-only">{t('memos.link_preview.new_tab')}</span>
    </a>
  )
}

function PreviewCard({
  item,
  url,
  compact,
}: {
  item: MemoLinkMetadata
  url: string
  compact: boolean
}): ReactElement {
  const href = safeHref(item.url) ?? safeHref(url)
  const image = safeImageUrl(item.image)
  const title = item.title.trim() || url
  const description = item.description.trim()
  return (
    <a
      href={href ?? url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cn(
        'flex min-h-16 min-w-0 items-stretch gap-2 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        compact ? 'p-1.5' : 'p-2',
      )}
    >
      {image ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
          className={cn(
            'shrink-0 rounded-[var(--r-xs)] object-cover',
            compact ? 'size-12' : 'size-16',
          )}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="line-clamp-2 break-words text-[length:var(--text-11-5)] font-medium leading-snug text-[var(--text-primary)]">
          {title}
        </span>
        {description ? (
          <span className="mt-0.5 line-clamp-2 break-words text-[length:var(--text-10-5)] leading-snug text-[var(--text-tertiary)]">
            {description}
          </span>
        ) : null}
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <ExternalLink size={10} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{domainOf(item.url)}</span>
          <span className="sr-only">{t('memos.link_preview.new_tab')}</span>
        </span>
      </span>
    </a>
  )
}

export function MemoLinkPreviews({
  content,
  enabled = true,
  excludeUrls,
  compact = false,
  className,
}: MemoLinkPreviewsProps): ReactElement | null {
  const excludeKey = excludeUrls?.join('\n') ?? ''
  const urls = useMemo(() => {
    const excluded = new Set<string>()
    for (const value of excludeUrls ?? []) {
      const href = safeHref(value)
      excluded.add(href ?? value)
    }
    return extractMemoLinkUrls(content).filter((url) => {
      const href = parseMemoHttpUrl(url)?.href ?? url
      return !excluded.has(url) && !excluded.has(href)
    })
  }, [content, excludeKey])
  const key = urls.join('\n')
  const [state, setState] = useState<PreviewState>({ key: '', status: 'loading', items: [] })

  useEffect(() => {
    if (!enabled || urls.length === 0) return
    const controller = new AbortController()
    setState({ key, status: 'loading', items: [] })
    fetchMemoLinkMetadata(urls, controller.signal)
      .then((items) => setState({ key, status: 'ready', items }))
      .catch((error: unknown) => {
        if (memoIsAbortError(error)) return
        setState({ key, status: 'error', items: [] })
      })
    return () => controller.abort()
  }, [enabled, key])

  if (!enabled || urls.length === 0) return null

  if (state.key !== key || state.status !== 'ready') {
    const failed = state.key === key && state.status === 'error'
    if (failed) {
      return (
        <div data-memo-link-previews="" className={cn('min-w-0', className)}>
          <ul aria-label={t('memos.feed.link_preview')} className="flex flex-col items-start gap-1">
            {urls.map((url) => (
              <li key={url} className="min-w-0 max-w-full">
                <PlainLink url={url} />
              </li>
            ))}
          </ul>
        </div>
      )
    }
    return (
      <div data-memo-link-previews="" className={cn('min-w-0', className)}>
        <p role="status" className="sr-only">{t('memos.link_preview.loading')}</p>
        <div className="grid gap-1.5 sm:grid-cols-2" aria-hidden="true">
          {urls.map((url) => (
            <Skeleton key={url} className="h-16 rounded-[var(--r-md)]" />
          ))}
        </div>
      </div>
    )
  }

  const byUrl = new Map(state.items.map((item) => [item.url, item]))
  return (
    <div data-memo-link-previews="" className={cn('min-w-0', className)}>
      <ul aria-label={t('memos.feed.link_preview')} className="grid gap-1.5 sm:grid-cols-2">
        {urls.map((url) => {
          const item = byUrl.get(url)
          return (
            <li key={url} className="min-w-0">
              {hasMetadata(item)
                ? <PreviewCard item={item} url={url} compact={compact} />
                : <PlainLink url={url} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
