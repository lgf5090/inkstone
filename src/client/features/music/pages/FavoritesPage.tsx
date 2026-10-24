/** The account's favourites: one list, a sort control and removal with an undo toast. */
import { useId, useMemo, useState, type ReactElement } from 'react'
import { HeartOff, ListPlus, Play, Shuffle } from 'lucide-react'
import { musicArtistNames } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Select } from '../../../components/form'
import { Button } from '../../../components/primitives'
import type { MenuItem } from '../../../components/overlay'
import { getLocale } from '../../../lib/i18n'
import { navigateToAddress } from '../../../lib/app-history'
import { toastWithUndo } from '../../../store/ui'
import { useMusicQuery } from '../query'
import { musicPathFor } from '../music-address'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { PAGE_STACK, QueryError, toastFailure } from './parts/P2QueryState'

type FavoriteSort = 'recent' | 'title' | 'artist'

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

export function FavoritesPage(): ReactElement {
  const [sort, setSort] = useState<FavoriteSort>('recent')
  const headingId = useId()
  const favorites = useMusicLibrary((state) => state.favorites)

  // The library store is the write authority; this query only drives the initial load and the
  // retry so a removed favourite disappears from every page at once.
  const query = useMusicQuery(async () => {
    await loadLibrary()
    const current = useMusicLibrary.getState()
    if (current.status === 'error') {
      throw new Error(current.errorDetail ?? musicText(current.error ?? 'music.library.error.load'))
    }
    return current.favorites
  }, [])

  const sorted = useMemo(() => {
    const list = [...favorites]
    if (sort === 'title') {
      list.sort((left, right) => left.title.localeCompare(right.title, getLocale()))
    } else if (sort === 'artist') {
      list.sort((left, right) => musicArtistNames(left).localeCompare(musicArtistNames(right), getLocale()))
    }
    return list
  }, [favorites, sort])

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

  const removeFavorite = async (track: MusicTrack): Promise<void> => {
    const stillFavorite = await useMusicLibrary.getState().toggleFavorite(track)
    if (stillFavorite) {
      const state = useMusicLibrary.getState()
      toastFailure(
        musicText('music.favorites.remove_failed'),
        new Error(state.errorDetail ?? musicText(state.error ?? 'music.library.error.favorite')),
      )
      return
    }
    toastWithUndo(musicText('music.favorites.removed'), () => {
      void useMusicLibrary.getState().toggleFavorite(track)
    })
  }

  const menuItemsFor = (track: MusicTrack): MenuItem[] => [
    {
      id: 'play-next',
      label: musicText('music.song.play_next'),
      icon: <ListPlus size={14} />,
      onSelect: () => {
        useMusicPlayer.getState().addNext(track)
      },
    },
    {
      id: 'remove-favorite',
      label: musicText('common.remove_from_favorites'),
      icon: <HeartOff size={14} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => {
        void removeFavorite(track)
      },
    },
  ]

  const playTrack = (track: MusicTrack, queue: readonly MusicTrack[]): void => {
    void useMusicPlayer.getState().playTrack(track, { queue })
    void useMusicLibrary.getState().recordHistory({ track, contextType: 'favorites' })
  }

  const discoverHref = musicPathFor({ kind: 'home' })

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <header className="music-section-header">
        <div className="music-section-header__text">
          <h1 id={headingId} className="music-section-header__title">
            {musicText('music.page.favorites')}
          </h1>
          <p className="music-section-header__description">
            {musicText('music.favorites.count', { count: favorites.length })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-[var(--sp-2)]">
          <Select
            aria-label={musicText('music.favorites.sort')}
            value={sort}
            onChange={(event) => setSort(event.target.value as FavoriteSort)}
          >
            <option value="recent">{musicText('music.favorites.sort.recent')}</option>
            <option value="title">{musicText('music.favorites.sort.title')}</option>
            <option value="artist">{musicText('music.favorites.sort.artist')}</option>
          </Select>
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

      {query.status === 'error' && favorites.length > 0 && (
        <QueryError
          title={musicText('music.favorites.error')}
          detail={query.error}
          onRetry={query.reload}
        />
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
      ) : (
        <SongList tracks={sorted} onPlay={playTrack} menuItemsFor={menuItemsFor} />
      )}
    </section>
  )
}
