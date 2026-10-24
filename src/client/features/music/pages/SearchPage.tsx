/**
 * Search: the box, the two lists that make an empty box useful, and one result panel per kind.
 *
 * The address owns the term. Typing replaces `?q=` after a 250 ms pause — a press of back after three
 * keystrokes must not land in the editor one character ago — while Enter, a hot word or a history row
 * commit immediately and record the term in the device's history. Results are always fetched for the
 * committed term, never for the half-typed one.
 *
 * The five result kinds share the page state but not a shape: songs are rows, everything else is a
 * card grid. Both keep the same Play and card semantics as the pages they open.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Search, X } from 'lucide-react'
import { formatDuration } from '@shared/music/format'
import { MUSIC_SEARCH_TYPES, type MusicSearchType } from '@shared/music/model'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { Empty, Skeleton } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { navigateToAddress, replaceAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { MusicSearchBox } from '../components/MusicSearchBox'
import { MusicTabs } from '../components/Tabs'
import { Pager } from '../components/Pager'
import { SectionHeader } from '../components/SectionHeader'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { useMusicUi } from '../store/ui'
import { CardGridSkeleton, MusicCard } from './parts/MediaCards'
import { MusicPageBody, PageError, TrackListSkeleton } from './parts/PageState'
import { playTracks } from './parts/playback'

const DEBOUNCE_MS = 250
const PAGE_SIZE = 30

const SEARCH_TYPE_KEYS: Record<MusicSearchType, string> = {
  song: 'music.search.type.song',
  album: 'music.search.type.album',
  playlist: 'music.search.type.playlist',
  mv: 'music.search.type.mv',
  radio: 'music.search.type.radio',
}

function HotSearchesSkeleton(): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={musicText('common.loading')}
      className="flex flex-wrap gap-2"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-8 w-24 rounded-full" />
      ))}
    </div>
  )
}

export interface SearchPageProps {
  query: string
}

export function SearchPage({ query }: SearchPageProps): ReactElement {
  const [text, setText] = useState(query)
  const [term, setTerm] = useState(query.trim())
  const [type, setType] = useState<MusicSearchType>('song')
  const [page, setPage] = useState(1)
  /** The trimmed term whose address this box wrote last, so its own address echo cannot reset typing. */
  const addressed = useRef(query.trim())
  const hotId = useId()
  const historyId = useId()
  const history = useMusicUi((state) => state.searchHistory)
  const pushSearchHistory = useMusicUi((state) => state.pushSearchHistory)
  const removeSearchHistory = useMusicUi((state) => state.removeSearchHistory)
  const clearSearchHistory = useMusicUi((state) => state.clearSearchHistory)
  const searching = term.length > 0
  const hot = useMusicQuery(() => musicApi.hot(), [], { enabled: !searching })
  const resultQuery = useMusicQuery(
    () => musicApi.search(type, term, page, PAGE_SIZE),
    [term, type, page],
    { enabled: searching },
  )

  // Back/forward and a pasted link are the only writers of `query` the box did not produce itself.
  // The ref comparison is what keeps this effect from clipping the character a reader types between
  // the debounce's address write and the render that answers it.
  useEffect(() => {
    const next = query.trim()
    if (next === addressed.current) return
    addressed.current = next
    setText(query)
    setTerm(next)
    setPage(1)
  }, [query])

  useEffect(() => {
    const next = text.trim()
    if (next === term) return
    const timer = window.setTimeout(() => {
      addressed.current = next
      setTerm(next)
      setPage(1)
      replaceAddress('/music/search', next ? `q=${encodeURIComponent(next)}` : '')
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text, term])

  const applyTerm = useCallback((value: string, remember: boolean): void => {
    const next = value.trim()
    addressed.current = next
    setText(next)
    setTerm(next)
    setPage(1)
    replaceAddress('/music/search', next ? `q=${encodeURIComponent(next)}` : '')
    if (remember && next) pushSearchHistory(next)
  }, [pushSearchHistory])

  const clearHistory = (): void => {
    void confirm({
      title: musicText('music.search.history.clear_title'),
      description: musicText('music.search.history.clear_description'),
      confirmLabel: musicText('music.search.history.clear'),
      tone: 'danger',
    }).then((accepted) => {
      if (accepted) clearSearchHistory()
    })
  }

  const hotItems = hot.data?.items ?? []
  const hotLoading = hot.status === 'idle' || hot.status === 'loading'
  const result = resultQuery.data?.type === type ? resultQuery.data : null
  const searchingIdle = resultQuery.status === 'idle'
  const resultLabel = musicText(SEARCH_TYPE_KEYS[type])

  const noResults = (
    <Empty
      art="search"
      title={musicText('music.search.no_results.title')}
      description={musicText('music.search.no_results.description', { query: term })}
      action={(
        <Button variant="secondary" onClick={() => applyTerm('', false)}>
          {musicText('music.search.clear')}
        </Button>
      )}
    />
  )

  const renderCards = (): ReactElement => {
    if (!result) return <CardGridSkeleton />
    const hasError = resultQuery.status === 'error'
    const errorBar = hasError ? (
      <PageError compact error={resultQuery.error} onRetry={resultQuery.reload} />
    ) : null

    if (type === 'song') {
      if (result.tracks.length === 0) return noResults
      return (
        <>
          {errorBar}
          <SongList
            tracks={result.tracks}
            onPlay={(track, queue) => playTracks(queue, track)}
          />
        </>
      )
    }

    if (type === 'album') {
      if (result.albums.length === 0) return noResults
      return (
        <>
          {errorBar}
          <div className="music-card-grid">
            {result.albums.map((item) => (
              <MusicCard
                key={item.id}
                coverSrc={item.coverUrl}
                title={item.name}
                meta={item.artists.join(' / ') || musicText('music.common.track_count', { count: item.trackCount })}
                onOpen={() => navigateToAddress(musicPathFor({ kind: 'album', id: item.id }))}
              />
            ))}
          </div>
        </>
      )
    }

    if (type === 'playlist') {
      if (result.playlists.length === 0) return noResults
      return (
        <>
          {errorBar}
          <div className="music-card-grid">
            {result.playlists.map((item) => (
              <MusicCard
                key={item.id}
                coverSrc={item.coverUrl}
                title={item.name}
                meta={item.creator || musicText('music.common.track_count', { count: item.trackCount })}
                onOpen={() => navigateToAddress(musicPathFor({ kind: 'playlist', id: item.id }))}
              />
            ))}
          </div>
        </>
      )
    }

    if (type === 'mv') {
      if (result.mvs.length === 0) return noResults
      return (
        <>
          {errorBar}
          <div className="music-card-grid">
            {result.mvs.map((item) => (
              <MusicCard
                key={item.id}
                coverSrc={item.coverUrl}
                title={item.name}
                meta={item.artist}
                badge={<Badge>{formatDuration(item.durationMs)}</Badge>}
                onOpen={() => navigateToAddress(musicPathFor({ kind: 'mvDetail', id: item.id }))}
              />
            ))}
          </div>
        </>
      )
    }

    if (result.radios.length === 0) return noResults
    return (
      <>
        {errorBar}
        <div className="music-card-grid">
          {result.radios.map((item) => (
            <MusicCard
              key={item.id}
              coverSrc={item.coverUrl}
              title={item.name}
              meta={musicText('music.search.radio_programs', { count: item.programCount })}
              onOpen={() => navigateToAddress(musicPathFor({ kind: 'podcastDetail', id: item.id }))}
            />
          ))}
        </div>
      </>
    )
  }

  const loadingSkeleton = type === 'song' ? <TrackListSkeleton /> : <CardGridSkeleton />

  const renderResults = (): ReactElement => {
    if (searchingIdle || resultQuery.status === 'loading') return loadingSkeleton
    if (resultQuery.status === 'error' && !result) {
      return <PageError error={resultQuery.error} onRetry={resultQuery.reload} />
    }
    if (!result) return loadingSkeleton

    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
    return (
      <>
        {renderCards()}
        <Pager page={page} pageCount={totalPages} onChange={setPage} />
      </>
    )
  }

  return (
    <MusicPageBody>
      <h1 className="sr-only">{musicText('music.page.search')}</h1>

      <form
        role="search"
        className="flex flex-col gap-2 md:flex-row md:items-center"
        onSubmit={(event) => {
          event.preventDefault()
          applyTerm(text, true)
        }}
      >
        <div className="w-full md:max-w-[560px]">
          <MusicSearchBox
            value={text}
            onChange={setText}
            onCommit={(value) => applyTerm(value, true)}
          />
        </div>
        <Button type="submit" variant="primary" icon={<Search size={14} />}>
          {musicText('music.search.submit')}
        </Button>
      </form>

      {searching ? (
        <>
          <MusicTabs
            value={type}
            items={MUSIC_SEARCH_TYPES.map((value) => ({
              value,
              label: musicText(SEARCH_TYPE_KEYS[value]),
            }))}
            onChange={(next) => {
              setType(next)
              setPage(1)
            }}
            label={musicText('music.search.tabs.label')}
          />
          <section aria-label={resultLabel} aria-busy={resultQuery.status === 'loading'}>
            {renderResults()}
          </section>
        </>
      ) : (
        <>
          {hot.status === 'error' && !hot.data && (
            <PageError compact error={hot.error} onRetry={hot.reload} />
          )}

          {hotLoading && !hot.data && <HotSearchesSkeleton />}

          {hotItems.length > 0 && (
            <section aria-labelledby={hotId}>
              <SectionHeader id={hotId} title={musicText('music.search.hot.title')} />
              <div className="flex flex-wrap gap-2">
                {hotItems.map((item, index) => (
                  <Button
                    key={`${item}-${index}`}
                    size="sm"
                    variant="secondary"
                    onClick={() => applyTerm(item, true)}
                  >
                    {item}
                  </Button>
                ))}
              </div>
            </section>
          )}

          {history.length > 0 && (
            <section aria-labelledby={historyId}>
              <SectionHeader
                id={historyId}
                title={musicText('music.search.history.title')}
                action={{ label: musicText('music.search.history.clear'), onClick: clearHistory }}
              />
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {history.map((item) => (
                  <li
                    key={item}
                    className="flex items-center overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                  >
                    <button
                      type="button"
                      className="max-w-[220px] truncate px-3 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                      onClick={() => applyTerm(item, true)}
                    >
                      {item}
                    </button>
                    <IconButton
                      size="xs"
                      className="mr-1"
                      label={musicText('music.search.history.remove', { term: item })}
                      onClick={() => removeSearchHistory(item)}
                    >
                      <X size={12} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {hot.status === 'ready' && hotItems.length === 0 && history.length === 0 && (
            <Empty
              art="search"
              title={musicText('music.search.empty.title')}
              description={musicText('music.search.empty.description')}
            />
          )}
        </>
      )}
    </MusicPageBody>
  )
}
