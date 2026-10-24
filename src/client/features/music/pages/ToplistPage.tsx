/**
 * A ranking: its own header and rows, followed by the other rankings the catalog publishes.
 *
 * The list endpoint is cheap and already names every chart, so it rides along as a "more" shelf
 * instead of requiring a second route for an index screen. Picking one replaces the address; the
 * detail query owns the new id and the page count starts over.
 */
import { useEffect, useId, useState, type ReactElement } from 'react'
import { Play } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { Pager } from '../components/Pager'
import { SectionHeader } from '../components/SectionHeader'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { DetailHero, DetailHeroSkeleton } from './parts/Hero'
import { CardGridSkeleton, MusicCard } from './parts/MediaCards'
import { MusicPageBody, PageError, TrackListSkeleton } from './parts/PageState'
import { playTracks } from './parts/playback'

const PAGE_SIZE = 100

export interface ToplistPageProps {
  id: string
}

export function ToplistPage({ id }: ToplistPageProps): ReactElement {
  const [page, setPage] = useState(1)
  const moreId = useId()
  const listsQuery = useMusicQuery(() => musicApi.toplists(), [])
  const detailQuery = useMusicQuery(
    () => musicApi.toplist(id, page, PAGE_SIZE),
    [id, page],
  )

  useEffect(() => {
    setPage(1)
  }, [id])

  const detail = detailQuery.data?.playlist.id === id ? detailQuery.data : null
  const otherLists = (listsQuery.data?.items ?? []).filter((item) => item.id !== id)

  if (!detail) {
    if (detailQuery.status === 'error') {
      return (
        <MusicPageBody>
          <PageError error={detailQuery.error} onRetry={detailQuery.reload} />
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

  return (
    <MusicPageBody>
      {detailQuery.status === 'error' && (
        <PageError compact error={detailQuery.error} onRetry={detailQuery.reload} />
      )}

      <DetailHero
        key={id}
        coverSrc={detail.playlist.coverUrl}
        eyebrow={musicText('music.toplist.eyebrow')}
        title={detail.playlist.name}
        meta={<span>{musicText('music.common.track_count', { count: detail.playlist.trackCount })}</span>}
        description={detail.playlist.description}
        actions={(
          <Button
            variant="primary"
            icon={<Play size={14} />}
            disabled={detail.tracks.length === 0}
            onClick={() => playTracks(detail.tracks)}
          >
            {musicText('music.common.play_all')}
          </Button>
        )}
      />

      <SongList
        tracks={detail.tracks}
        loading={detailQuery.status === 'loading'}
        onPlay={(track, queue) => playTracks(queue, track)}
        emptyAction={(
          <Button size="sm" variant="secondary" onClick={() => navigateToAddress('/music')}>
            {musicText('music.common.discover')}
          </Button>
        )}
      />

      <Pager page={page} pageCount={pageCount} onChange={setPage} />

      <section aria-labelledby={moreId}>
        <SectionHeader
          id={moreId}
          title={musicText('music.toplist.section.title')}
          description={musicText('music.toplist.section.description')}
        />

        {listsQuery.status === 'loading' && !listsQuery.data ? (
          <CardGridSkeleton count={5} />
        ) : listsQuery.status === 'error' && !listsQuery.data ? (
          <PageError compact error={listsQuery.error} onRetry={listsQuery.reload} />
        ) : otherLists.length === 0 ? (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {musicText('music.toplist.section.empty')}
          </p>
        ) : (
          <>
            {listsQuery.status === 'error' && (
              <PageError compact error={listsQuery.error} onRetry={listsQuery.reload} />
            )}
            <div className="music-card-grid">
              {otherLists.map((item) => (
                <MusicCard
                  key={item.id}
                  coverSrc={item.coverUrl}
                  title={item.name}
                  meta={musicText('music.common.track_count', { count: item.trackCount })}
                  onOpen={() => navigateToAddress(musicPathFor({ kind: 'toplist', id: item.id }))}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </MusicPageBody>
  )
}
