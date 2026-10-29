import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, LayoutGrid, Play, RefreshCw, X } from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { navigateToPath } from '../../../lib/app-history'
import { localeTag, useLocale } from '../../../lib/i18n'
import { formatBytes } from '../../../lib/time'
import { cn } from '../../../lib/cn'
import { useUi } from '../../../store/ui'
import { clouddriveApi, cloudDriveErrorKey } from '../api'
import { ct, type CloudDriveMessageKey } from '../media-i18n'
import { useTransferStore } from '../transfers/useTransferStore'
import { MediaViewer } from './MediaViewer'

export interface AlbumPageProps {
  /** The shell decides where the empty-state action goes; the standalone default is the files page. */
  onOpenFiles?(): void
}

interface MonthGroup {
  key: string
  label: string
  entries: CloudDriveEntry[]
}

function mergeEntries(current: CloudDriveEntry[], next: CloudDriveEntry[]): CloudDriveEntry[] {
  const seen = new Set(current.map((entry) => entry.id))
  return [...current, ...next.filter((entry) => !seen.has(entry.id))]
}

function monthKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(key: string, formatter: Intl.DateTimeFormat): string {
  const [year, month] = key.split('-').map(Number)
  if (!year || !month) return key
  return formatter.format(new Date(year, month - 1, 1))
}

function describeError(error: unknown): string {
  return ct(cloudDriveErrorKey(error) as CloudDriveMessageKey)
}

/**
 * "All media" smart view over the primary mount: cursor paging from `/album`, grouped by the local
 * month, with a selection mode for batch downloads and a full-screen viewer on the same entries.
 */
export function AlbumPage({ onOpenFiles }: AlbumPageProps) {
  const locale = useLocale()
  const toast = useUi((state) => state.toast)
  const enqueueDownload = useTransferStore((state) => state.enqueueDownload)

  const [entries, setEntries] = useState<CloudDriveEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)

  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(localeTag(), { year: 'numeric', month: 'long' }),
    [locale],
  )

  const load = useCallback(async () => {
    const sequence = ++requestRef.current
    setStatus('loading')
    setError(null)
    setMore('idle')
    try {
      const result = await clouddriveApi.album()
      if (sequence !== requestRef.current) return
      setEntries(result.groups.flatMap((group) => group.files))
      setCursor(result.cursor)
      setStatus('ready')
    } catch (caught) {
      if (sequence !== requestRef.current) return
      setError(describeError(caught))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadMore = useCallback(async () => {
    if (!cursor || more === 'loading') return
    setMore('loading')
    try {
      const result = await clouddriveApi.album(cursor)
      setEntries((current) => mergeEntries(current, result.groups.flatMap((group) => group.files)))
      setCursor(result.cursor)
      setMore('idle')
    } catch (caught) {
      setMore('error')
      toast({ title: ct('clouddrive.album.load_more_failed'), description: describeError(caught), tone: 'danger' })
    }
  }, [cursor, more, toast])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !cursor || status !== 'ready' || more === 'error') return
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) void loadMore()
    }, { rootMargin: '700px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, loadMore, more, status])

  useEffect(() => {
    const ids = new Set(entries.map((entry) => entry.id))
    setSelected((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  }, [entries])

  const months = useMemo<MonthGroup[]>(() => {
    const groups: MonthGroup[] = []
    for (const entry of entries) {
      const key = monthKey(entry.uploadedAt)
      const last = groups[groups.length - 1]
      if (last?.key === key) last.entries.push(entry)
      else groups.push({ key, label: monthLabel(key, monthFormatter), entries: [entry] })
    }
    return groups
  }, [entries, monthFormatter])

  const toggleSelecting = useCallback(() => {
    if (selecting) setSelected(new Set())
    setSelecting(!selecting)
  }, [selecting])

  const toggleEntry = useCallback((entry: CloudDriveEntry) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => setSelected(new Set(entries.map((entry) => entry.id))), [entries])

  const downloadSelected = useCallback(() => {
    let count = 0
    for (const entry of entries) {
      if (!selected.has(entry.id)) continue
      enqueueDownload(entry)
      count += 1
    }
    if (count > 0) toast({ title: ct('clouddrive.album.download_queued', { count }) })
  }, [enqueueDownload, entries, selected, toast])

  const openFiles = useCallback(() => {
    if (onOpenFiles) onOpenFiles()
    else navigateToPath('/clouddrive')
  }, [onOpenFiles])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2">
        <span className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
          <LayoutGrid size={15} aria-hidden />
        </span>
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{ct('clouddrive.nav.album')}</h1>
        {entries.length > 0 && (
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.status.items', { count: entries.length })}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {entries.length > 0 && (
            <Button size="sm" variant={selecting ? 'primary' : 'secondary'} onClick={toggleSelecting} aria-pressed={selecting}>
              {ct('clouddrive.album.select')}
            </Button>
          )}
          <IconButton label={ct('clouddrive.toolbar.refresh')} onClick={() => void load()}>
            <RefreshCw size={15} className={status === 'loading' ? 'animate-spin' : undefined} />
          </IconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {status === 'loading' && (
          <div role="status" aria-live="polite" className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            <span className="sr-only">{ct('clouddrive.loading')}</span>
            {Array.from({ length: 12 }, (_, index) => (
              <div key={index} className="aspect-square animate-pulse rounded-[var(--r-md)] bg-[var(--bg-hover)]" />
            ))}
          </div>
        )}

        {status === 'error' && (
          <div role="alert" className="flex min-h-[240px] flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertTriangle size={24} className="text-[var(--danger)]" aria-hidden />
            <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{ct('clouddrive.failed')}</p>
            {error && <p className="max-w-[420px] text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error}</p>}
            <Button variant="secondary" onClick={() => void load()}>{ct('clouddrive.retry')}</Button>
          </div>
        )}

        {status === 'ready' && entries.length === 0 && (
          <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 p-6 text-center">
            <LayoutGrid size={28} className="text-[var(--text-tertiary)]" aria-hidden />
            <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{ct('clouddrive.album.empty')}</p>
            <p className="max-w-[300px] text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.album.empty_hint')}</p>
            <Button size="sm" variant="secondary" onClick={openFiles}>{ct('clouddrive.album.open_files')}</Button>
          </div>
        )}

        {status === 'ready' && entries.length > 0 && (
          <>
            <div className="flex flex-col gap-4">
              {months.map((group) => (
                <section key={group.key} aria-labelledby={`cd-album-${group.key}`}>
                  <h2 id={`cd-album-${group.key}`} className="mb-2 px-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
                    {ct('clouddrive.album.month_count', { month: group.label, count: group.entries.length })}
                  </h2>
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                    {group.entries.map((entry) => (
                      <MediaTile
                        key={entry.id}
                        entry={entry}
                        selecting={selecting}
                        selected={selected.has(entry.id)}
                        onOpen={() => {
                          const index = entries.findIndex((candidate) => candidate.id === entry.id)
                          if (index >= 0) setViewerIndex(index)
                        }}
                        onToggle={() => toggleEntry(entry)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>

            <div ref={sentinelRef} className="flex min-h-[44px] items-center justify-center py-3" aria-hidden={more !== 'error' ? true : undefined}>
              {more === 'loading' && (
                <span className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <Spinner size={12} /> {ct('clouddrive.album.load_more')}
                </span>
              )}
              {more === 'error' && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  className="inline-flex min-h-10 items-center rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--accent)] hover:bg-[var(--bg-hover)]"
                >
                  {ct('clouddrive.album.load_more_failed')} · {ct('clouddrive.retry')}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {selecting && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-2">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {ct('clouddrive.selection.count', { count: selected.size })}
          </span>
          <Button size="sm" variant="secondary" onClick={selectAll}>{ct('clouddrive.album.select_all')}</Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Download size={13} />}
            disabled={selected.size === 0}
            onClick={downloadSelected}
          >
            {ct('clouddrive.album.download_selected')}
          </Button>
          <IconButton label={ct('clouddrive.album.clear_selection')} onClick={() => setSelected(new Set())}>
            <X size={15} />
          </IconButton>
        </div>
      )}

      <MediaViewer
        open={viewerIndex !== null}
        entries={entries}
        index={viewerIndex ?? 0}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
        onDownload={(entry) => {
          enqueueDownload(entry)
          toast({ title: ct('clouddrive.album.download_queued', { count: 1 }) })
        }}
      />
    </div>
  )
}

function MediaTile({ entry, selecting, selected, onOpen, onToggle }: {
  entry: CloudDriveEntry
  selecting: boolean
  selected: boolean
  onOpen(): void
  onToggle(): void
}) {
  const [stage, setStage] = useState<'thumbnail' | 'content' | 'failed'>('thumbnail')
  const isVideo = entry.category === 'videos' || entry.mime.startsWith('video/')
  const src = stage === 'thumbnail' ? clouddriveApi.thumbnailUrl(entry.id, 320) : clouddriveApi.contentUrl(entry.id)

  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-label={ct('clouddrive.album.open_item', { name: entry.name })}
        aria-pressed={selecting ? selected : undefined}
        onClick={selecting ? onToggle : onOpen}
        className={cn(
          'group flex w-full min-w-0 flex-col overflow-hidden rounded-[var(--r-md)] border bg-[var(--bg-surface)] text-left',
          'transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-strong)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
          selected ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)]',
        )}
      >
        <span className="relative block aspect-square w-full overflow-hidden bg-[var(--bg-inset)]">
          {isVideo ? (
            <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
              <Play size={26} aria-hidden />
              <span className="text-[length:var(--text-10)]">{ct('clouddrive.album.video')}</span>
            </span>
          ) : stage === 'failed' ? (
            <span className="flex h-full w-full items-center justify-center text-[var(--text-quaternary)]">
              <LayoutGrid size={22} aria-hidden />
            </span>
          ) : (
            <img
              src={src}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setStage((current) => (current === 'thumbnail' ? 'content' : 'failed'))}
              className="h-full w-full object-cover transition-transform duration-[var(--dur-base)] group-hover:scale-[1.02]"
            />
          )}
          {selecting && (
            <span
              className={cn(
                'absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-[5px] border',
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'border-[var(--border-strong)] bg-[var(--bg-overlay)]/90 text-transparent',
              )}
              aria-hidden
            >
              <Check size={12} strokeWidth={3} />
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-primary)]">{entry.name}</span>
          <span className="shrink-0 text-[length:var(--text-10)] tabular text-[var(--text-quaternary)]">{formatBytes(entry.size)}</span>
        </span>
      </button>
    </li>
  )
}
