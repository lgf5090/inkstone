import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  Pin,
  Plus,
  Settings2,
  Star,
  Tag as TagIcon,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  IconAssetDetail,
  IconAssetSummary,
  IconBootstrap,
  IconCollection,
  IconFormat,
  IconSettings,
} from '@shared/development/icons/types'
import { ICON_PNG_PRESETS } from '@shared/development/icons/limits'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useBreakpoint, useDebounced } from '../../../lib/hooks'
import { copyText } from '../../../lib/clipboard'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Input, Segmented, Slider } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Drawer, Modal, confirm } from '../../../components/overlay'
import { Empty, LoadingBlock, Skeleton } from '../../../components/feedback'
import { useUi } from '../../../store/ui'
import {
  batchAssets,
  createCollection,
  createJob,
  createTag,
  deleteAsset,
  fetchAssets,
  fetchBootstrap,
  updateSettings,
  uploadAsset,
} from './api'

type Density = 'compact' | 'comfortable' | 'large'

const DENSITY: Record<Density, { height: number; label: string }> = {
  compact: { height: 96, label: 'development.icons.toolbar.density.compact' },
  comfortable: { height: 124, label: 'development.icons.toolbar.density.comfortable' },
  large: { height: 156, label: 'development.icons.toolbar.density.large' },
}

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
  const [bootstrap, setBootstrap] = useState<IconBootstrap | null>(null)
  const [settings, setSettings] = useState<IconSettings | null>(null)
  const [items, setItems] = useState<IconAssetSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 260)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [density, setDensity] = useState<Density>('comfortable')
  const [format, setFormat] = useState<IconFormat | ''>('')
  const [sort, setSort] = useState<'created' | 'updated' | 'name' | 'used'>('created')
  const [stateView, setStateView] = useState<'all' | 'favorites' | 'pinned' | 'recent' | 'uncategorized'>('all')
  const [collectionId, setCollectionId] = useState('')
  const [tagId, setTagId] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [detail, setDetail] = useState<IconAssetDetail | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [uploadOpen, setUploadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [collectionOpen, setCollectionOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const requestId = useRef(0)

  const applyBootstrap = useCallback((next: IconBootstrap) => {
    setBootstrap(next)
    setSettings(next.settings)
  }, [])

  const load = useCallback(async (reset: boolean) => {
    const id = ++requestId.current
    if (reset) setLoading(true)
    else setLoadingMore(true)
    setError('')
    try {
      const page = await fetchAssets({
        limit: 60,
        cursor: reset ? undefined : cursor ?? undefined,
        q: debounced || undefined,
        collectionId: collectionId || undefined,
        tagId: tagId || undefined,
        format: format || undefined,
        state: stateView,
        sort,
      })
      if (id !== requestId.current) return
      setItems((current) => {
        const base = reset ? [] : current
        const byId = new Map(base.map((item) => [item.id, item]))
        for (const item of page.items) byId.set(item.id, item)
        return [...byId.values()].slice(0, 300)
      })
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
  }, [collectionId, cursor, debounced, format, sort, stateView, tagId])

  useEffect(() => {
    let cancelled = false
    fetchBootstrap()
      .then((next) => { if (!cancelled) applyBootstrap(next) })
      .catch((cause) => { if (!cancelled) setError(message(cause)) })
    return () => { cancelled = true }
  }, [applyBootstrap])

  useEffect(() => {
    void load(true)
  }, [debounced, collectionId, format, sort, stateView, tagId])

  const refresh = useCallback(async () => {
    const [next, page] = await Promise.all([
      fetchBootstrap(),
      fetchAssets({ limit: 60, q: debounced || undefined, collectionId: collectionId || undefined, tagId: tagId || undefined, format: format || undefined, state: stateView, sort }),
    ])
    applyBootstrap(next)
    setItems(page.items)
    setCursor(page.nextCursor)
    setHasMore(page.hasMore)
  }, [applyBootstrap, collectionId, debounced, format, sort, stateView, tagId])

  const currentCollection = bootstrap?.collections.find((item) => item.id === collectionId)
  const tagTree = useMemo(() => bootstrap?.tags ?? [], [bootstrap])
  const showSidebar = breakpoint !== 'mobile'

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
    setSelection((current) => { const next = new Set(current); next.delete(item.id); return next })
    setDetail((current) => current?.id === item.id ? null : current)
    toast({ title: t('development.icons.common.delete'), tone: 'success' })
  }, [toast])

  const copySvg = useCallback(async (item: IconAssetSummary) => {
    const response = await fetch(item.rawUrl)
    if (!response.ok) throw new Error(t('development.icons.grid.error'))
    await copyText(await response.text())
    toast({ title: t('development.icons.card.copy'), tone: 'success' })
  }, [toast])

  const openDetail = useCallback(async (item: IconAssetSummary) => {
    try {
      const response = await fetch(item.rawUrl)
      const body = response.ok ? await response.text() : ''
      setDetail({
        ...item,
        mime: item.format === 'svg' ? 'image/svg+xml' : `image/${item.format}`,
        viewBox: null,
        keywords: '',
        license: '',
        sourceUrl: '',
        sanitized: item.format === 'svg',
        createdAt: item.updatedAt,
        useCount: 0,
        lastUsedAt: null,
        ...(body ? {} : {}),
      })
    } catch {
      setDetail({
        ...item,
        mime: item.format === 'svg' ? 'image/svg+xml' : `image/${item.format}`,
        viewBox: null,
        keywords: '',
        license: '',
        sourceUrl: '',
        sanitized: false,
        createdAt: item.updatedAt,
        useCount: 0,
        lastUsedAt: null,
      })
    }
  }, [])

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    let done = 0
    let failed = 0
    for (const file of list) {
      try {
        const result = await uploadAsset(file, collectionId || undefined)
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
  }, [collectionId, refresh, toast])

  const startConvert = useCallback(async (kind: 'png' | 'ico' | 'sprite_svg' | 'sprite_png', sizes: number[]) => {
    const ids = [...(selection.size ? selection : new Set(items.slice(0, 20).map((item) => item.id)))]
    if (!ids.length) return
    const options = kind === 'png' || kind === 'ico'
      ? { kind, sizes: kind === 'png' ? sizes.filter((size) => ICON_PNG_PRESETS.includes(size as never)) : sizes }
      : kind === 'sprite_svg'
        ? { kind, padding: 2 }
        : { kind, padding: 2, scales: [1], scss: false }
    await createJob(ids, options)
    setConvertOpen(false)
    toast({ title: t('development.icons.job.queued'), tone: 'default' })
  }, [items, selection, toast])

  const counts = bootstrap?.counts
  const title = stateView === 'all' && !collectionId && !tagId
    ? t('development.icons.sidebar.all')
    : stateView === 'favorites'
      ? t('development.icons.sidebar.favorites')
      : stateView === 'pinned'
        ? t('development.icons.sidebar.pinned')
        : stateView === 'recent'
          ? t('development.icons.sidebar.recent')
          : stateView === 'uncategorized'
            ? t('development.icons.sidebar.uncategorized')
            : currentCollection?.name ?? tagTree.find((tag) => tag.id === tagId)?.name ?? t('development.icons.sidebar.all')

  if (!bootstrap && loading) return <LoadingBlock label={t('development.icons.grid.loading')} />

  return (
    <div data-testid="icons-app-root" className="flex h-full min-h-0 w-full overflow-hidden bg-[var(--bg-base)]">
      {showSidebar && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
          <div className="flex h-11 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
            <ImageIcon size={16} className="text-[var(--text-secondary)]" />
            <h2 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('development.icons.sidebar.title')}</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {[
              ['all', t('development.icons.sidebar.all'), counts?.all],
              ['favorites', t('development.icons.sidebar.favorites'), counts?.favorites],
              ['pinned', t('development.icons.sidebar.pinned'), counts?.pinned],
              ['recent', t('development.icons.sidebar.recent'), counts?.recent],
              ['uncategorized', t('development.icons.sidebar.uncategorized'), counts?.uncategorized],
            ].map(([id, label, count]) => (
              <button
                key={String(id)}
                type="button"
                onClick={() => { setStateView(id as typeof stateView); setCollectionId(''); setTagId('') }}
                className={cn('flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left text-[length:var(--text-12)]', stateView === id && !collectionId && !tagId ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
              >
                <span className="truncate">{String(label)}</span>
                <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">{count ?? 0}</span>
              </button>
            ))}
            <div className="my-2 border-t border-[var(--border-subtle)]" />
            <div className="flex items-center gap-1 px-2 pb-1">
              <span className="text-[length:var(--text-10)] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">{t('development.icons.sidebar.collections')}</span>
              <IconButton label={t('development.icons.sidebar.new_collection')} size="sm" className="ml-auto h-6 w-6" onClick={() => setCollectionOpen(true)}><Plus size={12} /></IconButton>
            </div>
            {(bootstrap?.collections ?? []).map((collection) => (
              <button
                key={collection.id}
                type="button"
                onClick={() => { setCollectionId(collection.id); setStateView('all'); setTagId('') }}
                className={cn('flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left text-[length:var(--text-12)]', collectionId === collection.id ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
              >
                <span className="truncate">{collection.name}</span>
                <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">{counts?.collections[collection.id] ?? 0}</span>
              </button>
            ))}
            <div className="my-2 border-t border-[var(--border-subtle)]" />
            <div className="flex items-center gap-1 px-2 pb-1">
              <TagIcon size={12} className="text-[var(--text-tertiary)]" />
              <span className="text-[length:var(--text-10)] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">{t('development.icons.sidebar.tags')}</span>
              <IconButton label={t('development.icons.sidebar.manage_tags')} size="sm" className="ml-auto h-6 w-6" onClick={() => setTagOpen(true)}><Settings2 size={12} /></IconButton>
            </div>
            {tagTree.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => { setTagId(tag.id); setStateView('all'); setCollectionId('') }}
                className={cn('flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left text-[length:var(--text-12)]', tagId === tag.id ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                <span className="truncate">{tag.name}</span>
                <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">{counts?.tags[tag.id] ?? 0}</span>
              </button>
            ))}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-11 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
          <div className="min-w-[160px] flex-1"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('development.icons.search.placeholder')} aria-label={t('development.icons.search.placeholder')} className="h-9" /></div>
          <SelectMenu
            label={t('development.icons.toolbar.format')}
            value={format}
            onChange={(value) => setFormat(value as IconFormat | '')}
            options={[{ value: '', label: t('development.icons.toolbar.all_formats') }, { value: 'svg', label: 'SVG' }, { value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }]}
            size="sm"
          />
          <SelectMenu
            label={t('development.icons.toolbar.sort')}
            value={sort}
            onChange={(value) => setSort(value as typeof sort)}
            options={[
              { value: 'created', label: t('development.icons.toolbar.sort.created') },
              { value: 'updated', label: t('development.icons.toolbar.sort.updated') },
              { value: 'name', label: t('development.icons.toolbar.sort.name') },
              { value: 'used', label: t('development.icons.toolbar.sort.used') },
            ]}
            size="sm"
          />
          <Segmented value={view} onChange={setView} options={[{ value: 'grid', label: t('development.icons.toolbar.view.grid') }, { value: 'list', label: t('development.icons.toolbar.view.list') }]} size="sm" />
          <SelectMenu
            label={t('development.icons.toolbar.density')}
            value={density}
            onChange={(value) => setDensity(value as Density)}
            options={(Object.keys(DENSITY) as Density[]).map((id) => ({ value: id, label: t(DENSITY[id].label as never) }))}
            size="sm"
          />
          <Button size="sm" variant="secondary" onClick={() => setUploadOpen(true)}><Upload size={14} />{t('development.icons.toolbar.upload')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setConvertOpen(true)} disabled={!items.length}>{t('development.icons.toolbar.convert')}</Button>
          <IconButton label={t('development.icons.toolbar.settings')} size="sm" onClick={() => setSettingsOpen(true)}><Settings2 size={14} /></IconButton>
        </header>

        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span className="truncate">{title}</span>
          <span>{items.length}{hasMore ? '+' : ''}</span>
          {selection.size > 0 && (
            <span className="ml-auto flex items-center gap-2 text-[var(--text-secondary)]">
              <span>{selection.size}</span>
              <Button size="sm" variant="secondary" onClick={() => void batchAssets('delete', [...selection]).then(() => refresh())}>{t('development.icons.common.delete')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>{t('development.icons.common.cancel')}</Button>
            </span>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-[var(--danger-soft)] px-4 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
            <AlertCircle size={14} />
            <span>{error}</span>
            <Button size="sm" variant="ghost" onClick={() => void load(true)}>{t('development.icons.grid.retry')}</Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div className={cn('grid gap-2', view === 'list' ? 'grid-cols-1' : 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8')}>
              {Array.from({ length: 18 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-[var(--r-md)]" />)}
            </div>
          ) : items.length === 0 ? (
            <Empty art="notes" title={t('development.icons.grid.empty.title')} description={t('development.icons.grid.empty.description')} action={<Button size="sm" onClick={() => setUploadOpen(true)}><Upload size={14} />{t('development.icons.toolbar.upload')}</Button>} />
          ) : view === 'grid' ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
              {items.map((item) => (
                <div key={item.id} className="group relative flex flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] transition-colors hover:border-[var(--border-default)]" style={{ minHeight: DENSITY[density].height }}>
                  <button type="button" className="flex flex-1 items-center justify-center p-2" onClick={() => void openDetail(item)} aria-label={`${t('development.icons.card.open')} ${item.name}`}>
                    <img src={item.thumbUrl} alt={item.name} loading="lazy" decoding="async" className="max-h-16 max-w-full object-contain" />
                  </button>
                  <div className="flex items-center gap-1 border-t border-[var(--border-subtle)] px-2 py-1">
                    <span className="truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">{item.name}</span>
                    <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <IconButton label={item.favorited ? t('development.icons.card.unfavorite') : t('development.icons.card.favorite')} size="sm" className="h-6 w-6" onClick={() => void toggleFavorite(item)}><Star size={12} className={item.favorited ? 'fill-current text-[var(--warning)]' : ''} /></IconButton>
                      <IconButton label={item.pinned ? t('development.icons.card.unpin') : t('development.icons.card.pin')} size="sm" className="h-6 w-6" onClick={() => void togglePinned(item)}><Pin size={12} /></IconButton>
                      <IconButton label={t('development.icons.card.copy')} size="sm" className="h-6 w-6" onClick={() => void copySvg(item).catch((cause) => toast({ title: message(cause), tone: 'danger' }))}><Copy size={12} /></IconButton>
                    </span>
                  </div>
                  <Checkbox checked={selection.has(item.id)} onChange={(checked) => setSelection((current) => { const next = new Set(current); if (checked) next.add(item.id); else next.delete(item.id); return next })} className="absolute left-1 top-1" label="" />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {items.map((item) => (
                <div key={item.id} className="group flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                  <img src={item.thumbUrl} alt="" className="h-8 w-8 object-contain" loading="lazy" />
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)]" onClick={() => void openDetail(item)}>{item.name}</button>
                  <span className="text-[length:var(--text-10)] uppercase text-[var(--text-tertiary)]">{item.format}</span>
                  <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{formatBytes(item.bytes)}</span>
                  <IconButton label={t('development.icons.card.favorite')} size="sm" onClick={() => void toggleFavorite(item)}><Star size={12} className={item.favorited ? 'fill-current text-[var(--warning)]' : ''} /></IconButton>
                  <IconButton label={t('development.icons.card.pin')} size="sm" onClick={() => void togglePinned(item)}><Pin size={12} /></IconButton>
                  <IconButton label={t('development.icons.card.copy')} size="sm" onClick={() => void copySvg(item)}><Copy size={12} /></IconButton>
                  <a href={item.rawUrl} download={`${item.name}.${item.format}`} aria-label={t('development.icons.card.download')} className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Download size={12} /></a>
                  <IconButton label={t('development.icons.common.delete')} size="sm" onClick={() => void remove(item)}><Trash2 size={12} /></IconButton>
                </div>
              ))}
            </div>
          )}
          {hasMore && (
            <div className="flex justify-center py-3">
              <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void load(false)}>{loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}{t('development.icons.grid.load_more')}</Button>
            </div>
          )}
        </div>
      </div>

      <Drawer open={Boolean(detail)} onClose={() => setDetail(null)} side="right" width={420} title={t('development.icons.detail.title')} ariaLabel={t('development.icons.detail.title')}>
        {detail && (
          <div className="space-y-4 p-4">
            <div className="flex h-40 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
              <img src={detail.thumbUrl} alt={detail.name} className="max-h-32 max-w-full object-contain" />
            </div>
            <div>
              <div className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{detail.name}</div>
              <div className="mt-1 grid grid-cols-2 gap-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                <span>{t('development.icons.detail.format')}: {detail.format.toUpperCase()}</span>
                <span>{t('development.icons.detail.size')}: {detail.width ?? '-'} × {detail.height ?? '-'}</span>
                <span>{t('development.icons.detail.bytes')}: {formatBytes(detail.bytes)}</span>
                <span className="truncate" title={detail.sha256}>{t('development.icons.detail.hash')}: {detail.sha256.slice(0, 12)}</span>
                <span>{t('development.icons.detail.collection')}: {bootstrap?.collections.find((item) => item.id === detail.collectionId)?.name ?? '-'}</span>
                <span>{t('development.icons.detail.license')}: {detail.license || '-'}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copySvg(detail).catch((cause) => toast({ title: message(cause), tone: 'danger' }))}><Copy size={14} />{t('development.icons.detail.copy.svg')}</Button>
              <a href={detail.rawUrl} download={`${detail.name}.${detail.format}`} className="inline-flex h-8 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Download size={14} />{t('development.icons.detail.download.svg')}</a>
              <Button size="sm" variant={detail.favorited ? 'primary' : 'secondary'} onClick={() => void toggleFavorite(detail)}><Star size={14} />{detail.favorited ? t('development.icons.card.unfavorite') : t('development.icons.card.favorite')}</Button>
              <Button size="sm" variant={detail.pinned ? 'primary' : 'secondary'} onClick={() => void togglePinned(detail)}><Pin size={14} />{detail.pinned ? t('development.icons.card.unpin') : t('development.icons.card.pin')}</Button>
              <Button size="sm" variant="secondary" onClick={() => void remove(detail)}><Trash2 size={14} />{t('development.icons.common.delete')}</Button>
            </div>
            <div className="space-y-1">
              <div className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('development.icons.detail.tags')}</div>
              <div className="flex flex-wrap gap-1">
                {detail.tags.length === 0 && <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">-</span>}
                {detail.tags.map((tag) => <span key={tag.id} className="rounded-[var(--r-full)] border border-[var(--border-subtle)] px-2 py-0.5 text-[length:var(--text-10)]" style={{ borderColor: tag.color }}>{tag.name}</span>)}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onFiles={uploadFiles} collections={bootstrap?.collections ?? []} collectionId={collectionId} onCollection={setCollectionId} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSaved={(next) => { setSettings(next); setSettingsOpen(false); void refresh() }} />
      <SimpleCreateDialog open={tagOpen} title={t('development.icons.tag.title')} nameLabel={t('development.icons.tag.name')} onClose={() => setTagOpen(false)} onCreate={async (name) => { await createTag({ name, color: '#64748b', parentId: null, sortOrder: 0 }); setTagOpen(false); await refresh() }} />
      <SimpleCreateDialog open={collectionOpen} title={t('development.icons.collection.title')} nameLabel={t('development.icons.collection.name')} onClose={() => setCollectionOpen(false)} onCreate={async (name) => { await createCollection({ name, description: '', source: 'upload', license: '', homepage: '', sortOrder: 0 }); setCollectionOpen(false); await refresh() }} />
      <ConvertDialog open={convertOpen} onClose={() => setConvertOpen(false)} onStart={startConvert} />
    </div>
  )
}

function UploadDialog({ open, onClose, onFiles, collections, collectionId, onCollection }: { open: boolean; onClose: () => void; onFiles: (files: FileList | File[]) => Promise<void>; collections: IconCollection[]; collectionId: string; onCollection: (id: string) => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.upload.title')} width={520}>
      <div className="space-y-3">
        <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] p-4 text-center text-[length:var(--text-12)] text-[var(--text-secondary)]">
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

function SettingsDialog({ open, onClose, settings, onSaved }: { open: boolean; onClose: () => void; settings: IconSettings | null; onSaved: (settings: IconSettings) => void }) {
  const [draft, setDraft] = useState<IconSettings | null>(settings)
  useEffect(() => { setDraft(settings) }, [settings])
  if (!draft) return null
  const field = (label: string, key: keyof IconSettings) => (
    <label className="flex items-center justify-between gap-3 text-[length:var(--text-12)]">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <Input value={String(draft[key])} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) || 0 })} type="number" aria-label={label} className="w-32" />
    </label>
  )
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.settings.title')} width={460}>
      <div className="space-y-2">
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
      </div>
    </Modal>
  )
}

function SimpleCreateDialog({ open, title, nameLabel, onClose, onCreate }: { open: boolean; title: string; nameLabel: string; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  return (
    <Modal open={open} onClose={onClose} title={title} width={420}>
      <div className="space-y-3">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={nameLabel} aria-label={nameLabel} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('development.icons.common.cancel')}</Button>
          <Button disabled={!name.trim()} onClick={() => void onCreate(name.trim()).then(() => setName(''))}>{t('development.icons.common.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}

function ConvertDialog({ open, onClose, onStart }: { open: boolean; onClose: () => void; onStart: (kind: 'png' | 'ico' | 'sprite_svg' | 'sprite_png', sizes: number[]) => Promise<void> }) {
  const [kind, setKind] = useState<'png' | 'ico' | 'sprite_svg' | 'sprite_png'>('png')
  const [sizes, setSizes] = useState<number[]>([24, 48, 96, 192, 512])
  const [padding, setPadding] = useState(2)
  const toggle = (size: number) => setSizes((current) => current.includes(size) ? current.filter((value) => value !== size) : [...current, size].sort((a, b) => a - b))
  return (
    <Modal open={open} onClose={onClose} title={t('development.icons.convert.title')} width={440}>
      <div className="space-y-3">
        <SelectMenu label={t('development.icons.convert.kind')} value={kind} onChange={(value) => { setKind(value as typeof kind); setSizes(value === 'ico' ? [16, 32, 48, 256] : [24, 48, 96, 192, 512]) }} options={[
          { value: 'png', label: t('development.icons.convert.png') },
          { value: 'ico', label: t('development.icons.convert.ico') },
          { value: 'sprite_svg', label: t('development.icons.convert.sprite_svg') },
          { value: 'sprite_png', label: t('development.icons.convert.sprite_png') },
        ]} />
        {(kind === 'png' || kind === 'ico') && (
          <div className="flex flex-wrap gap-2">
            {(kind === 'png' ? ICON_PNG_PRESETS : [16, 32, 48, 256]).map((size) => (
              <label key={size} className="flex items-center gap-1 text-[length:var(--text-12)]"><Checkbox checked={sizes.includes(size)} onChange={() => toggle(size)} label="" />{size}</label>
            ))}
          </div>
        )}
        {(kind === 'sprite_svg' || kind === 'sprite_png') && <Slider value={padding} min={0} max={32} onChange={setPadding} label={t('development.icons.convert.padding')} suffix="px" />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('development.icons.common.cancel')}</Button>
          <Button disabled={!sizes.length} onClick={() => void onStart(kind, sizes)}>{t('development.icons.convert.start')}</Button>
        </div>
      </div>
    </Modal>
  )
}
