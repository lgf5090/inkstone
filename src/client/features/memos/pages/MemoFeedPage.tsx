import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Memo, MemoDisplayPreferences, MemoOrderDirection, MemoOrderField } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Empty, Skeleton } from '../../../components/feedback'
import { TagChip } from '../../../components/TagChip'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { suggestMemoTags } from '../tag-suggestions'
import { useMemos } from '../state'
import { useMemoPreferences } from '../use-memo-preferences'
import type { MemoUrlState } from '../url-state'
import { MemoCard } from '../components/MemoCard'
import { MemoComposer } from '../components/MemoComposer'
import { MemoFilters } from '../components/MemoFilters'

const GRID_CLASS: Record<MemoDisplayPreferences['columns'], string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3',
  auto: 'grid-cols-1 md:grid-cols-2 2xl:grid-cols-3',
}

export interface MemoFeedPageProps {
  kind: 'home' | 'archived'
  spaceId: string | null
  spaceTitles: ReadonlyMap<string, string>
  newMemoId: string | null
  display: MemoDisplayPreferences
  urlState: MemoUrlState
  onCreated: (memo: Memo) => void
  onOpen: (id: string) => void
  onTagPress: (tag: string) => void
  onSearch: (value: string) => void
  onRemoveTag: () => void
  onRemoveFilter: () => void
  onClearFilters: () => void
  onSortChange: (orderBy: MemoOrderField, order: MemoOrderDirection) => void
  onDisplayChange: (patch: Partial<Pick<MemoDisplayPreferences, 'columns' | 'compact' | 'linkPreview'>>) => void
}

export function MemoFeedPage({
  kind,
  spaceId,
  spaceTitles,
  newMemoId,
  display,
  urlState,
  onCreated,
  onOpen,
  onTagPress,
  onSearch,
  onRemoveTag,
  onRemoveFilter,
  onClearFilters,
  onSortChange,
  onDisplayChange,
}: MemoFeedPageProps): ReactElement {
  const items = useMemos((state) => state.items)
  const status = useMemos((state) => state.status)
  const error = useMemos((state) => state.error)
  const hasMore = useMemos((state) => state.hasMore)
  const [editingId, setEditingId] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const preferences = useMemoPreferences()
  const suggestedTags = useMemo(() => suggestMemoTags(items, urlState.tag), [items, urlState.tag])
  const initialLoading = (status === 'idle' || status === 'loading') && items.length === 0
  const failedWithoutItems = status === 'error' && items.length === 0
  const filtered = urlState.q.trim() !== '' || urlState.tag !== null || urlState.filter.trim() !== ''
  const title = kind === 'archived'
    ? t('memos.nav.archived')
    : spaceId
      ? spaceTitles.get(spaceId) ?? t('memos.feed.space_fallback')
      : t('memos.nav.home')
  const countLabel = t(items.length === 1 ? 'memos.feed.count_one' : 'memos.feed.count', { count: items.length })

  useEffect(() => {
    if (editingId && !items.some((memo) => memo.id === editingId)) setEditingId(null)
  }, [editingId, items])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !hasMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && useMemos.getState().status === 'ready') {
        void useMemos.getState().loadMore()
      }
    }, { rootMargin: '400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, items.length])

  return (
    <div className="flex h-full min-h-0 flex-col" data-memos-feed={kind}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1200px] px-3 py-3 md:px-5 md:py-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="min-w-0 truncate text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{title}</h2>
            {!initialLoading ? (
              <span role="status" aria-live="polite" className="text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
                {countLabel}
              </span>
            ) : null}
          </div>
          {kind === 'home' ? (
            <div className="mt-2.5">
              <MemoComposer
                spaceId={spaceId}
                onSaved={(saved) => {
                  setEditingId(null)
                  onCreated(saved)
                }}
              />
            </div>
          ) : null}
          <div className="mt-3">
            <MemoFilters
              query={urlState}
              display={display}
              onSearch={onSearch}
              onRemoveTag={onRemoveTag}
              onRemoveFilter={onRemoveFilter}
              onClear={onClearFilters}
              onSortChange={onSortChange}
              onDisplayChange={onDisplayChange}
            />
          </div>
          {suggestedTags.length > 0 ? (
            <div role="group" aria-label={t('memos.feed.suggested_tags')} className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('memos.feed.suggested_tags')}
              </span>
              {suggestedTags.map((tag) => (
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
          {initialLoading ? (
            <>
              <p role="status" aria-live="polite" className="sr-only">{t('memos.common.loading')}</p>
              <div className={cn('mt-3 grid gap-3', GRID_CLASS[display.columns])} aria-hidden="true">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-40 rounded-[var(--r-lg)]" />
                ))}
              </div>
            </>
          ) : null}
          {failedWithoutItems ? (
            <Empty
              art="notes"
              title={t('memos.feed.error_title')}
              description={error ?? t('memos.feed.error_description')}
              action={(
                <Button size="sm" onClick={() => void useMemos.getState().refresh()}>
                  {t('memos.common.retry')}
                </Button>
              )}
            />
          ) : null}
          {status === 'ready' && items.length === 0 ? (
            kind === 'archived' ? (
              <Empty
                art="archive"
                title={t('memos.feed.archived_empty_title')}
                description={t('memos.feed.archived_empty_description')}
              />
            ) : filtered ? (
              <Empty
                art="search"
                title={t('memos.feed.empty_filtered_title')}
                description={t('memos.feed.empty_filtered_description')}
                action={(
                  <Button size="sm" onClick={onClearFilters}>
                    {t('memos.feed.clear_filters')}
                  </Button>
                )}
              />
            ) : (
              <Empty
                art="notes"
                title={t('memos.feed.empty_title')}
                description={t('memos.feed.empty_description')}
              />
            )
          ) : null}
          {status === 'error' && items.length > 0 ? (
            <div role="alert" className="mt-3 flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--danger-soft)] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--danger)]">
                {error ?? t('memos.feed.error_description')}
              </span>
              <Button size="sm" variant="ghost" className="h-7 shrink-0 px-1.5" onClick={() => void useMemos.getState().refresh()}>
                {t('memos.common.retry')}
              </Button>
            </div>
          ) : null}
          {items.length > 0 ? (
            <div className={cn('mt-3 grid items-start gap-3', GRID_CLASS[display.columns])}>
              {items.map((memo) => (
                <MemoCard
                  key={memo.id}
                  memo={memo}
                  spaceName={memo.spaceId ? spaceTitles.get(memo.spaceId) ?? null : null}
                  isNew={memo.id === newMemoId}
                  compact={display.compact}
                  timeBasis={display.timeBasis}
                  editing={editingId === memo.id}
                  tagRules={preferences.preferences.tagRules}
                  reactionOptions={preferences.preferences.reactions}
                  doubleClickEdit={preferences.preferences.enableDoubleClickEdit}
                  onOpen={onOpen}
                  onStartEdit={() => setEditingId(memo.id)}
                  onEndEdit={() => setEditingId(null)}
                  onTagPress={onTagPress}
                />
              ))}
            </div>
          ) : null}
          {hasMore ? (
            <div ref={sentinelRef} className="flex justify-center py-4">
              <Button
                size="sm"
                variant="secondary"
                loading={status === 'loadingMore'}
                onClick={() => void useMemos.getState().loadMore()}
              >
                {status === 'loadingMore' ? t('memos.feed.loading_more') : t('memos.feed.load_more')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
