import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle } from 'lucide-react'
import { MEMO_MAX_PAGE_SIZE, MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoAttachment } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Empty, Skeleton, type EmptyArt } from '../../../components/feedback'
import { Segmented } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { usePathname } from '../../../lib/app-history'
import { localeTag, t, useLocale, type MessageKey } from '../../../lib/i18n'
import { formatBytes } from '../../../lib/time'
import { useUi } from '../../../store/ui'
import { MEMO_ATTACHMENT_SCOPES, memosApi, type MemoAttachmentScope } from '../api'
import {
  attachmentScopeSearch,
  groupAttachmentsByMonth,
  readAttachmentScope,
  summarizeAttachments,
  type AttachmentLibraryTotals,
} from '../attachment-groups'
import { LibraryMediaTile, LibraryRow } from '../components/AttachmentLibraryItems'
import { MemoLightbox } from '../components/MemoLightbox'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { bump } from '../events'
import { isImageAttachment, isVideoAttachment } from '../media'
import { parseMemoPath } from '../route'
import { navigateMemoUrl, useMemoSearch } from '../url-state'

const ATTACHMENT_LIBRARY_PAGE_SIZE = 24

const SCOPE_LABEL_KEYS: Record<MemoAttachmentScope, MessageKey> = {
  all: 'memos.attachments.library.scope_all',
  media: 'memos.attachments.library.scope_media',
  audio: 'memos.attachments.library.scope_audio',
  documents: 'memos.attachments.library.scope_documents',
  unused: 'memos.attachments.library.scope_unused',
}

const SCOPE_EMPTY: Record<MemoAttachmentScope, { title: MessageKey; description: MessageKey; art: EmptyArt }> = {
  all: {
    title: 'memos.attachments.library.empty_all_title',
    description: 'memos.attachments.library.empty_all_description',
    art: 'folder',
  },
  media: {
    title: 'memos.attachments.library.empty_media_title',
    description: 'memos.attachments.library.empty_media_description',
    art: 'select',
  },
  audio: {
    title: 'memos.attachments.library.empty_audio_title',
    description: 'memos.attachments.library.empty_audio_description',
    art: 'folder',
  },
  documents: {
    title: 'memos.attachments.library.empty_documents_title',
    description: 'memos.attachments.library.empty_documents_description',
    art: 'folder',
  },
  unused: {
    title: 'memos.attachments.library.empty_unused_title',
    description: 'memos.attachments.library.empty_unused_description',
    art: 'archive',
  },
}

type LibraryStatus = 'loading' | 'ready' | 'loadingMore' | 'error'
type TotalsStatus = 'loading' | 'ready' | 'error'

function monthLabel(key: string, formatter: Intl.DateTimeFormat): string {
  const [year, month] = key.split('-').map(Number)
  if (!year || !month) return key
  return formatter.format(new Date(year, month - 1, 1))
}

export interface MemoAttachmentsPageProps {
  onOpenMemo?: (id: string) => void
}

export function MemoAttachmentsPage({ onOpenMemo }: MemoAttachmentsPageProps): ReactElement {
  const search = useMemoSearch()
  const pathname = usePathname()
  const locale = useLocale()
  const scope = readAttachmentScope(search)
  const route = parseMemoPath(pathname)
  const spaceId = route.kind === 'attachments' ? route.spaceId : null
  const headingBase = useId()
  const toast = useUi((state) => state.toast)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [items, setItems] = useState<MemoAttachment[]>([])
  const [loadedScope, setLoadedScope] = useState<MemoAttachmentScope | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<LibraryStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [totals, setTotals] = useState<AttachmentLibraryTotals | null>(null)
  const [totalsStatus, setTotalsStatus] = useState<TotalsStatus>('loading')
  const [totalsKey, setTotalsKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(localeTag(), { year: 'numeric', month: 'long' }),
    [locale],
  )

  useEffect(() => {
    const controller = new AbortController()
    setLoadedScope(null)
    setItems([])
    setCursor(null)
    setStatus('loading')
    setError(null)
    setLightboxIndex(null)
    memosApi.attachments.list({ scope, limit: ATTACHMENT_LIBRARY_PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setItems(page.items)
        setLoadedScope(scope)
        setCursor(page.nextCursor)
        setStatus('ready')
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(loadError)) return
        setLoadedScope(scope)
        setStatus('error')
        setError(memoErrorMessage(loadError))
      })
    return () => controller.abort()
  }, [scope, reloadKey])

  useEffect(() => {
    const controller = new AbortController()
    setTotalsStatus('loading')
    void loadAllAttachments(controller.signal)
      .then((all) => {
        if (controller.signal.aborted) return
        setTotals(summarizeAttachments(all))
        setTotalsStatus('ready')
      })
      .catch((totalsError: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(totalsError)) return
        setTotalsStatus('error')
      })
    return () => controller.abort()
  }, [totalsKey])

  const groups = useMemo(() => groupAttachmentsByMonth(items), [items])
  const images = useMemo(() => items.filter(isImageAttachment), [items])
  const openMemo = (id: string): void => {
    if (onOpenMemo) {
      onOpenMemo(id)
      return
    }
    navigateMemoUrl(`${MEMOS_APP_PATH}/m/${encodeURIComponent(id)}`, window.location.search)
  }

  const changeScope = (next: MemoAttachmentScope): void => {
    navigateMemoUrl(pathname, attachmentScopeSearch(search, next))
  }

  const loadMore = async (): Promise<void> => {
    if (!cursor || status !== 'ready' || busy) return
    const requestedScope = scope
    setStatus('loadingMore')
    try {
      const page = await memosApi.attachments.list({
        scope,
        cursor,
        limit: ATTACHMENT_LIBRARY_PAGE_SIZE,
      })
      if (scopeRef.current !== requestedScope) return
      setItems((current) => {
        const known = new Set(current.map((item) => item.id))
        return [...current, ...page.items.filter((item) => !known.has(item.id))]
      })
      setCursor(page.nextCursor)
      setStatus('ready')
    } catch (loadError) {
      if (memoIsAbortError(loadError) || scopeRef.current !== requestedScope) return
      setStatus('ready')
      toast({
        title: t('memos.attachments.library.load_more_failed'),
        description: memoErrorMessage(loadError),
        tone: 'danger',
      })
    }
  }

  const openImage = (attachment: MemoAttachment): void => {
    const index = images.findIndex((image) => image.id === attachment.id)
    if (index >= 0) setLightboxIndex(index)
  }

  const deleteAttachment = async (attachment: MemoAttachment): Promise<void> => {
    if (busy) return
    const agreed = await confirm({
      title: t('memos.attachments.library.delete_confirm_title', { name: attachment.filename }),
      description: t('memos.attachments.library.delete_confirm_description'),
      confirmLabel: t('memos.attachments.library.delete_action'),
      tone: 'danger',
    })
    if (!agreed) return
    setBusy(true)
    try {
      await memosApi.attachments.delete(attachment.id)
      setReloadKey((value) => value + 1)
      setTotalsKey((value) => value + 1)
      bump('attachments')
      bump('list')
      bump('detail')
      toast({ title: t('memos.attachments.library.deleted'), tone: 'success' })
    } catch (deleteError) {
      toast({
        title: t('memos.attachments.library.delete_failed'),
        description: memoErrorMessage(deleteError),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const pruneUnused = async (): Promise<void> => {
    if (busy || totalsStatus !== 'ready' || !totals) return
    const agreed = await confirm({
      title: t('memos.attachments.library.prune_confirm_title'),
      description: t('memos.attachments.library.prune_confirm_description', {
        count: totals.counts.unused,
        size: formatBytes(totals.unusedBytes),
      }),
      confirmLabel: t('memos.attachments.library.prune_confirm_label'),
      tone: 'danger',
    })
    if (!agreed) return
    setBusy(true)
    try {
      const result = await memosApi.attachments.prune()
      setReloadKey((value) => value + 1)
      setTotalsKey((value) => value + 1)
      bump('attachments')
      toast(result.removed > 0
        ? {
            title: t('memos.attachments.library.pruned'),
            description: t('memos.attachments.library.pruned_description', {
              count: result.removed,
              size: formatBytes(result.freedBytes),
            }),
            tone: 'success',
          }
        : { title: t('memos.attachments.library.nothing_to_delete'), tone: 'success' })
    } catch (pruneError) {
      toast({
        title: t('memos.attachments.library.prune_failed'),
        description: memoErrorMessage(pruneError),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const totalCount = totalsStatus === 'ready' && totals ? totals.counts.all : null
  const scopeSettled = loadedScope === scope
  const initialLoading = !scopeSettled || (status === 'loading' && items.length === 0)
  const empty = SCOPE_EMPTY[scope]
  const scopeOptions = MEMO_ATTACHMENT_SCOPES.map((value) => {
    const label = t(SCOPE_LABEL_KEYS[value])
    const count = totalsStatus === 'ready' && totals ? totals.counts[value] : null
    return {
      value,
      label: (
        <span className="inline-flex items-center gap-1">
          <span>{label}</span>
          {count !== null ? (
            <span className="text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{count}</span>
          ) : null}
        </span>
      ),
      title: count === null
        ? label
        : t(count === 1 ? 'memos.attachments.library.scope_option_one' : 'memos.attachments.library.scope_option', {
            label,
            count,
          }),
    }
  })

  const renderMonthly = scope === 'media' || scope === 'all' || scope === 'unused'
  return (
    <div className="flex h-full min-h-0 flex-col" data-memos-attachments="">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1100px] px-3 py-3 md:px-5 md:py-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="min-w-0 truncate text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
              {t('memos.nav.attachments')}
            </h2>
            {totalCount !== null ? (
              <p role="status" aria-live="polite" className="text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
                {t(totalCount === 1 ? 'memos.attachments.library.usage_one' : 'memos.attachments.library.usage', {
                  count: totalCount,
                  size: formatBytes(totals?.totalBytes ?? 0),
                })}
              </p>
            ) : null}
          </div>
          {spaceId ? (
            <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t('memos.attachments.library.space_notice')}
            </p>
          ) : null}
          <div className="mt-2 overflow-x-auto">
            <Segmented
              value={scope}
              onChange={changeScope}
              options={scopeOptions}
              size="sm"
              label={t('memos.attachments.library.filters')}
            />
          </div>
          {totalsStatus === 'error' ? (
            <div role="status" className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-raised)] px-2.5 py-1.5">
              <AlertTriangle size={13} aria-hidden="true" className="shrink-0 text-[var(--warning)]" />
              <span className="min-w-0 flex-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {t('memos.attachments.library.counts_failed')}
              </span>
              <Button size="sm" variant="ghost" className="h-7 shrink-0 px-1.5" onClick={() => setTotalsKey((value) => value + 1)}>
                {t('memos.common.retry')}
              </Button>
            </div>
          ) : null}
          {scope === 'unused' && totalsStatus === 'ready' && totals && totals.counts.unused > 0 ? (
            <div
              role="status"
              className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-2.5 py-2"
            >
              <AlertTriangle size={14} aria-hidden="true" className="shrink-0 text-[var(--warning)]" />
              <p className="min-w-0 flex-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]">
                {t('memos.attachments.library.unused_warning', { size: formatBytes(totals.unusedBytes) })}
              </p>
              <Button
                size="sm"
                variant="danger"
                loading={busy}
                disabled={busy}
                onClick={() => void pruneUnused()}
              >
                {t('memos.attachments.library.prune')}
              </Button>
            </div>
          ) : null}
          {initialLoading ? (
            <>
              <p role="status" aria-live="polite" className="sr-only">{t('memos.common.loading')}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="aspect-[4/3] rounded-[var(--r-md)]" />
                ))}
              </div>
            </>
          ) : null}
          {scopeSettled && status === 'error' && items.length === 0 ? (
            <Empty
              art="folder"
              title={t('memos.attachments.library.error_title')}
              description={error ?? t('memos.feed.error_description')}
              action={(
                <Button size="sm" onClick={() => setReloadKey((value) => value + 1)}>
                  {t('memos.common.retry')}
                </Button>
              )}
            />
          ) : null}
          {scopeSettled && status === 'ready' && items.length === 0 ? (
            <Empty art={empty.art} title={t(empty.title)} description={t(empty.description)} />
          ) : null}
          {scopeSettled && renderMonthly ? (
            groups.map((group) => {
              const media = group.items.filter((item) => isImageAttachment(item) || isVideoAttachment(item))
              const files = group.items.filter((item) => !isImageAttachment(item) && !isVideoAttachment(item))
              const headingId = `${headingBase}-${group.key}`
              return (
                <section
                  key={group.key}
                  aria-labelledby={headingId}
                  data-attachment-month={group.key}
                  className="mt-4"
                >
                  <h3 id={headingId} className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
                    {monthLabel(group.key, monthFormatter)}
                  </h3>
                  {media.length > 0 ? (
                    <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                      {media.map((attachment) => (
                        <li key={attachment.id} className="min-w-0">
                          <LibraryMediaTile
                            attachment={attachment}
                            busy={busy}
                            onOpenImage={openImage}
                            onDelete={(item) => void deleteAttachment(item)}
                            onOpenMemo={openMemo}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {files.length > 0 ? (
                    <ul className="mt-2 space-y-1.5">
                      {files.map((attachment) => (
                        <LibraryRow
                          key={attachment.id}
                          attachment={attachment}
                          busy={busy}
                          onDelete={(item) => void deleteAttachment(item)}
                          onOpenMemo={openMemo}
                        />
                      ))}
                    </ul>
                  ) : null}
                </section>
              )
            })
          ) : scopeSettled && items.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {items.map((attachment) => (
                <LibraryRow
                  key={attachment.id}
                  attachment={attachment}
                  busy={busy}
                  onDelete={(item) => void deleteAttachment(item)}
                  onOpenMemo={openMemo}
                />
              ))}
            </ul>
          ) : null}
          {scopeSettled && cursor ? (
            <div className="mt-4 flex justify-center">
              <Button
                size="sm"
                variant="secondary"
                loading={status === 'loadingMore'}
                disabled={busy}
                onClick={() => void loadMore()}
              >
                {status === 'loadingMore' ? t('memos.feed.loading_more') : t('memos.feed.load_more')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <MemoLightbox
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </div>
  )
}

async function loadAllAttachments(signal: AbortSignal): Promise<MemoAttachment[]> {
  const all: MemoAttachment[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page = await memosApi.attachments.list({ cursor, limit: MEMO_MAX_PAGE_SIZE }, signal)
    for (const item of page.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      all.push(item)
    }
    cursor = page.nextCursor
  } while (cursor && !signal.aborted)
  return all
}
