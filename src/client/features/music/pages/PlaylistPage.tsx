/**
 * One playlist: the header that says what it is, the toolbar that makes a long list usable, and the
 * rows themselves.
 *
 * The filter is local to the page — it narrows the tracks already fetched rather than asking the
 * provider for a new search — so a reader can find a track in a 500-row playlist without leaving it.
 * Compact rows and "locate current" are the other two tools a long list needs; neither changes what
 * the player queued, which remains the list the pressed row came from.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { LocateFixed, Play, Rows3, Search } from 'lucide-react'
import { musicArtistNames } from '@shared/music/format'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { Pager } from '../components/Pager'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { DetailHero, DetailHeroSkeleton } from './parts/Hero'
import { MusicPageBody, PageError, TrackListSkeleton } from './parts/PageState'
import { playTracks } from './parts/playback'

const PAGE_SIZE = 100

export interface PlaylistPageProps {
  id: string
}

export function PlaylistPage({ id }: PlaylistPageProps): ReactElement {
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('')
  const [compact, setCompact] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const current = useMusicPlayer(selectCurrentTrack)
  const localPlaylists = useMusicLibrary((state) => state.playlists)
  const provider = localPlaylists.some((playlist) => playlist.id === id) ? 'local' : 'netease'
  const query = useMusicQuery(
    () => musicApi.playlist(id, provider, page, PAGE_SIZE),
    [id, page, provider],
  )

  useEffect(() => {
    setPage(1)
    setFilter('')
    setCompact(false)
  }, [id])

  const detail = query.data?.playlist.id === id ? query.data : null
  const tracks = detail?.tracks ?? []
  const needle = filter.trim().toLocaleLowerCase()
  const visibleTracks = useMemo(() => {
    if (!needle) return tracks
    return tracks.filter((track) => (
      track.title.toLocaleLowerCase().includes(needle)
      || track.album.toLocaleLowerCase().includes(needle)
      || musicArtistNames(track).toLocaleLowerCase().includes(needle)
    ))
  }, [tracks, needle])
  const currentInList = current !== null && visibleTracks.some((track) => track.id === current.id)

  const locateCurrent = (): void => {
    const row = listRef.current?.querySelector<HTMLElement>('.music-row--active')
    if (!row) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    row.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }

  if (!detail) {
    if (query.status === 'error') {
      return (
        <MusicPageBody>
          <PageError error={query.error} onRetry={query.reload} />
        </MusicPageBody>
      )
    }
    return (
      <MusicPageBody>
        <DetailHeroSkeleton />
        <TrackListSkeleton />
      </MusicPageBody>
    )
  }

  const pageCount = Math.max(1, Math.ceil(detail.total / PAGE_SIZE))
  const meta = (
    <>
      {detail.playlist.creator && (
        <span>{musicText('music.playlist.creator', { name: detail.playlist.creator })}</span>
      )}
      <span>{musicText('music.common.track_count', { count: detail.playlist.trackCount })}</span>
    </>
  )

  return (
    <MusicPageBody>
      {query.status === 'error' && (
        <PageError compact error={query.error} onRetry={query.reload} />
      )}

      <DetailHero
        key={id}
        coverSrc={detail.playlist.coverUrl}
        eyebrow={musicText('music.playlist.eyebrow')}
        title={detail.playlist.name}
        meta={meta}
        description={detail.playlist.description}
        actions={(
          <Button
            variant="primary"
            icon={<Play size={14} />}
            disabled={tracks.length === 0}
            onClick={() => playTracks(tracks)}
          >
            {musicText('music.common.play_all')}
          </Button>
        )}
      />

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="w-full md:max-w-[320px]">
          <Input
            value={filter}
            leading={<Search size={14} aria-hidden="true" />}
            placeholder={musicText('music.playlist.filter_placeholder')}
            aria-label={musicText('music.playlist.filter_placeholder')}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label={musicText('music.playlist.compact')}
            active={compact}
            onClick={() => setCompact((value) => !value)}
          >
            <Rows3 size={15} />
          </IconButton>
          <IconButton
            label={musicText('music.playlist.locate')}
            disabled={!currentInList}
            onClick={locateCurrent}
          >
            <LocateFixed size={15} />
          </IconButton>
        </div>
      </div>

      <div ref={listRef}>
        <SongList
          variant={compact ? 'compact' : 'list'}
          tracks={visibleTracks}
          loading={query.status === 'loading'}
          onPlay={(track, queue) => playTracks(queue, track)}
          emptyAction={needle ? (
            <Button size="sm" variant="secondary" onClick={() => setFilter('')}>
              {musicText('music.playlist.clear_filter')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigateToAddress('/music')}
            >
              {musicText('music.common.discover')}
            </Button>
          )}
        />
      </div>

      <Pager page={page} pageCount={pageCount} onChange={setPage} />
    </MusicPageBody>
  )
}
