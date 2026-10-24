/** Index screens for the catalog shelves the reference app puts in its top navigation. */
import { useId, useState, type ReactNode, type ReactElement } from 'react'
import type { MusicAlbumSummary, MusicPlaylistSummary, MusicToplistSummary } from '@shared/music/api'
import { CardGridSkeleton, MusicCard } from './parts/MediaCards'
import { PageError } from './parts/PageState'
import { PAGE_STACK } from './parts/P2QueryState'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { musicPathFor } from '../music-address'
import { Pager } from '../components/Pager'
import { SectionHeader } from '../components/SectionHeader'
import { MusicTabs, type MusicTabItem } from '../components/Tabs'
import { musicText } from '../components/labels'
import { navigateToAddress } from '../../../lib/app-history'
import { Empty } from '../../../components/feedback'

const PAGE_SIZE = 30

const ALBUM_AREAS = [
  { value: 'ALL', labelKey: 'music.album.area.all' },
  { value: 'ZH', labelKey: 'music.album.area.chinese' },
  { value: 'EA', labelKey: 'music.album.area.western' },
  { value: 'KR', labelKey: 'music.album.area.korea' },
  { value: 'JP', labelKey: 'music.album.area.japan' },
] as const

type AlbumArea = (typeof ALBUM_AREAS)[number]['value']

function Grid({ children }: { children: ReactNode }): ReactElement {
  return <div className="music-card-grid">{children}</div>
}

function cardMeta(playlist: MusicPlaylistSummary): string {
  return playlist.creator || musicText('music.common.track_count', { count: playlist.trackCount })
}

export function PlaylistsPage(): ReactElement {
  const headingId = useId()
  const [category, setCategory] = useState('')
  const [pageIndex, setPageIndex] = useState(1)
  const categories = useMusicQuery(() => musicApi.playlistCategories(), [])
  const query = useMusicQuery(
    () => musicApi.playlistSquare(pageIndex, PAGE_SIZE, category),
    [category, pageIndex],
  )
  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const tabs: MusicTabItem<string>[] = [
    { value: '', label: musicText('music.filter.all') },
    ...(categories.data?.items ?? []).map((item) => ({ value: item.name, label: item.name })),
  ]

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader level={1} id={headingId} title={musicText('music.page.playlists')} description={musicText('music.browse.playlists_hint')} />
      <MusicTabs
        value={category}
        items={tabs}
        label={musicText('music.playlist.category_label')}
        onChange={(next) => {
          setCategory(next)
          setPageIndex(1)
        }}
      />
      {categories.status === 'error' && (
        <PageError compact error={categories.error} onRetry={categories.reload} />
      )}
      {query.status === 'error' && !query.data ? <PageError error={query.error} onRetry={query.reload} /> : query.status === 'loading' && !query.data ? <CardGridSkeleton count={12} /> : items.length === 0 ? <Empty art="search" title={musicText('music.browse.empty')} /> : (
        <>
          {query.status === 'error' && <PageError compact error={query.error} onRetry={query.reload} />}
          <Grid>{items.map((item: MusicPlaylistSummary) => (
            <MusicCard key={item.id} coverSrc={item.coverUrl || undefined} title={item.name} meta={cardMeta(item)} onOpen={() => navigateToAddress(musicPathFor({ kind: 'playlist', id: item.id }))} />
          ))}</Grid>
          <Pager page={pageIndex} pageCount={pageCount} onChange={setPageIndex} />
        </>
      )}
    </section>
  )
}

export function AlbumsPage(): ReactElement {
  const headingId = useId()
  const [area, setArea] = useState<AlbumArea>('ALL')
  const [pageIndex, setPageIndex] = useState(1)
  const areaTabs: MusicTabItem<AlbumArea>[] = ALBUM_AREAS.map((item) => ({
    value: item.value,
    label: musicText(item.labelKey),
  }))
  const query = useMusicQuery(
    () => musicApi.newAlbums(area, pageIndex, PAGE_SIZE),
    [area, pageIndex],
  )
  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader level={1} id={headingId} title={musicText('music.page.albums')} description={musicText('music.browse.albums_hint')} />
      <MusicTabs
        value={area}
        items={areaTabs}
        label={musicText('music.album.area_label')}
        onChange={(next) => {
          setArea(next)
          setPageIndex(1)
        }}
      />
      {query.status === 'error' && !query.data ? <PageError error={query.error} onRetry={query.reload} /> : query.status === 'loading' && !query.data ? <CardGridSkeleton count={12} /> : items.length === 0 ? <Empty art="search" title={musicText('music.browse.empty')} /> : (
        <>
          {query.status === 'error' && <PageError compact error={query.error} onRetry={query.reload} />}
          <Grid>{items.map((item: MusicAlbumSummary) => (
            <MusicCard key={item.id} coverSrc={item.coverUrl || undefined} title={item.name} meta={item.artists.join(' / ') || musicText('music.common.track_count', { count: item.trackCount })} onOpen={() => navigateToAddress(musicPathFor({ kind: 'album', id: item.id }))} />
          ))}</Grid>
          <Pager page={pageIndex} pageCount={pageCount} onChange={setPageIndex} />
        </>
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
