import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { MapPin, X } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { Button, IconButton } from '../../../components/primitives'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { InlineErrorBoundary } from '../../../components/ErrorBoundary'
import { usePathname } from '../../../lib/app-history'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { coordinateLabel, memoPlaceLabel, normalizeMemoLocation } from '../location'
import {
  MEMO_MAP_FETCH_LIMIT,
  MEMO_MAP_FOCUS_ZOOM,
  MEMO_MAP_MAX_MEMOS,
  buildMemoMapGroups,
  clearMemoMapFilters,
  collectMemoMapMemos,
  hasMemoMapFilters,
  memoMapFilter,
  memoMapGroupContaining,
  readMemoMapUrl,
  updateMemoMapSearch,
  type MemoMapPointSelection,
  type MemoMapView,
} from '../map-state'
import { parseMemoPath } from '../route'
import { navigateMemoUrl, useMemoSearch } from '../url-state'

const MemoMap = lazy(() =>
  import('../components/MemoMap').then((module) => ({ default: module.MemoMap })))

type MemoMapStatus = 'loading' | 'ready' | 'error'

interface MemoMapEntryProps {
  memo: Memo
  onOpen?: (id: string) => void
}

function MemoMapEntry({ memo, onOpen }: MemoMapEntryProps): ReactElement | null {
  const location = normalizeMemoLocation(memo.location)
  if (!location) return null
  const place = memoPlaceLabel(location)
  const title = memo.title.trim() || memo.snippet.trim()
    || t('memos.attachments.library.source_memo_untitled')
  const href = `${MEMOS_APP_PATH}/m/${encodeURIComponent(memo.id)}`
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!onOpen || event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen(memo.id)
  }
  return (
    <li>
      <a
        href={href}
        onClick={onLinkClick}
        className="flex min-h-11 flex-col gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <MapPin size={12} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
          <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
            {place}
          </span>
        </span>
        <span className="truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{title}</span>
        <span className="tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <span className="sr-only">{t('memos.map.coordinates_label')}: </span>
          {coordinateLabel(location.latitude, location.longitude)}
        </span>
      </a>
    </li>
  )
}

export interface MemoMapPageProps {
  onOpenMemo?: (id: string) => void
}

export function MemoMapPage({ onOpenMemo }: MemoMapPageProps): ReactElement {
  const pathname = usePathname()
  const search = useMemoSearch()
  const route = parseMemoPath(pathname)
  const spaceId = route.kind === 'map' ? route.spaceId : null
  const urlState = useMemo(() => readMemoMapUrl(search), [search])
  const filter = useMemo(() => memoMapFilter(search), [search])
  const filtersActive = hasMemoMapFilters(search)
  const [items, setItems] = useState<Memo[]>([])
  const [status, setStatus] = useState<MemoMapStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [capped, setCapped] = useState(false)
  const [selection, setSelection] = useState<MemoMapPointSelection | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const memoParamRef = useRef(urlState.memoId)
  memoParamRef.current = urlState.memoId
  const initialMemoRef = useRef(urlState.memoId)
  const initialSelectionDone = useRef(false)
  const listHeadingId = useId()
  const groups = useMemo(() => buildMemoMapGroups(items), [items])
  const memoById = useMemo(() => new Map(items.map((memo) => [memo.id, memo])), [items])
  const selectedMemos = useMemo(
    () => (selection ? selection.memoIds.flatMap((id) => {
      const memo = memoById.get(id)
      return memo ? [memo] : []
    }) : []),
    [memoById, selection],
  )
  const focusMemo = useMemo(
    () => (urlState.memoId ? memoById.get(urlState.memoId) ?? null : null),
    [memoById, urlState.memoId],
  )
  const initialView = useMemo<MemoMapView | null>(() => {
    if (urlState.view) return urlState.view
    if (!focusMemo) return null
    const location = normalizeMemoLocation(focusMemo.location)
    if (!location) return null
    return { latitude: location.latitude, longitude: location.longitude, zoom: MEMO_MAP_FOCUS_ZOOM }
  }, [focusMemo, urlState.view])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setStatus('loading')
    setError(null)
    setItems([])
    setCapped(false)
    setSelection(null)
    initialMemoRef.current = memoParamRef.current
    initialSelectionDone.current = false
    collectMemoMapMemos((cursor) => memosApi.list({
      spaceId: spaceId ?? undefined,
      filter,
      limit: MEMO_MAP_FETCH_LIMIT,
      cursor,
    }, controller.signal))
      .then((result) => {
        if (!active) return
        setItems(result.memos)
        setCapped(result.capped)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!active || memoIsAbortError(reason)) return
        setStatus('error')
        setError(memoErrorMessage(reason))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [filter, refreshKey, spaceId])

  useEffect(() => {
    if (status !== 'ready' || initialSelectionDone.current) return
    initialSelectionDone.current = true
    const memoId = initialMemoRef.current
    if (!memoId) return
    const group = memoMapGroupContaining(groups, memoId)
    if (!group) {
      navigateMemoUrl(pathname, updateMemoMapSearch(search, { memoId: null }), { replace: true })
      return
    }
    setSelection({
      latitude: group.latitude,
      longitude: group.longitude,
      memoIds: [...group.memoIds],
    })
  }, [groups, pathname, search, status])

  const writeMemoSelection = (memoId: string | null): void => {
    navigateMemoUrl(pathname, updateMemoMapSearch(search, { memoId }), { replace: true })
  }

  const selectPoint = (point: MemoMapPointSelection): void => {
    setSelection(point)
    writeMemoSelection(point.memoIds.length === 1 ? point.memoIds[0] : null)
  }

  const clearSelection = (): void => {
    setSelection(null)
    writeMemoSelection(null)
  }

  const updateView = (view: MemoMapView): void => {
    navigateMemoUrl(pathname, updateMemoMapSearch(search, { view }), { replace: true })
  }

  const clearFilters = (): void => {
    const next = updateMemoMapSearch(clearMemoMapFilters(search), { memoId: null })
    setSelection(null)
    navigateMemoUrl(pathname, next)
  }

  let body: ReactElement
  if (status === 'loading') {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LoadingBlock label={t('memos.common.loading')} />
      </div>
    )
  } else if (status === 'error') {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Empty
          art="notes"
          title={t('memos.feed.error_title')}
          description={error ?? t('memos.feed.error_description')}
          action={(
            <Button size="sm" onClick={() => setRefreshKey((value) => value + 1)}>
              {t('memos.common.retry')}
            </Button>
          )}
        />
      </div>
    )
  } else if (items.length === 0) {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Empty
          art={filtersActive ? 'search' : 'select'}
          title={t(filtersActive ? 'memos.map.empty_filtered_title' : 'memos.map.empty_title')}
          description={t(filtersActive
            ? 'memos.map.empty_filtered_description'
            : 'memos.map.empty_description')}
          action={filtersActive ? (
            <Button size="sm" onClick={clearFilters}>
              {t('memos.map.clear_filters')}
            </Button>
          ) : undefined}
        />
      </div>
    )
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative min-h-80 flex-1 lg:min-h-0">
          <InlineErrorBoundary label={t('memos.map.unavailable')}>
            <Suspense fallback={<LoadingBlock label={t('memos.common.loading')} />}>
              <MemoMap
                groups={groups}
                initialView={initialView}
                label={t('memos.map.region')}
                onSelect={selectPoint}
                onBlankClick={clearSelection}
                onViewChange={updateView}
              />
            </Suspense>
          </InlineErrorBoundary>
        </div>
        <aside
          aria-labelledby={listHeadingId}
          className="flex max-h-[45vh] w-full shrink-0 flex-col border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] lg:max-h-none lg:w-80 lg:border-l lg:border-t-0"
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {selection ? (
              <section className="mb-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                      {t('memos.map.selected_location')}
                    </h3>
                    <p className="tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {coordinateLabel(selection.latitude, selection.longitude)}
                    </p>
                  </div>
                  <IconButton label={t('memos.map.clear_selection')} size="xs" onClick={clearSelection}>
                    <X size={13} aria-hidden="true" />
                  </IconButton>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {selectedMemos.map((memo) => (
                    <MemoMapEntry key={memo.id} memo={memo} onOpen={onOpenMemo} />
                  ))}
                </ul>
              </section>
            ) : null}
            <h3
              id={listHeadingId}
              className="px-2 pb-1 text-[length:var(--text-11)] font-medium tracking-wide text-[var(--text-tertiary)] uppercase"
            >
              {t('memos.map.all_locations')}
            </h3>
            <ul className="space-y-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_64px]">
              {items.map((memo) => (
                <MemoMapEntry key={memo.id} memo={memo} onOpen={onOpenMemo} />
              ))}
            </ul>
          </div>
        </aside>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <h2 className="min-w-0 truncate text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
          {t('memos.nav.map')}
        </h2>
        {status === 'ready' ? (
          <span
            role="status"
            aria-live="polite"
            className="text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]"
          >
            {t(items.length === 1 ? 'memos.map.count_one' : 'memos.map.count', { count: items.length })}
          </span>
        ) : null}
        {filtersActive ? (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            {t('memos.map.clear_filters')}
          </Button>
        ) : null}
      </div>
      {capped ? (
        <p role="status" className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('memos.map.capped', { count: MEMO_MAP_MAX_MEMOS })}
        </p>
      ) : null}
      {body}
    </div>
  )
}
