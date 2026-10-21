import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Menu as MenuIcon, Plus, RefreshCw, StickyNote } from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import { MEMOS_MESSAGE_KEYS } from '@shared/memos/keys'
import type { Memo, MemoDisplayPreferences, MemoState } from '@shared/memos/types'
import { IconButton } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { useBreakpoint } from '../../lib/hooks'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { t, type MessageKey } from '../../lib/i18n'
import { MemoDetail } from './components/MemoDetail'
import { useRevision } from './events'
import { MemoFeedPage } from './pages/MemoFeedPage'
import { MemoAttachmentsPage } from './pages/MemoAttachmentsPage'
import { MemoPlaceholderPage } from './pages/MemoPlaceholderPage'
import { MemoViewsPage } from './pages/MemoViewsPage'
import { parseMemoPath, type MemoRoute } from './route'
import { MemoSidebar } from './sidebar/MemoSidebar'
import {
  loadMemoDisplayPrefs,
  saveMemoDisplayPrefs,
  useMemoSync,
  useMemos,
  type MemoQuery,
} from './state'
import { useMemoSpaces } from './use-memo-spaces'
import {
  buildMemoSearch,
  memoFilterExpression,
  navigateMemoUrl,
  readMemoUrlState,
  useMemoSearch,
  type MemoUrlState,
} from './url-state'

const SECTION_KEYS: Partial<Record<MemoRoute['kind'], MessageKey>> = {
  home: 'memos.nav.home',
  explore: 'memos.nav.explore',
  archived: 'memos.nav.archived',
  calendar: 'memos.nav.calendar',
  attachments: 'memos.nav.attachments',
  map: 'memos.nav.map',
  views: 'memos.nav.views',
  inbox: 'memos.nav.inbox',
  setting: 'memos.nav.settings',
  memo: 'memos.detail.title',
}

function sameDisplay(first: MemoDisplayPreferences, second: MemoDisplayPreferences): boolean {
  return first.columns === second.columns
    && first.compact === second.compact
    && first.linkPreview === second.linkPreview
    && first.timeBasis === second.timeBasis
    && first.order === second.order
}

function displayFromUrl(base: MemoDisplayPreferences, url: MemoUrlState): MemoDisplayPreferences {
  return {
    columns: url.columns ?? base.columns,
    compact: url.compact ?? base.compact,
    linkPreview: url.linkPreview ?? base.linkPreview,
    timeBasis: url.orderBy ?? base.timeBasis,
    order: url.order ?? base.order,
  }
}

function sameQuery(current: MemoQuery, next: MemoQuery): boolean {
  return current.state === next.state
    && current.spaceId === next.spaceId
    && current.tag === next.tag
    && current.filter === next.filter
    && current.orderBy === next.orderBy
    && current.order === next.order
}

function initialDisplay(): MemoDisplayPreferences {
  const search = typeof window === 'undefined' ? '' : window.location.search
  return displayFromUrl(loadMemoDisplayPrefs(), readMemoUrlState(search))
}

export function MemosApp(): ReactElement {
  useMemoSync()
  const pathname = usePathname()
  const search = useMemoSearch()
  const urlState = useMemo(() => readMemoUrlState(search), [search])
  const route = parseMemoPath(pathname)
  const desktop = useBreakpoint() === 'desktop'
  const [display, setDisplay] = useState<MemoDisplayPreferences>(initialDisplay)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [newMemoId, setNewMemoId] = useState<string | null>(null)
  const spaces = useMemoSpaces()
  const listRevision = useRevision('list')
  const detail = useMemos((state) => state.detail)
  const detailReturnRef = useRef<{ pathname: string; search: string } | null>(null)
  const revisionRef = useRef(listRevision)
  const spaceTitles = useMemo(
    () => new Map((spaces.data ?? []).map((space) => [space.id, space.title])),
    [spaces.data],
  )

  useEffect(() => {
    setDisplay((current) => {
      const next = displayFromUrl(loadMemoDisplayPrefs(), urlState)
      return sameDisplay(current, next) ? current : next
    })
  }, [urlState])

  const feedState: MemoState = route.kind === 'archived' ? 'archived' : 'normal'
  const routeSpaceId = route.kind === 'space' ? route.spaceId : null
  const feedActive = route.kind === 'home'
    || route.kind === 'archived'
    || route.kind === 'space'
    || (route.kind === 'memo' && desktop)
  const desiredQuery: MemoQuery = {
    state: feedState,
    spaceId: routeSpaceId ?? urlState.spaceId,
    tag: urlState.tag,
    filter: memoFilterExpression(urlState.q, urlState.filter),
    orderBy: display.timeBasis,
    order: display.order,
  }
  const desiredKey = JSON.stringify(desiredQuery)

  useEffect(() => {
    if (!feedActive) return
    const state = useMemos.getState()
    if (!sameQuery(state.query, desiredQuery)) {
      state.setQuery(desiredQuery)
      void state.load()
      return
    }
    if (state.status === 'idle') void state.load()
  }, [feedActive, desiredKey])

  useEffect(() => {
    if (!feedActive || revisionRef.current === listRevision) return
    revisionRef.current = listRevision
    if (useMemos.getState().status !== 'idle') void useMemos.getState().refresh()
  }, [feedActive, listRevision])

  const applyDisplay = (next: MemoDisplayPreferences, push: boolean): void => {
    setDisplay(next)
    saveMemoDisplayPrefs(next)
    const nextSearch = buildMemoSearch({
      q: urlState.q,
      tag: urlState.tag,
      filter: urlState.filter,
      spaceId: urlState.spaceId,
      orderBy: next.timeBasis,
      order: next.order,
      display: next,
    })
    navigateMemoUrl(pathname, nextSearch, { replace: !push })
  }

  const updateSearch = (patch: Partial<MemoUrlState>): void => {
    const next = { ...urlState, ...patch }
    navigateMemoUrl(pathname, buildMemoSearch({
      q: next.q,
      tag: next.tag,
      filter: next.filter,
      spaceId: next.spaceId,
      orderBy: display.timeBasis,
      order: display.order,
      display,
    }))
  }

  const openMemo = (id: string): void => {
    if (route.kind !== 'memo') {
      detailReturnRef.current = { pathname, search: window.location.search }
    }
    navigateMemoUrl(`${MEMOS_APP_PATH}/m/${encodeURIComponent(id)}`, window.location.search)
  }

  const closeDetail = (): void => {
    const back = detailReturnRef.current ?? { pathname: MEMOS_APP_PATH, search: '' }
    detailReturnRef.current = null
    navigateMemoUrl(back.pathname, back.search)
  }

  const openTag = (tag: string): void => {
    navigateMemoUrl(MEMOS_APP_PATH, buildMemoSearch({
      tag,
      orderBy: display.timeBasis,
      order: display.order,
      display,
    }))
  }

  const missingSpace = route.kind === 'space' && spaces.status === 'ready' && !spaceTitles.has(route.spaceId)
  const detailId = route.kind === 'memo' ? route.id : null
  const detailSpaceName = detail && detailId && detail.id === detailId && detail.spaceId
    ? spaceTitles.get(detail.spaceId) ?? null
    : null
  const sectionKey = route.kind === 'space' ? null : SECTION_KEYS[route.kind] ?? null
  const sectionLabel = route.kind === 'space'
    ? spaceTitles.get(route.spaceId) ?? t('memos.nav.spaces')
    : sectionKey
      ? t(sectionKey)
      : null

  const sidebar = (
    <MemoSidebar
      pathname={pathname}
      search={search}
      spaces={spaces.data ?? []}
      spacesStatus={spaces.status}
      spacesError={spaces.error}
      onRetrySpaces={spaces.reload}
      onNavigate={() => setSidebarOpen(false)}
    />
  )

  const feed = (
    <MemoFeedPage
      kind={route.kind === 'archived' ? 'archived' : 'home'}
      spaceId={routeSpaceId}
      spaceTitles={spaceTitles}
      newMemoId={newMemoId}
      display={display}
      urlState={urlState}
      onCreated={(memo: Memo) => setNewMemoId(memo.id)}
      onOpen={openMemo}
      onTagPress={openTag}
      onSearch={(q) => updateSearch({ q })}
      onRemoveTag={() => updateSearch({ tag: null })}
      onRemoveFilter={() => updateSearch({ filter: '' })}
      onClearFilters={() => updateSearch({ q: '', tag: null, filter: '' })}
      onSortChange={(orderBy, order) => applyDisplay({ ...display, timeBasis: orderBy, order }, true)}
      onDisplayChange={(patch) => applyDisplay({ ...display, ...patch }, false)}
    />
  )

  let content: ReactElement
  if (route.kind === 'home' || route.kind === 'archived' || route.kind === 'space') {
    content = missingSpace ? <MemoPlaceholderPage kind="spaceMissing" /> : feed
  } else if (route.kind === 'memo') {
    content = desktop ? feed : (
      <MemoDetail
        memoId={route.id}
        spaceName={detailSpaceName}
        isNew={newMemoId === route.id}
        onClose={closeDetail}
        onOpen={openMemo}
        onTagPress={openTag}
      />
    )
  } else if (route.kind === 'views') {
    content = <MemoViewsPage />
  } else if (route.kind === 'attachments') {
    content = <MemoAttachmentsPage onOpenMemo={openMemo} />
  } else if (route.kind === 'calendar' || route.kind === 'map'
    || route.kind === 'inbox' || route.kind === 'setting' || route.kind === 'explore') {
    content = <MemoPlaceholderPage kind={route.kind} />
  } else {
    content = <MemoPlaceholderPage kind="notFound" />
  }

  const showRefresh = route.kind === 'home' || route.kind === 'archived' || route.kind === 'space' || route.kind === 'memo'

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-memos-app="">
      <header
        data-print="hide"
        className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2"
      >
        {!desktop ? (
          <IconButton label={t('memos.header.open_sidebar')} size="sm" onClick={() => setSidebarOpen(true)}>
            <MenuIcon size={16} />
          </IconButton>
        ) : null}
        <StickyNote size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <h1 className="min-w-0 shrink-0 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
          {t(MEMOS_MESSAGE_KEYS.appTab)}
        </h1>
        {sectionLabel ? (
          <span className="hidden min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)] sm:inline">
            {sectionLabel}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {showRefresh ? (
            <IconButton
              label={t('memos.header.refresh')}
              size="sm"
              onClick={() => {
                if (route.kind === 'memo') {
                  void useMemos.getState().openDetail(route.id)
                  return
                }
                void useMemos.getState().refresh()
              }}
            >
              <RefreshCw size={14} />
            </IconButton>
          ) : null}
          {route.kind !== 'home' && route.kind !== 'space' ? (
            <IconButton
              label={t('memos.header.new')}
              size="sm"
              onClick={() => navigateToPath(MEMOS_APP_PATH)}
            >
              <Plus size={16} />
            </IconButton>
          ) : null}
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {desktop ? (
          <aside className="w-[248px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            {sidebar}
          </aside>
        ) : null}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-memos-page={route.kind}>
          {content}
        </main>
        {desktop && route.kind === 'memo' ? (
          <aside
            className="w-[400px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-surface)]"
            aria-label={t('memos.detail.title')}
            data-memos-detail-panel=""
          >
            <MemoDetail
              memoId={route.id}
              spaceName={detailSpaceName}
              isNew={newMemoId === route.id}
              embedded
              onClose={closeDetail}
              onOpen={openMemo}
              onTagPress={openTag}
            />
          </aside>
        ) : null}
      </div>
      {!desktop ? (
        <Drawer
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          side="left"
          width={280}
          ariaLabel={t('memos.sidebar.product')}
        >
          {sidebar}
        </Drawer>
      ) : null}
    </section>
  )
}
