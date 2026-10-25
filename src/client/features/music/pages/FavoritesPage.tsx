/** The account's favourites: one table, sorting, search and removal with an undo toast. */
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import { Download, Play, Shuffle } from 'lucide-react'
import type { MusicFavoriteTrack, MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Button } from '../../../components/primitives'
import { getLocale } from '../../../lib/i18n'
import { useDebounced } from '../../../lib/hooks'
import { navigateToAddress } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { useMusicQuery } from '../query'
import { musicPathFor } from '../music-address'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { useMusicSettings } from '../store/settings'
import { SongList } from '../components/SongList'
import { MusicSearchField } from '../components/MusicSearchField'
import { M3UActions } from '../components/M3UActions'
import { musicText } from '../components/labels'
import {
  mergeVisibleOrder,
  nextTrackSort,
  orderByManualIds,
  readTrackOrder,
  saveTrackOrder,
  sortTracks,
  type MusicTrackSort,
  type MusicTrackSortKey,
} from '../track-order'
import { PAGE_STACK, QueryError } from './parts/P2QueryState'

const ORDER_KEY = 'inkstone.music.favoriteOrder'

/** One in-flight library load for this page; StrictMode mounts its effect twice. */
let libraryLoad: Promise<void> | null = null

function waitForLibrary(): Promise<void> {
  if (useMusicLibrary.getState().status !== 'loading') return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useMusicLibrary.subscribe((state) => {
      if (state.status === 'loading') return
      unsubscribe()
      resolve()
    })
  })
}

function loadLibrary(): Promise<void> {
  const status = useMusicLibrary.getState().status
  if (status === 'ready') return Promise.resolve()
  if (status === 'loading') return waitForLibrary()
  if (!libraryLoad) {
    libraryLoad = useMusicLibrary.getState().load().finally(() => {
      libraryLoad = null
    })
  }
  return libraryLoad
}

function pinnedFirst(left: MusicFavoriteTrack, right: MusicFavoriteTrack): number {
  return Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt))
}

function matchesKeyword(track: MusicTrack, keyword: string): boolean {
  if (!keyword) return true
  const haystack = `${track.title} ${track.artists.map((artist) => artist.name).join(' ')} ${track.album}`.toLowerCase()
  return haystack.includes(keyword)
}

export function FavoritesPage(): ReactElement {
  const [sort, setSort] = useState<MusicTrackSort | null>(null)
  const [manualOrder, setManualOrder] = useState<string[]>(() => readTrackOrder(ORDER_KEY))
  const [search, setSearch] = useState('')
  const settledSearch = useDebounced(search, 200)
  const [downloading, setDownloading] = useState(false)
  const [renderLimit, setRenderLimit] = useState(200)
  const headingId = useId()
  const favorites = useMusicLibrary((state) => state.favorites)
  const favoritesTotal = useMusicLibrary((state) => state.favoritesTotal)
  const favoritesComplete = useMusicLibrary((state) => state.favoritesComplete)
  const requestDownload = useMusicLibrary((state) => state.requestDownload)
  const settings = useMusicSettings((state) => state.server)

  // The library store is the write authority; this query only drives the initial load and the
  // retry so a removed favourite disappears from every page at once.
  const query = useMusicQuery(async () => {
    await loadLibrary()
    const current = useMusicLibrary.getState()
    if (current.status === 'error') {
      throw new Error(current.errorDetail ?? musicText(current.error ?? 'music.library.error.load'))
    }
    await current.loadAllFavorites()
    return useMusicLibrary.getState().favorites
  }, [])

  const sorted = useMemo(() => {
    const keyword = settledSearch.trim().toLowerCase()
    const filtered = keyword ? favorites.filter((track) => matchesKeyword(track, keyword)) : [...favorites]
    const ordered = sort
      ? sortTracks(filtered, sort, getLocale())
      : manualOrder.length > 0
        ? orderByManualIds(filtered, manualOrder)
        : filtered
    // Pinning is a separate shelf rule: a header sort and a drag both stay inside the pinned block.
    return [...ordered].sort(pinnedFirst)
  }, [favorites, settledSearch, sort, manualOrder])

  const shown = useMemo(() => sorted.slice(0, renderLimit), [sorted, renderLimit])

  useEffect(() => {
    setRenderLimit(200)
  }, [settledSearch, sort])

  const shuffleAll = (): void => {
    if (sorted.length === 0) return
    const shuffled = [...sorted]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!]
    }
    playTrack(shuffled[0]!, shuffled)
  }

  const playAll = (): void => {
    const first = sorted[0]
    if (!first) return
    void useMusicPlayer.getState().playTrack(first, { queue: sorted })
  }

  const downloadable = sorted.filter((track) => track.provider === 'netease')

  const downloadAll = async (): Promise<void> => {
    if (downloadable.length === 0) {
      useUi.getState().toast({ title: musicText('music.favorites.download_none'), tone: 'warning' })
      return
    }
    setDownloading(true)
    try {
      const queue = [...downloadable]
      let started = 0
      let failed = 0
      const workers = Math.min(settings.downloadConcurrency, queue.length)
      await Promise.all(Array.from({ length: workers }, async () => {
        for (;;) {
          const track = queue.shift()
          if (!track) return
          try {
            await requestDownload(track, settings.downloadQuality, settings.downloadFormat)
            started += 1
          } catch {
            failed += 1
          }
        }
      }))
      useUi.getState().toast({
        title: started > 0
          ? musicText('music.favorites.download_started', { count: started })
          : musicText('music.favorites.download_failed'),
        description: failed > 0 && started > 0
          ? musicText('music.favorites.download_partial', { count: failed })
          : undefined,
        tone: started === 0 ? 'danger' : failed > 0 ? 'warning' : 'success',
      })
    } finally {
      setDownloading(false)
    }
  }

  const playTrack = (track: MusicTrack, queue: readonly MusicTrack[]): void => {
    void useMusicPlayer.getState().playTrack(track, { queue })
  }

  const cycleSort = (key: MusicTrackSortKey): void => {
    setSort((current) => nextTrackSort(current, key))
  }

  const applyOrder = (reorderedVisible: string[]): void => {
    const base = sorted.map((track) => track.id)
    const merged = mergeVisibleOrder(
      base,
      shown.map((track) => track.id),
      reorderedVisible,
    )
    setSort(null)
    setManualOrder(merged)
    saveTrackOrder(ORDER_KEY, merged)
  }

  const reorder = (fromId: string, toId: string): void => {
    const fromTrack = shown.find((track) => track.id === fromId)
    const toTrack = shown.find((track) => track.id === toId)
    if (!fromTrack || !toTrack || Boolean(fromTrack.pinnedAt) !== Boolean(toTrack.pinnedAt)) return
    const ids = shown.map((track) => track.id)
    const from = ids.indexOf(fromId)
    const to = ids.indexOf(toId)
    if (from < 0 || to < 0) return
    const next = ids.slice()
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    applyOrder(next)
  }

  const moveTrack = (trackId: string, direction: -1 | 1): void => {
    const ids = shown.map((track) => track.id)
    const index = ids.indexOf(trackId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    if (Boolean(shown[index]?.pinnedAt) !== Boolean(shown[target]?.pinnedAt)) return
    const next = ids.slice()
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    applyOrder(next)
  }

  const resetOrder = (): void => {
    setSort(null)
    setManualOrder([])
    saveTrackOrder(ORDER_KEY, [])
  }

  const clearSearch = (): void => setSearch('')

  const discoverHref = musicPathFor({ kind: 'home' })
  const total = favoritesTotal || favorites.length
  const searching = settledSearch.trim().length > 0

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <header className="music-section-header">
        <div className="music-section-header__text">
          <h1 id={headingId} className="music-section-header__title">
            {musicText('music.page.favorites')}
          </h1>
          <p className="music-section-header__description">
            {musicText('music.favorites.count', { count: total })}
          </p>
        </div>
        <div className="music-favorites__toolbar">
          <M3UActions tracks={sorted} />
          <Button
            variant="secondary"
            icon={<Download size={14} />}
            loading={downloading}
            disabled={downloadable.length === 0}
            onClick={() => {
              void downloadAll()
            }}
          >
            {musicText('music.favorites.download_all')}
          </Button>
          <Button
            variant="secondary"
            icon={<Shuffle size={14} />}
            disabled={sorted.length === 0}
            onClick={shuffleAll}
          >
            {musicText('music.mode.shuffle')}
          </Button>
          <Button
            variant="primary"
            icon={<Play size={14} />}
            disabled={sorted.length === 0}
            onClick={playAll}
          >
            {musicText('music.common.play_all')}
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <MusicSearchField
          value={search}
          onChange={setSearch}
          label={musicText('music.local.filter_placeholder')}
          placeholder={musicText('music.local.filter_placeholder')}
        />
        <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
          {musicText('music.local.filter_count', { shown: sorted.length, total })}
        </span>
        {(sort || manualOrder.length > 0) && (
          <Button size="sm" variant="ghost" onClick={resetOrder}>
            {musicText('music.local.reset_order')}
          </Button>
        )}
      </div>

      {query.status === 'error' && favorites.length > 0 && (
        <QueryError
          title={musicText('music.favorites.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      )}

      {!favoritesComplete && (
        <p role="status" className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {musicText('music.favorites.partial', { loaded: favorites.length, total: favoritesTotal })}
        </p>
      )}

      {query.status === 'loading' && favorites.length === 0 ? (
        <SongList loading onPlay={() => undefined} />
      ) : query.status === 'error' && favorites.length === 0 ? (
        <QueryError
          title={musicText('music.favorites.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : favorites.length === 0 ? (
        <Empty
          art="starred"
          title={musicText('music.favorites.empty')}
          description={musicText('music.favorites.empty_hint')}
          action={(
            <Button variant="primary" onClick={() => navigateToAddress(discoverHref)}>
              {musicText('music.common.discover')}
            </Button>
          )}
        />
      ) : sorted.length === 0 ? (
        <Empty
          art="search"
          compact
          title={musicText('music.local.no_filter_match')}
          description={musicText('music.local.no_filter_hint')}
          action={(
            <Button variant="secondary" onClick={searching ? clearSearch : resetOrder}>
              {searching ? musicText('music.local.clear_filters') : musicText('music.local.reset_order')}
            </Button>
          )}
        />
      ) : (
        <>
          <SongList
            tracks={shown}
            onPlay={playTrack}
            columns={{ source: true, size: true }}
            sort={sort}
            onSort={cycleSort}
            reorderable
            onReorder={reorder}
            onMoveTrack={moveTrack}
          />
          {shown.length < sorted.length && (
            <Button
              variant="secondary"
              onClick={() => setRenderLimit((limit) => limit + 200)}
            >
              {musicText('music.favorites.load_more', { count: sorted.length - shown.length })}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
