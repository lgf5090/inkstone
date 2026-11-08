import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Download, Images, Loader2, Trash2, Upload } from 'lucide-react'
import type {
  IconAssetDetail,
  IconAssetSummary,
  IconBootstrap,
  IconCollection,
  IconImport,
  IconJob,
  IconLimits,
  IconSettings,
  IconTag,
  IconUsageSummary,
} from '@shared/development/icons/types'
import { ICON_ICO_PRESETS, ICON_PNG_PRESETS } from '@shared/development/icons/limits'
import { ICON_BUILTIN_LIBRARIES } from '@shared/development/icons/builtins'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useBreakpoint, useDebounced } from '../../../lib/hooks'
import { copyText } from '../../../lib/clipboard'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Input, Slider } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Drawer, Modal, confirm } from '../../../components/overlay'
import { Empty, LoadingBlock, Skeleton } from '../../../components/feedback'
import { useUi } from '../../../store/ui'
import {
  batchAssets,
  cancelJob,
  createCollection,
  createExport,
  createImport,
  createJob,
  createTag,
  deleteAsset,
  deleteCollection,
  deleteTag,
  fetchAsset,
  fetchAssets,
  fetchBootstrap,
  fetchJobs,
  finishJob,
  retryJob,
  seedBuiltinCollections,
  updateAsset,
  updateCollection,
  updateGlobalLimits,
  updateSettings,
  updateTag,
  uploadAsset,
} from './api'
import { runBrowserConversion } from './lib/convert'
import {
  activeFilterCount,
  browseQuery,
  clearFilters,
  readBrowseState,
  writeBrowseState,
  type BrowseState,
  type IconDensity,
} from './lib/browse'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { FilterPanel } from './components/FilterPanel'
import { DetailDrawer } from './components/DetailDrawer'
import { IconCard, IconRow, IconTableRow } from './components/IconCard'

const GAP = 8
const CARD_CAPTION = 40
const DENSITY_MIN: Record<IconDensity, number> = { small: 56, medium: 72, large: 104 }
const LIST_ROW = 52
const TABLE_ROW = 40

function message(error: unknown): string {
  return error instanceof Error ? error.message : t('development.icons.grid.error')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function IconsApp() {
  const breakpoint = useBreakpoint()
  const toast = useUi((state) => state.toast)
  const [browse, setBrowse] = useState<BrowseState>(readBrowseState)
  const [bootstrap, setBootstrap] = useState<IconBootstrap | null>(null)
  const [settings, setSettings] = useState<IconSettings | null>(null)
  const [limits, setLimits] = useState<IconLimits | null>(null)
  const [usage, setUsage] = useState<IconUsageSummary | null>(null)
  const [jobs, setJobs] = useState<IconJob[]>([])
  const [converting, setConverting] = useState(false)
  const [convertProgress, setConvertProgress] = useState('')
  const [items, setItems] = useState<IconAssetSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [seeding, setSeeding] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [detail, setDetail] = useState<IconAssetDetail | null>(null)
  const [detailSource, setDetailSource] = useState<{ body: string; viewBox: string } | null>(null)
  const [detailBusy, setDetailBusy] = useState('')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [uploadOpen, setUploadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [collectionOpen, setCollectionOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const requestId = useRef(0)
  const browserAbort = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef(0)
  const scrollTopRef = useRef(0)
  const seededReload = useRef(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [contentWidth, setContentWidth] = useState(960)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [marqueeActive, setMarqueeActive] = useState(false)
  const marqueeStart = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const debouncedQuery = useDebounced(browse.q, 260)
  const applyBootstrap = useCallback((next: IconBootstrap) => {
    setBootstrap(next)
    setSettings(next.settings)
    setLimits(next.limits)
    setUsage(next.usage)
  }, [])

  useEffect(() => {
    writeBrowseState(browse)
  }, [browse])

  const load = useCallback(async (reset: boolean) => {
    const id = ++requestId.current
    if (reset) setLoading(true)
    else setLoadingMore(true)
    setError('')
    try {
      const page = await fetchAssets({
        ...browseQuery({ ...browse, q: debouncedQuery }),
        cursor: reset ? undefined : cursor ?? undefined,
      })
      if (id !== requestId.current) return
      setItems((current) => {
        if (reset) return page.items
        const byId = new Map(current.map((item) => [item.id, item]))
        for (const item of page.items) byId.set(item.id, item)
        return [...byId.values()]
      })
      setTotal(page.total ?? page.items.length)
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (cause) {
      if (id === requestId.current) setError(message(cause))
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [browse, cursor, debouncedQuery])

  const refresh = useCallback(async () => {
    const [next, page] = await Promise.all([
      fetchBootstrap(),
      fetchAssets(browseQuery({ ...browse, q: debouncedQuery })),
    ])
    applyBootstrap(next)
    setItems(page.items)
    setTotal(page.total ?? page.items.length)
    setCursor(page.nextCursor)
    setHasMore(page.hasMore)
  }, [applyBootstrap, browse, debouncedQuery])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const next = await fetchBootstrap()
        if (cancelled) return
        applyBootstrap(next)
        if (next.counts.all === 0 && next.collections.length === 0) {
          setSeeding(true)
          await seedBuiltinCollections().catch(() => undefined)
        }
      } catch (cause) {
        if (!cancelled) setError(message(cause))
      }
    })()
    return () => { cancelled = true }
  }, [applyBootstrap])

  useEffect(() => {
    if (!seeding) return
    const timer = window.setInterval(() => {
      void fetchBootstrap().then((next) => {
        applyBootstrap(next)
        if (next.counts.all > 0) {
          setSeeding(false)
          if (!seededReload.current) {
            seededReload.current = true
            void load(true)
          }
        }
      }).catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [applyBootstrap, load, seeding])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    void load(true)
    // The tuple below is the exact filter surface; the browse object also carries view settings that
    // must not refetch the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedQuery,
    browse.state,
    browse.sort,
    browse.pageSize,
    browse.style,
    browse.colorMode,
    browse.sizeMin,
    browse.sizeMax,
    browse.from,
    browse.to,
    browse.collections,
    browse.formats,
    browse.tags,
  ])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight)
      setContentWidth(Math.max(240, element.clientWidth - 24))
    })
    observer.observe(element)
    setViewportHeight(element.clientHeight)
    setContentWidth(Math.max(240, element.clientWidth - 24))
    return () => observer.disconnect()
  }, [loading, browse.view])

  const refreshJobs = useCallback(async () => {
    try {
      setJobs(await fetchJobs())
    } catch {
      // A failed poll leaves the last known list on screen.
    }
  }, [])

  useEffect(() => {
    void refreshJobs()
  }, [refreshJobs])

  const activeJob = jobs.find((job) => job.status === 'queued' || job.status === 'running')
  useEffect(() => {
    if (!activeJob) return
    const timer = window.setInterval(() => { void refreshJobs() }, 2000)
    return () => window.clearInterval(timer)
  }, [activeJob, refreshJobs])

  useEffect(() => {
    const element = sentinelRef.current
    if (!element || !hasMore || loadingMore || loading) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load(false)
    }, { root: scrollRef.current, rootMargin: '240px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasMore, load, loading, loadingMore])

  const collectionNames = useMemo(
    () => new Map((bootstrap?.collections ?? []).map((collection) => [collection.id, collection.name])),
    [bootstrap],
  )

  const toggleFavorite = useCallback(async (item: IconAssetSummary) => {
    await batchAssets(item.favorited ? 'unfavorite' : 'favorite', [item.id])
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, favorited: !entry.favorited } : entry))
    setDetail((current) => current && current.id === item.id ? { ...current, favorited: !current.favorited } : current)
  }, [])

  const togglePinned = useCallback(async (item: IconAssetSummary) => {
    await batchAssets(item.pinned ? 'unpin' : 'pin', [item.id])
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, pinned: !entry.pinned } : entry))
    setDetail((current) => current && current.id === item.id ? { ...current, pinned: !current.pinned } : current)
  }, [])

  const remove = useCallback(async (item: IconAssetSummary) => {
    if (!(await confirm({ title: t('development.icons.common.delete_title'), description: t('development.icons.common.delete_description'), tone: 'danger' }))) return
    await deleteAsset(item.id)
    setItems((current) => current.filter((entry) => entry.id !== item.id))
    setTotal((current) => Math.max(0, current - 1))
    setSelection((current) => { const next = new Set(current); next.delete(item.id); return next })
    setDetail((current) => current?.id === item.id ? null : current)
    toast({ title: t('development.icons.common.delete'), tone: 'success' })
  }, [toast])

  const toggleSelect = useCallback((id: string, checked: boolean) => {
    setSelection((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const copyIcon = useCallback(async (item: IconAssetSummary) => {
    try {
      if (item.format === 'svg') {
        const response = await fetch(item.rawUrl)
        if (!response.ok) throw new Error(t('development.icons.grid.error'))
        await copyText(await response.text())
      } else {
        await copyText(item.rawUrl)
      }
      toast({ title: t('development.icons.card.copied'), tone: 'success' })
    } catch (cause) {
      toast({ title: message(cause), tone: 'danger' })
    }
  }, [toast])

  const openDetail = useCallback(async (item: IconAssetSummary) => {
    setDetailBusy(item.id)
    try {
      const full = await fetchAsset(item.id)
      setDetail(full)
      if (full.format === 'svg') {
        const response = await fetch(full.rawUrl)
        const body = response.ok ? await response.text() : ''
        const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(body)?.[1] ?? full.viewBox ?? '0 0 24 24'
        const inner = body.replace(/^[\s\S]*?<svg\b[^>]*>/i, '').replace(/<\/svg>[\s\S]*$/i, '').trim()
        setDetailSource(inner ? { body: inner, viewBox } : null)
      } else {
        setDetailSource(null)
      }
    } catch (cause) {
      toast({ title: message(cause), tone: 'danger' })
    } finally {
      setDetailBusy('')
    }
  }, [toast])

  const updateTags = useCallback(async (item: IconAssetDetail, tagIds: string[]) => {
    await updateAsset(item.id, { tagIds })
    const tags = (bootstrap?.tags ?? []).filter((tag) => tagIds.includes(tag.id)).map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }))
    setDetail((current) => current?.id === item.id ? { ...current, tags } : current)
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, tags } : entry))
  }, [bootstrap])

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    let done = 0
    let failed = 0
    for (const file of list) {
      try {
        const result = await uploadAsset(file, browse.collections[0])
        done += 1
        if (result.deduped) toast({ title: t('development.icons.upload.deduped'), tone: 'default' })
      } catch (cause) {
        failed += 1
        toast({ title: `${file.name}: ${message(cause)}`, tone: 'danger' })
      }
    }
    setUploadOpen(false)
    await refresh()
    toast({ title: failed ? `${done} / ${list.length}` : t('development.icons.upload.complete'), tone: failed ? 'warning' : 'success' })
  }, [browse.collections, refresh, toast])

  const startConvert = useCallback(async (kind: 'png' | 'ico' | 'sprite_svg' | 'sprite_png', sizes: number[], padding = 2, scales: number[] = [1], scss = false) => {
    const ids = [...(selection.size ? selection : new Set(items.slice(0, 20).map((item) => item.id)))]
    if (!ids.length) return
    const options = kind === 'png'
      ? { kind, sizes: sizes.filter((size) => ICON_PNG_PRESETS.includes(size as never)) }
      : kind === 'ico'
        ? { kind, sizes }
        : kind === 'sprite_svg'
          ? { kind, padding }
          : { kind, padding, scales, scss }
    const job = await createJob(ids, options)
    setConvertOpen(false)
    setJobs((current) => [job, ...current])
    toast({ title: t('development.icons.job.queued'), tone: 'default' })
    if (job.mode === 'browser') {
      setConverting(true)
      setConvertProgress(`0/${ids.length}`)
      const controller = new AbortController()
      browserAbort.current = controller
      try {
        const chosen = items.filter((item) => ids.includes(item.id))
        await runBrowserConversion(job, chosen, (progress) => setConvertProgress(`${progress.done}/${progress.total}`), controller.signal)
        if (!controller.signal.aborted) await finishJob(job.id)
        toast({ title: t('development.icons.job.done'), tone: 'success' })
      } catch (cause) {
        if (controller.signal.aborted) toast({ title: t('development.icons.job.canceled'), tone: 'default' })
        else toast({ title: message(cause), tone: 'danger' })
      } finally {
        browserAbort.current = null
        setConverting(false)
        setConvertProgress('')
        await refreshJobs()
        await refresh()
      }
    }
  }, [items, refresh, refreshJobs, selection, toast])

  const batch = useCallback(async (action: 'delete' | 'favorite' | 'pin') => {
    const ids = [...selection]
    if (!ids.length) return
    if (action === 'delete' && !(await confirm({ title: t('development.icons.common.delete_title'), description: t('development.icons.common.delete_description'), tone: 'danger' }))) return
    await batchAssets(action, ids)
    setSelection(new Set())
    await refresh()
    toast({ title: t('development.icons.toolbar.batch_done'), tone: 'success' })
  }, [refresh, selection, toast])

  const showSidebar = breakpoint !== 'mobile'
  const overQuota = Boolean(usage?.overQuota)
  const counts = bootstrap?.counts

  const cols = browse.view !== 'grid'
    ? 1
    : Math.max(2, Math.floor((contentWidth + GAP) / (DENSITY_MIN[browse.density] + GAP)))
  const cardWidth = browse.view === 'grid' ? Math.max(60, (contentWidth - GAP * (cols - 1)) / cols) : contentWidth
  const cardHeight = cardWidth + CARD_CAPTION
  const rowStride = browse.view === 'grid' ? cardHeight + GAP : browse.view === 'list' ? LIST_ROW : TABLE_ROW
  const totalRows = browse.view === 'grid' ? Math.ceil(items.length / cols) : items.length
  const startRow = Math.max(0, Math.floor(scrollTop / rowStride) - 2)
  const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / rowStride) + 2)
  const gridStart = startRow * cols
  const visibleItems = browse.view === 'grid'
    ? items.slice(gridStart, endRow * cols)
    : items.slice(startRow, endRow)
  const padTop = startRow * rowStride
  const tailHeight = Math.max(0, (totalRows - endRow) * rowStride)
  const imageSize = Math.max(20, Math.min(56, Math.round(cardWidth * 0.5)))
  const filtersActive = activeFilterCount(browse) > 0 || Boolean(browse.q)
  const title = browse.collections.length
    ? browse.collections.map((id) => collectionNames.get(id) ?? id).join(', ')
    : browse.tags.length
      ? browse.tags.map((id) => bootstrap?.tags.find((tag) => tag.id === id)?.name ?? id).join(', ')
      : browse.state === 'all'
        ? t('development.icons.sidebar.all')
        : browse.state === 'favorites'
          ? t('development.icons.sidebar.favorites')
          : browse.state === 'pinned'
            ? t('development.icons.sidebar.pinned')
            : browse.state === 'recent'
              ? t('development.icons.sidebar.recent')
              : t('development.icons.sidebar.uncategorized')

  const startMarquee = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.target !== event.currentTarget || browse.view !== 'grid') return
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    marqueeStart.current = { x, y, moved: false }
    setMarquee({ x1: x, y1: y, x2: x, y2: y })
    setMarqueeActive(true)
    event.preventDefault()
  }

  useEffect(() => {
    if (!marqueeActive) return
    const onMove = (event: PointerEvent): void => {
      const start = marqueeStart.current
      const rect = gridRef.current?.getBoundingClientRect()
      if (!start || !rect) return
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
      if (Math.abs(x - start.x) > 4 || Math.abs(y - start.y) > 4) start.moved = true
      setMarquee({ x1: start.x, y1: start.y, x2: x, y2: y })
      if (!start.moved) return
      const minX = Math.min(start.x, x)
      const maxX = Math.max(start.x, x)
      const minY = Math.min(start.y, y)
      const maxY = Math.max(start.y, y)
      const firstRow = Math.max(0, Math.floor(minY / rowStride))
      const lastRow = Math.min(totalRows - 1, Math.floor(maxY / rowStride))
      const next = new Set<string>()
      for (let row = firstRow; row <= lastRow; row += 1) {
        const top = row * rowStride
        if (top + cardHeight < minY || top > maxY) continue
        for (let col = 0; col < cols; col += 1) {
          const left = col * (cardWidth + GAP)
          if (left + cardWidth < minX || left > maxX) continue
          const item = items[row * cols + col]
          if (item) next.add(item.id)
        }
      }
      setSelection(next)
    }
    const onUp = (): void => {
      if (!marqueeStart.current?.moved) setSelection(new Set())
      marqueeStart.current = null
      setMarquee(null)
      setMarqueeActive(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [cardHeight, cardWidth, cols, items, marqueeActive, rowStride, totalRows])

  if (!bootstrap && loading) return <LoadingBlock label={t('development.icons.grid.loading')} />

  const sidebar = bootstrap && (
    <Sidebar
      bootstrap={bootstrap}
      state={browse}
      onChange={setBrowse}
      onManageCollections={() => setCollectionOpen(true)}
      onManageTags={() => setTagOpen(true)}
    />
  )

  return (
    <div data-testid="icons-app-root" className="flex h-full min-h-0 w-full overflow-hidden bg-[var(--bg-base)]">
      {showSidebar && sidebar}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Toolbar
          bootstrap={bootstrap}
          state={browse}
          total={total}
          loading={loading}
          converting={converting}
          overQuota={overQuota}
          selectionCount={selection.size}
          onChange={setBrowse}
          onOpenFilters={() => setFilterOpen(true)}
          onOpenSidebar={() => setSidebarOpen(true)}
          onUpload={() => setUploadOpen(true)}
          onImport={() => setImportOpen(true)}
          onExport={() => setExportOpen(true)}
          onConvert={() => setConvertOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          onRefresh={() => void refresh()}
          onClearSelection={() => setSelection(new Set())}
          onBatchDelete={() => void batch('delete')}
          onBatchFavorite={() => void batch('favorite')}
          onBatchPin={() => void batch('pin')}
        />

        {overQuota && usage && (
          <div data-testid="icons-over-quota" className="flex flex-wrap items-center gap-2 bg-[var(--danger-soft)] px-4 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
            <AlertCircle size={14} />
            <span>{t('development.icons.quota.over')} {formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)}</span>
            <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>{t('development.icons.settings.title')}</Button>
          </div>
        )}

        {seeding && (
          <div data-testid="icons-seeding" className="flex flex-wrap items-center gap-2 bg-[var(--accent-soft)] px-4 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <Loader2 size={14} className="animate-spin" />
            <span>{t('development.icons.seed.running')}</span>
            <span className="tabular-nums text-[var(--text-tertiary)]">{t('development.icons.seed.count')} {counts?.all ?? 0}</span>
          </div>
        )}

        {converting && (
          <div data-testid="icons-converting" className="flex items-center gap-2 bg-[var(--accent-soft)] px-4 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <Loader2 size={14} className="animate-spin" />
            <span>{t('development.icons.convert.browser')} {convertProgress}</span>
          </div>
        )}

        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span className="truncate font-medium text-[var(--text-secondary)]">{title}</span>
          <span className="tabular-nums">{total.toLocaleString()}</span>
          {filtersActive && <span className="rounded-[var(--r-full)] bg-[var(--accent-soft)] px-1.5 text-[length:var(--text-10)] text-[var(--accent)]">{t('development.icons.filter.active')}</span>}
          {detailBusy && <Loader2 size={12} className="ml-auto animate-spin" />}
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-[var(--danger-soft)] px-4 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
            <AlertCircle size={14} />
            <span className="min-w-0 flex-1 truncate">{error}</span>
            <Button size="sm" variant="ghost" onClick={() => void load(true)}>{t('development.icons.grid.retry')}</Button>
          </div>
        )}

        <div
          ref={scrollRef}
          onScroll={(event) => {
            scrollTopRef.current = event.currentTarget.scrollTop
            if (scrollFrame.current) return
            scrollFrame.current = window.requestAnimationFrame(() => {
              scrollFrame.current = 0
              setScrollTop(scrollTopRef.current)
            })
          }}
          className="min-h-0 flex-1 overflow-auto p-3"
        >
          {loading ? (
            <GridSkeleton view={browse.view} cols={cols} cardHeight={cardHeight} />
          ) : items.length === 0 ? (
            <Empty
              art="notes"
              title={seeding ? t('development.icons.grid.empty.seed_title') : filtersActive ? t('development.icons.grid.empty.matches_title') : t('development.icons.grid.empty.title')}
              description={seeding ? t('development.icons.grid.empty.seed_description') : filtersActive ? t('development.icons.grid.empty.matches_description') : t('development.icons.grid.empty.description')}
              action={(
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {filtersActive && <Button size="sm" onClick={() => setBrowse(clearFilters({ ...browse, q: '' }))}>{t('development.icons.filter.clear')}</Button>}
                  {!filtersActive && <Button size="sm" onClick={() => { setSeeding(true); void seedBuiltinCollections().then(() => setSeeding(true)).catch((cause) => { setSeeding(false); toast({ title: message(cause), tone: 'danger' }) }) }}><Images size={14} />{t('development.icons.grid.empty.builtin')}</Button>}
                  {!filtersActive && <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}><Download size={14} />{t('development.icons.grid.empty.iconify')}</Button>}
                  {!filtersActive && <Button size="sm" variant="secondary" disabled={overQuota} onClick={() => setUploadOpen(true)}><Upload size={14} />{t('development.icons.toolbar.upload')}</Button>}
                </div>
              )}
            />
          ) : browse.view === 'grid' ? (
            <div
              ref={gridRef}
              className="relative select-none"
              style={{ height: totalRows * rowStride }}
              onPointerDown={startMarquee}
            >
              <div
                className="pointer-events-none absolute inset-x-0 top-0 grid will-change-transform"
                style={{ transform: `translateY(${padTop}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}
              >
                {visibleItems.map((item) => (
                  <div key={item.id} className="pointer-events-auto">
                    <IconCard
                      item={item}
                      height={cardHeight}
                      imageSize={imageSize}
                      selected={selection.has(item.id)}
                      onOpen={openDetail}
                      onFavorite={toggleFavorite}
                      onPin={togglePinned}
                      onCopy={copyIcon}
                      onSelect={toggleSelect}
                    />
                  </div>
                ))}
              </div>
              {marquee && (
                <div
                  className="pointer-events-none absolute rounded-[var(--r-sm)] border border-[var(--accent)] bg-[var(--accent-soft)] opacity-60"
                  style={{
                    left: Math.min(marquee.x1, marquee.x2),
                    top: Math.min(marquee.y1, marquee.y2),
                    width: Math.abs(marquee.x2 - marquee.x1),
                    height: Math.abs(marquee.y2 - marquee.y1),
                  }}
                />
              )}
            </div>
          ) : browse.view === 'list' ? (
            <div className="relative" style={{ height: items.length * LIST_ROW }}>
              <div className="absolute inset-x-0 top-0 flex flex-col gap-1 will-change-transform" style={{ transform: `translateY(${padTop}px)` }}>
                {visibleItems.map((item) => (
                  <IconRow
                    key={item.id}
                    item={item}
                    selected={selection.has(item.id)}
                    collectionName={item.collectionId ? collectionNames.get(item.collectionId) ?? '' : ''}
                    onOpen={openDetail}
                    onFavorite={toggleFavorite}
                    onPin={togglePinned}
                    onCopy={copyIcon}
                    onSelect={toggleSelect}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] table-fixed border-collapse text-[length:var(--text-12)]">
                <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] text-[length:var(--text-10)] uppercase tracking-wide text-[var(--text-tertiary)]">
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="w-8 px-2 py-2" aria-label={t('development.icons.table.select')} />
                    <th className="w-10 px-1 py-2" aria-label={t('development.icons.table.icon')} />
                    <th className="px-2 py-2 text-left font-medium">{t('development.icons.table.name')}</th>
                    <th className="w-36 px-2 py-2 text-left font-medium">{t('development.icons.table.collection')}</th>
                    <th className="w-16 px-2 py-2 text-left font-medium">{t('development.icons.table.format')}</th>
                    <th className="w-20 px-2 py-2 text-left font-medium">{t('development.icons.table.size')}</th>
                    <th className="w-48 px-2 py-2 text-left font-medium">{t('development.icons.table.tags')}</th>
                    <th className="w-16 px-2 py-2 text-left font-medium">{t('development.icons.table.status')}</th>
                    <th className="w-24 px-2 py-2 text-right font-medium">{t('development.icons.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr aria-hidden="true" style={{ height: padTop }}><td colSpan={9} /></tr>
                  {visibleItems.map((item) => (
                    <IconTableRow
                      key={item.id}
                      item={item}
                      selected={selection.has(item.id)}
                      collectionName={item.collectionId ? collectionNames.get(item.collectionId) ?? '' : ''}
                      onOpen={openDetail}
                      onFavorite={toggleFavorite}
                      onPin={togglePinned}
                      onCopy={copyIcon}
                      onSelect={toggleSelect}
                    />
                  ))}
                  <tr aria-hidden="true" style={{ height: tailHeight }}><td colSpan={9} /></tr>
                </tbody>
              </table>
            </div>
          )}
          <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" />
          {hasMore && (
            <div className="flex items-center justify-center gap-2 py-3 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              <span>{t('development.icons.grid.loaded')} {items.length} / {total}</span>
              <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void load(false)}>
                {loadingMore ? <Loader2 size={13} className="animate-spin" /> : null}
                {t('development.icons.grid.load_more')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {bootstrap && (
        <Drawer open={!showSidebar && sidebarOpen} onClose={() => setSidebarOpen(false)} side="left" width={288} title={t('development.icons.sidebar.title')}>
          <Sidebar
            bootstrap={bootstrap}
            state={browse}
            onChange={setBrowse}
            onManageCollections={() => setCollectionOpen(true)}
            onManageTags={() => setTagOpen(true)}
            embedded
          />
        </Drawer>
      )}

      <FilterPanel open={filterOpen} onClose={() => setFilterOpen(false)} bootstrap={bootstrap ?? EMPTY_BOOTSTRAP} state={browse} onChange={setBrowse} />

      <DetailDrawer
        detail={detail}
        source={detailSource}
        collections={bootstrap?.collections ?? []}
        tags={bootstrap?.tags ?? []}
        onClose={() => { setDetail(null); setDetailSource(null) }}
        onFavorite={(entry) => void toggleFavorite(entry)}
        onPin={(entry) => void togglePinned(entry)}
        onDelete={(entry) => void remove(entry)}
        onTags={updateTags}
        notify={toast}
      />

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onFiles={uploadFiles} collections={bootstrap?.collections ?? []} collectionId={browse.collections[0] ?? ''} onCollection={(id) => setBrowse({ ...browse, collections: id ? [id] : [] })} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        limits={limits}
        usage={usage}
        isOwner={Boolean(bootstrap?.isOwner)}
        onSaved={(next) => { setSettings(next); setSettingsOpen(false); void refresh() }}
        onLimitsSaved={(next) => { setLimits(next); void refresh() }}
      />
      <CollectionManager open={collectionOpen} onClose={() => setCollectionOpen(false)} collections={bootstrap?.collections ?? []} onChanged={refresh} notify={toast} />
      <TagManager open={tagOpen} onClose={() => setTagOpen(false)} tags={bootstrap?.tags ?? []} onChanged={refresh} notify={toast} />
      <ConvertDialog open={convertOpen} onClose={() => setConvertOpen(false)} onStart={startConvert} />
      <IconImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={async (result) => { setImportOpen(false); await refresh(); toast({ title: `${result.processedItems}/${result.totalItems}`, tone: result.failedItems ? 'warning' : 'success' }) }}
        onSeedAll={async () => { setImportOpen(false); setSeeding(true); await seedBuiltinCollections(); }}
      />
      <IconExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onDone={async (exported) => { setExportOpen(false); toast({ title: t('development.icons.export.done'), tone: 'success' }); window.location.href = exported.downloadUrl }}
        assetIds={selection.size ? [...selection] : items.slice(0, 20).map((item) => item.id)}
      />
      <JobStrip jobs={jobs} onCancel={async (id) => { browserAbort.current?.abort(); await cancelJob(id); await refreshJobs() }} onRetry={async (id) => { await retryJob(id); await refreshJobs() }} />
    </div>
  )
}

const EMPTY_BOOTSTRAP: IconBootstrap = {
  collections: [],
  tags: [],
  counts: { all: 0, favorites: 0, pinned: 0, recent: 0, uncategorized: 0, collections: {}, tags: {}, formats: {}, styles: {}, colorModes: {} },
  settings: { quotaBytes: 0, maxSvgBytes: 0, maxRasterBytes: 0, maxDimension: 0, batchLimit: 0, zipLimitBytes: 0, zipLimitEntries: 0 },
  limits: { hardQuotaBytes: 0, hardMaxSvgBytes: 0, hardMaxRasterBytes: 0, hardMaxDimension: 0, hardBatchLimit: 0, hardZipLimitBytes: 0, hardZipLimitEntries: 0 },
  usage: { usedBytes: 0, quotaBytes: 0, assetsBytes: 0, outputsBytes: 0, exportsBytes: 0, overQuota: false },
  isOwner: false,
  schemaVersions: [320, 321, 327, 328],
}

function GridSkeleton({ view, cols, cardHeight }: { view: BrowseState['view']; cols: number; cardHeight: number }) {
  if (view === 'table') {
    return <div className="space-y-1">{Array.from({ length: 14 }).map((_, index) => <Skeleton key={index} className="h-9 rounded-[var(--r-sm)]" />)}</div>
  }
  if (view === 'list') {
    return <div className="space-y-1">{Array.from({ length: 12 }).map((_, index) => <Skeleton key={index} className="h-11 rounded-[var(--r-sm)]" />)}</div>
  }
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {Array.from({ length: Math.max(12, cols * 3) }).map((_, index) => <Skeleton key={index} className="rounded-[var(--r-md)]" style={{ height: cardHeight }} />)}
    </div>
  )
}

interface UploadDialogProps {
  open: boolean
  onClose: () => void
  onFiles: (files: FileList | File[]) => Promise<void>
  collections: IconCollection[]
  collectionId: string
  onCollection: (id: string) => void
}

function UploadDialog({ open, onClose, onFiles, collections, collectionId, onCollection }: UploadDialogProps) {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.upload.title')} width={520}>
      <div className="space-y-3">
        <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] p-4 text-center text-[length:var(--text-12)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]">
          <Upload size={20} />
          <span>{t('development.icons.upload.drop')}</span>
          <input type="file" multiple accept=".svg,.png,.jpg,.jpeg,.webp" className="sr-only" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
        </label>
        <SelectMenu label={t('development.icons.upload.prefix')} value={collectionId} onChange={onCollection} options={[{ value: '', label: t('development.icons.sidebar.uncategorized') }, ...collections.map((item) => ({ value: item.id, label: item.name }))]} />
        {files.length > 0 && <div className="max-h-32 overflow-auto text-[length:var(--text-11)] text-[var(--text-secondary)]">{files.map((file) => <div key={`${file.name}-${file.size}`} className="truncate">{file.name}</div>)}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('development.icons.upload.cancel')}</Button>
          <Button disabled={!files.length || busy} onClick={() => { setBusy(true); void onFiles(files).finally(() => setBusy(false)) }}>{busy ? <Loader2 size={14} className="animate-spin" /> : null}{t('development.icons.upload.start')}</Button>
        </div>
      </div>
    </Modal>
  )
}

function SettingsDialog({ open, onClose, settings, limits, usage, isOwner, onSaved, onLimitsSaved }: {
  open: boolean
  onClose: () => void
  settings: IconSettings | null
  limits: IconLimits | null
  usage: IconUsageSummary | null
  isOwner: boolean
  onSaved: (settings: IconSettings) => void
  onLimitsSaved: (limits: IconLimits) => void
}) {
  const [draft, setDraft] = useState<IconSettings | null>(settings)
  const [draftLimits, setDraftLimits] = useState<IconLimits | null>(limits)
  useEffect(() => { setDraft(settings) }, [settings])
  useEffect(() => { setDraftLimits(limits) }, [limits])
  if (!draft) return null
  const field = (label: string, key: keyof IconSettings) => (
    <label className="flex items-center justify-between gap-3 text-[length:var(--text-12)]">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <Input value={String(draft[key])} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) || 0 })} type="number" aria-label={label} className="w-32" />
    </label>
  )
  const limitField = (label: string, key: keyof IconLimits) => (
    <label className="flex items-center justify-between gap-3 text-[length:var(--text-12)]">
      <span className="text-[var(--text-secondary)]">{label}</span>
      {draftLimits && (
        <Input value={String(draftLimits[key])} onChange={(event) => setDraftLimits({ ...draftLimits, [key]: Number(event.target.value) || 0 })} type="number" aria-label={label} className="w-32" />
      )}
    </label>
  )
  const percent = usage && usage.quotaBytes ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100)) : 0
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.settings.title')} width={520}>
      <div className="space-y-2">
        {usage && (
          <div className="space-y-1 pb-2">
            <div className="flex items-center justify-between text-[length:var(--text-11)] text-[var(--text-secondary)]">
              <span>{t('development.icons.settings.usage')}</span>
              <span className={usage.overQuota ? 'text-[var(--danger)]' : ''}>{formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)} ({percent}%)</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]">
              <div className={cn('h-full rounded-full', usage.overQuota ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]')} style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
        {field(t('development.icons.settings.quota'), 'quotaBytes')}
        {field(t('development.icons.settings.max_svg'), 'maxSvgBytes')}
        {field(t('development.icons.settings.max_raster'), 'maxRasterBytes')}
        {field(t('development.icons.settings.max_dimension'), 'maxDimension')}
        {field(t('development.icons.settings.batch_limit'), 'batchLimit')}
        {field(t('development.icons.settings.zip_limit'), 'zipLimitBytes')}
        {field(t('development.icons.settings.zip_entries'), 'zipLimitEntries')}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>{t('development.icons.common.cancel')}</Button>
          <Button onClick={() => void updateSettings({ ...draft }).then(onSaved)}>{t('development.icons.settings.save')}</Button>
        </div>
        {isOwner && draftLimits && (
          <div className="mt-3 space-y-2 border-t border-[var(--border-subtle)] pt-3">
            <div className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('development.icons.settings.owner_title')}</div>
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.icons.settings.owner_hint')}</p>
            {limitField(t('development.icons.settings.quota'), 'hardQuotaBytes')}
            {limitField(t('development.icons.settings.max_svg'), 'hardMaxSvgBytes')}
            {limitField(t('development.icons.settings.max_raster'), 'hardMaxRasterBytes')}
            {limitField(t('development.icons.settings.max_dimension'), 'hardMaxDimension')}
            {limitField(t('development.icons.settings.batch_limit'), 'hardBatchLimit')}
            {limitField(t('development.icons.settings.zip_limit'), 'hardZipLimitBytes')}
            {limitField(t('development.icons.settings.zip_entries'), 'hardZipLimitEntries')}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void updateGlobalLimits({ ...draftLimits }).then(onLimitsSaved)}>{t('development.icons.settings.save_global')}</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function CollectionManager({ open, onClose, collections, onChanged, notify }: {
  open: boolean
  onClose: () => void
  collections: IconCollection[]
  onChanged: () => Promise<void>
  notify: (input: { title: string; tone?: 'default' | 'success' | 'warning' | 'danger' }) => void
}) {
  const [name, setName] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const create = async (): Promise<void> => {
    if (!name.trim()) return
    await createCollection({ name: name.trim(), description: '', source: 'upload', license: '', homepage: '', sortOrder: 0 })
    setName('')
    await onChanged()
    notify({ title: t('development.icons.collection.created'), tone: 'success' })
  }
  const save = async (collection: IconCollection): Promise<void> => {
    const next = (edits[collection.id] ?? collection.name).trim()
    if (!next || next === collection.name) return
    await updateCollection(collection.id, { name: next })
    setEdits((current) => { const copy = { ...current }; delete copy[collection.id]; return copy })
    await onChanged()
    notify({ title: t('development.icons.collection.updated'), tone: 'success' })
  }
  const remove = async (collection: IconCollection): Promise<void> => {
    if (!(await confirm({ title: t('development.icons.collection.delete_title'), description: t('development.icons.collection.delete_description'), tone: 'danger' }))) return
    await deleteCollection(collection.id)
    await onChanged()
    notify({ title: t('development.icons.collection.deleted'), tone: 'success' })
  }
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.collection.manage')} width={520}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('development.icons.collection.name')} aria-label={t('development.icons.collection.name')} />
          <Button disabled={!name.trim()} onClick={() => void create()}>{t('development.icons.common.create')}</Button>
        </div>
        <div className="max-h-80 space-y-1 overflow-auto">
          {collections.map((collection) => (
            <div key={collection.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1">
              <Input value={edits[collection.id] ?? collection.name} onChange={(event) => setEdits((current) => ({ ...current, [collection.id]: event.target.value }))} aria-label={t('development.icons.collection.name')} />
              <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{collection.count ?? 0}</span>
              <Button size="sm" variant="secondary" onClick={() => void save(collection)}>{t('development.icons.common.save')}</Button>
              <IconButton label={t('development.icons.common.delete')} size="sm" onClick={() => void remove(collection)}><Trash2 size={12} /></IconButton>
            </div>
          ))}
          {collections.length === 0 && <div className="py-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.icons.collection.empty')}</div>}
        </div>
      </div>
    </Modal>
  )
}

function tagDepth(tags: readonly IconTag[], tag: IconTag): number {
  let depth = 0
  let parent = tag.parentId
  const byId = new Map(tags.map((entry) => [entry.id, entry]))
  while (parent && depth < 8) {
    depth += 1
    parent = byId.get(parent)?.parentId ?? null
  }
  return depth
}

function TagManager({ open, onClose, tags, onChanged, notify }: {
  open: boolean
  onClose: () => void
  tags: IconTag[]
  onChanged: () => Promise<void>
  notify: (input: { title: string; tone?: 'default' | 'success' | 'warning' | 'danger' }) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#64748b')
  const [parentId, setParentId] = useState('')
  const [edits, setEdits] = useState<Record<string, { name: string; color: string; parentId: string }>>({})
  const draftFor = (tag: IconTag) => edits[tag.id] ?? { name: tag.name, color: tag.color, parentId: tag.parentId ?? '' }
  const setDraft = (tag: IconTag, patch: Partial<{ name: string; color: string; parentId: string }>) => {
    setEdits((current) => ({ ...current, [tag.id]: { ...draftFor(tag), ...patch } }))
  }
  const create = async (): Promise<void> => {
    if (!name.trim()) return
    await createTag({ name: name.trim(), color, parentId: parentId || null, sortOrder: 0 })
    setName('')
    await onChanged()
    notify({ title: t('development.icons.tag.created'), tone: 'success' })
  }
  const save = async (tag: IconTag): Promise<void> => {
    const draft = draftFor(tag)
    await updateTag(tag.id, { name: draft.name.trim(), color: draft.color, parentId: draft.parentId || null })
    setEdits((current) => { const copy = { ...current }; delete copy[tag.id]; return copy })
    await onChanged()
    notify({ title: t('development.icons.tag.updated'), tone: 'success' })
  }
  const remove = async (tag: IconTag): Promise<void> => {
    if (!(await confirm({ title: t('development.icons.tag.delete_title'), description: t('development.icons.tag.delete_description'), tone: 'danger' }))) return
    await deleteTag(tag.id)
    await onChanged()
    notify({ title: t('development.icons.tag.deleted'), tone: 'success' })
  }
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.tag.manage')} width={560}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('development.icons.tag.name')} aria-label={t('development.icons.tag.name')} />
          <Input value={color} onChange={(event) => setColor(event.target.value)} aria-label={t('development.icons.tag.color')} className="w-28" />
          <SelectMenu label={t('development.icons.tag.parent')} value={parentId} onChange={setParentId} options={[{ value: '', label: t('development.icons.tag.no_parent') }, ...tags.map((tag) => ({ value: tag.id, label: tag.name }))]} size="sm" />
          <Button size="sm" disabled={!name.trim()} onClick={() => void create()}>{t('development.icons.common.create')}</Button>
        </div>
        <div className="max-h-80 space-y-1 overflow-auto">
          {tags.map((tag) => {
            const draft = draftFor(tag)
            return (
              <div key={tag.id} className="flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1" style={{ marginLeft: tagDepth(tags, tag) * 16 }}>
                <Input value={draft.name} onChange={(event) => setDraft(tag, { name: event.target.value })} aria-label={t('development.icons.tag.name')} />
                <Input value={draft.color} onChange={(event) => setDraft(tag, { color: event.target.value })} aria-label={t('development.icons.tag.color')} className="w-24" />
                <SelectMenu label={t('development.icons.tag.parent')} value={draft.parentId} onChange={(value) => setDraft(tag, { parentId: value })} options={[{ value: '', label: t('development.icons.tag.no_parent') }, ...tags.filter((entry) => entry.id !== tag.id).map((entry) => ({ value: entry.id, label: entry.name }))]} size="sm" />
                <Button size="sm" variant="secondary" onClick={() => void save(tag)}>{t('development.icons.common.save')}</Button>
                <IconButton label={t('development.icons.common.delete')} size="sm" onClick={() => void remove(tag)}><Trash2 size={12} /></IconButton>
              </div>
            )
          })}
          {tags.length === 0 && <div className="py-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.icons.tag.empty')}</div>}
        </div>
      </div>
    </Modal>
  )
}

function JobStrip({ jobs, onCancel, onRetry }: {
  jobs: IconJob[]
  onCancel: (id: string) => Promise<void>
  onRetry: (id: string) => Promise<void>
}) {
  const cutoff = Date.now() - 10 * 60 * 1000
  const visible = jobs
    .filter((job) => job.status === 'queued' || job.status === 'running' || ((job.status === 'failed' || job.status === 'partial') && job.updatedAt >= cutoff))
    .slice(0, 3)
  if (!visible.length) return null
  return (
    <div data-testid="icons-jobs" className="pointer-events-none fixed bottom-3 right-3 z-30 flex w-72 flex-col gap-1">
      {visible.map((job) => {
        const active = job.status === 'queued' || job.status === 'running'
        const percent = job.totalItems ? Math.round(((job.processedItems + job.failedItems) / job.totalItems) * 100) : 0
        return (
          <div key={job.id} className="pointer-events-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1.5 shadow-sm">
            <div className="flex items-center gap-2 text-[length:var(--text-11)]">
              {active && <Loader2 size={12} className="animate-spin" />}
              <span className="truncate text-[var(--text-secondary)]">{job.kind} · {job.mode}</span>
              <span className="ml-auto text-[var(--text-tertiary)]">{job.status} {percent}%</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
              </div>
              {active && <Button size="sm" variant="ghost" onClick={() => void onCancel(job.id)}>{t('development.icons.common.cancel')}</Button>}
              {!active && (job.status === 'failed' || job.status === 'partial') && <Button size="sm" variant="ghost" onClick={() => void onRetry(job.id)}>{t('development.icons.job.retry')}</Button>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function IconImportDialog({ open, onClose, onDone, onSeedAll }: {
  open: boolean
  onClose: () => void
  onDone: (result: IconImport) => Promise<void>
  onSeedAll: () => Promise<void>
}) {
  const [busy, setBusy] = useState('')
  const [limit, setLimit] = useState('120')
  const start = async (prefix: string): Promise<void> => {
    setBusy(prefix)
    try {
      const result = await createImport(prefix, Number(limit))
      await onDone(result)
    } finally {
      setBusy('')
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.import.title')} description={t('development.icons.import.description')} width={720}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('development.icons.import.limit')}</span>
          <SelectMenu
            label={t('development.icons.import.limit')}
            value={limit}
            onChange={setLimit}
            options={[{ value: '60', label: '60' }, { value: '120', label: '120' }, { value: '300', label: '300' }, { value: '500', label: '500' }]}
            size="sm"
            className="w-24"
          />
          <Button size="sm" className="ml-auto" onClick={() => void onSeedAll()}>
            <Images size={13} />{t('development.icons.import.all')}
          </Button>
        </div>
        <div className="grid max-h-[52vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {ICON_BUILTIN_LIBRARIES.map((library) => (
            <article key={library.prefix} className="flex flex-col gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{library.name}</span>
                <span className="rounded-[var(--r-full)] bg-[var(--bg-raised)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{library.license}</span>
                <Button size="sm" variant="secondary" className="ml-auto" loading={busy === library.prefix} onClick={() => void start(library.prefix)}>{t('development.icons.import.one')}</Button>
              </div>
              <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-tertiary)]">{library.description}</p>
              <div className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{library.totalIcons} {t('development.icons.import.icons')}</div>
            </article>
          ))}
        </div>
        <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.import.builtin_hint')}</p>
      </div>
    </Modal>
  )
}

function IconExportDialog({ open, onClose, onDone, assetIds }: {
  open: boolean
  onClose: () => void
  onDone: (exported: { downloadUrl: string }) => Promise<void>
  assetIds: string[]
}) {
  const [format, setFormat] = useState<'svg' | 'png' | 'ico' | 'zip' | 'sprite_svg' | 'sprite_png'>('zip')
  const [sizes, setSizes] = useState<number[]>([...ICON_PNG_PRESETS])
  const [busy, setBusy] = useState(false)
  const toggle = (size: number) => setSizes((current) => current.includes(size) ? current.filter((value) => value !== size) : [...current, size].sort((a, b) => a - b))
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const options = format === 'png'
        ? { kind: 'png', sizes }
        : format === 'ico'
          ? { kind: 'ico', sizes: ICON_ICO_PRESETS.filter((size) => sizes.includes(size)) }
          : format === 'sprite_png'
            ? { kind: 'sprite_png', padding: 2, scales: [1], scss: false }
            : format === 'sprite_svg'
              ? { kind: 'sprite_svg', padding: 2 }
              : undefined
      const exported = await createExport(format, assetIds, options)
      await onDone(exported)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.export.title')} width={460}>
      <div className="space-y-3">
        <SelectMenu label={t('development.icons.export.format')} value={format} onChange={(value) => { setFormat(value as typeof format); setSizes(value === 'ico' ? [...ICON_ICO_PRESETS] : [...ICON_PNG_PRESETS]) }} options={[
          { value: 'zip', label: 'ZIP' },
          { value: 'svg', label: 'SVG' },
          { value: 'png', label: 'PNG' },
          { value: 'ico', label: 'ICO' },
          { value: 'sprite_svg', label: 'SVG sprite' },
          { value: 'sprite_png', label: 'PNG sprite' },
        ]} />
        {format === 'png' && (
          <div className="flex flex-wrap gap-2">
            {ICON_PNG_PRESETS.map((size) => <label key={size} className="flex items-center gap-1 text-[length:var(--text-12)]"><Checkbox checked={sizes.includes(size)} onChange={() => toggle(size)} label="" />{size}</label>)}
          </div>
        )}
        {format === 'ico' && (
          <div className="flex flex-wrap gap-2">
            {ICON_ICO_PRESETS.map((size) => <label key={size} className="flex items-center gap-1 text-[length:var(--text-12)]"><Checkbox checked={sizes.includes(size)} onChange={() => toggle(size)} label="" />{size}</label>)}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('development.icons.common.cancel')}</Button>
          <Button disabled={busy || !assetIds.length} onClick={() => void start()}>{busy ? <Loader2 size={14} className="animate-spin" /> : null}{t('development.icons.export.start')}</Button>
        </div>
      </div>
    </Modal>
  )
}

function ConvertDialog({ open, onClose, onStart }: {
  open: boolean
  onClose: () => void
  onStart: (kind: 'png' | 'ico' | 'sprite_svg' | 'sprite_png', sizes: number[], padding?: number, scales?: number[], scss?: boolean) => Promise<void>
}) {
  const [kind, setKind] = useState<'png' | 'ico' | 'sprite_svg' | 'sprite_png'>('png')
  const [sizes, setSizes] = useState<number[]>([...ICON_PNG_PRESETS])
  const [padding, setPadding] = useState(2)
  const [scales, setScales] = useState<number[]>([1])
  const [scss, setScss] = useState(false)
  const toggle = (size: number) => setSizes((current) => current.includes(size) ? current.filter((value) => value !== size) : [...current, size].sort((a, b) => a - b))
  const toggleScale = (scale: number) => setScales((current) => current.includes(scale) ? current.filter((value) => value !== scale) : [...current, scale].sort((a, b) => a - b))
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.convert.title')} width={440}>
      <div className="space-y-3">
        <SelectMenu label={t('development.icons.convert.kind')} value={kind} onChange={(value) => { setKind(value as typeof kind); setSizes(value === 'ico' ? [...ICON_ICO_PRESETS] : [...ICON_PNG_PRESETS]) }} options={[
          { value: 'png', label: t('development.icons.convert.png') },
          { value: 'ico', label: t('development.icons.convert.ico') },
          { value: 'sprite_svg', label: t('development.icons.convert.sprite_svg') },
          { value: 'sprite_png', label: t('development.icons.convert.sprite_png') },
        ]} />
        {(kind === 'png' || kind === 'ico') && (
          <div className="flex flex-wrap gap-2">
            {(kind === 'png' ? ICON_PNG_PRESETS : ICON_ICO_PRESETS).map((size) => (
              <label key={size} className="flex items-center gap-1 text-[length:var(--text-12)]"><Checkbox checked={sizes.includes(size)} onChange={() => toggle(size)} label="" />{size}</label>
            ))}
          </div>
        )}
        {(kind === 'sprite_svg' || kind === 'sprite_png') && <Slider value={padding} min={0} max={32} onChange={setPadding} label={t('development.icons.convert.padding')} suffix="px" />}
        {kind === 'sprite_png' && (
          <>
            <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
              <span>{t('development.icons.convert.scale')}</span>
              {[1, 2].map((scale) => <label key={scale} className="flex items-center gap-1"><Checkbox checked={scales.includes(scale)} onChange={() => toggleScale(scale)} label="" />{`${scale}x`}</label>)}
            </div>
            <label className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)]"><Checkbox checked={scss} onChange={setScss} label="" />{t('development.icons.convert.scss')}</label>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('development.icons.common.cancel')}</Button>
          <Button disabled={!sizes.length || (kind === 'sprite_png' && !scales.length)} onClick={() => void onStart(kind, sizes, padding, scales, scss)}>{t('development.icons.convert.start')}</Button>
        </div>
      </div>
    </Modal>
  )
}
