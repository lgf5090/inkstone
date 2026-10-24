/** Index screens for the catalog shelves the reference app puts in its top navigation. */
import { useId, type ReactNode, type ReactElement } from 'react'
import type { MusicAlbumSummary, MusicPlaylistSummary, MusicToplistSummary } from '@shared/music/api'
import { CardGridSkeleton, MusicCard } from './parts/MediaCards'
import { PageError } from './parts/PageState'
import { PAGE_STACK } from './parts/P2QueryState'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { musicPathFor } from '../music-address'
import { SectionHeader } from '../components/SectionHeader'
import { musicText } from '../components/labels'
import { navigateToAddress } from '../../../lib/app-history'
import { Empty } from '../../../components/feedback'

function Grid({ children }: { children: ReactNode }): ReactElement {
  return <div className="music-card-grid">{children}</div>
}

function cardMeta(playlist: MusicPlaylistSummary): string {
  return playlist.creator || musicText('music.common.track_count', { count: playlist.trackCount })
}

export function PlaylistsPage(): ReactElement {
  const headingId = useId()
  const query = useMusicQuery(() => musicApi.playlistSquare(1, 48), [])
  const items = query.data?.items ?? []
  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader level={1} id={headingId} title={musicText('music.page.playlists')} description={musicText('music.browse.playlists_hint')} />
      {query.status === 'error' && !query.data ? <PageError error={query.error} onRetry={query.reload} /> : query.status === 'loading' && !query.data ? <CardGridSkeleton count={12} /> : items.length === 0 ? <Empty art="search" title={musicText('music.browse.empty')} /> : (
        <Grid>{items.map((item: MusicPlaylistSummary) => (
          <MusicCard key={item.id} coverSrc={item.coverUrl || undefined} title={item.name} meta={cardMeta(item)} onOpen={() => navigateToAddress(musicPathFor({ kind: 'playlist', id: item.id }))} />
        ))}</Grid>
      )}
    </section>
  )
}

export function AlbumsPage(): ReactElement {
  const headingId = useId()
  const query = useMusicQuery(() => musicApi.newAlbums('ALL', 1, 48), [])
  const items = query.data?.items ?? []
  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader level={1} id={headingId} title={musicText('music.page.albums')} description={musicText('music.browse.albums_hint')} />
      {query.status === 'error' && !query.data ? <PageError error={query.error} onRetry={query.reload} /> : query.status === 'loading' && !query.data ? <CardGridSkeleton count={12} /> : items.length === 0 ? <Empty art="search" title={musicText('music.browse.empty')} /> : (
        <Grid>{items.map((item: MusicAlbumSummary) => (
          <MusicCard key={item.id} coverSrc={item.coverUrl || undefined} title={item.name} meta={item.artists.join(' / ') || musicText('music.common.track_count', { count: item.trackCount })} onOpen={() => navigateToAddress(musicPathFor({ kind: 'album', id: item.id }))} />
        ))}</Grid>
      )}
    </section>
  )
}

export function ToplistsPage(): ReactElement {
  const headingId = useId()
  const query = useMusicQuery(() => musicApi.toplists(), [])
  const items = query.data?.items ?? []
  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader level={1} id={headingId} title={musicText('music.page.toplists')} description={musicText('music.browse.toplists_hint')} />
      {query.status === 'error' && !query.data ? <PageError error={query.error} onRetry={query.reload} /> : query.status === 'loading' && !query.data ? <CardGridSkeleton count={10} /> : items.length === 0 ? <Empty art="search" title={musicText('music.browse.empty')} /> : (
        <Grid>{items.map((item: MusicToplistSummary) => (
          <MusicCard key={item.id} coverSrc={item.coverUrl || undefined} title={item.name} meta={item.description || musicText('music.common.track_count', { count: item.trackCount })} onOpen={() => navigateToAddress(musicPathFor({ kind: 'toplist', id: item.id }))} />
        ))}</Grid>
      )}
    </section>
  )
}
