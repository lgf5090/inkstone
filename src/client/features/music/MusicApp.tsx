/**
 * The music container's frame: a second navigation rail, the screen area and the play bar.
 *
 * The frame owns what never changes between screens — the rail, the address mirror, the player
 * restore and the library's first load. The screen itself is chosen by `page.kind`; pages below own
 * their own loading, empty, error and ready answers.
 */
import { useEffect, useId, useMemo, type ComponentType, type ReactElement } from 'react'
import { Compass, Library, Music, Search, Settings } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../lib/cn'
import { navigateToAddress, usePathname, useSearch } from '../../lib/app-history'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { parseMusicAddress, type MusicPage } from './music-address'
import { AlbumPage } from './pages/AlbumPage'
import { ArtistPage } from './pages/ArtistPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { HistoryPage } from './pages/HistoryPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { MusicSettingsPage } from './pages/MusicSettingsPage'
import { MvPage } from './pages/MvPage'
import { PlaylistPage } from './pages/PlaylistPage'
import { PodcastPage } from './pages/PodcastPage'
import { SearchPage } from './pages/SearchPage'
import { ToplistPage } from './pages/ToplistPage'
import { UploadsPage } from './pages/UploadsPage'
import { UserPage } from './pages/UserPage'
import { MiniPlayer } from './components/MiniPlayer'
import { FullLyrics } from './components/FullLyrics'
import { PlayBar } from './components/PlayBar'
import { QueueDrawer } from './components/QueueDrawer'
import { useMusicLibrary } from './store/library'
import { useMusicPlayer } from './store/player'
import { useMusicShortcuts } from './shortcuts'
import { useMusicUi } from './store/ui'

/**
 * The music catalog arrives in its own locale fragment later. Until it does, `t` answers with the key
 * itself, which is readable in development and cannot drift into copy that would need translating
 * twice. The cast is the seam that fragment removes.
 */
function musicText(key: string): string {
  return t(key as MessageKey)
}

interface NavItem {
  path: string
  labelKey: string
  icon: ComponentType<{ size?: number; className?: string }>
}

const NAV_ITEMS: readonly NavItem[] = [
  { path: '/music', labelKey: 'music.nav.discover', icon: Compass },
  { path: '/music/search', labelKey: 'music.nav.search', icon: Search },
  { path: '/music/favorites', labelKey: 'music.nav.library', icon: Library },
  { path: '/music/settings', labelKey: 'music.nav.settings', icon: Settings },
]

const PAGE_TITLE_KEYS: Record<MusicPage['kind'], string> = {
  home: 'music.page.home',
  search: 'music.page.search',
  playlist: 'music.page.playlist',
  album: 'music.page.album',
  artist: 'music.page.artist',
  toplist: 'music.page.toplist',
  mv: 'music.page.mv',
  mvDetail: 'music.page.mv_detail',
  podcast: 'music.page.podcast',
  podcastDetail: 'music.page.podcast_detail',
  favorites: 'music.page.favorites',
  history: 'music.page.history',
  uploads: 'music.page.uploads',
  downloads: 'music.page.downloads',
  user: 'music.page.user',
  login: 'music.page.login',
  settings: 'music.page.settings',
  notFound: 'music.page.not_found',
}

function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function isNavActive(pathname: string, path: string): boolean {
  const current = normalise(pathname)
  if (path === '/music') return current === '/music'
  return current === path || current.startsWith(`${path}/`)
}

function MusicNavLink({ item, active }: { item: NavItem; active: boolean }): ReactElement {
  const Icon = item.icon
  return (
    <a
      href={item.path}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        // A modified press or a middle click belongs to the browser: let it open a new tab.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigateToAddress(item.path)
      }}
      className={cn(
        'flex shrink-0 items-center gap-2 rounded-[var(--r-md)] px-2.5 py-2 text-[length:var(--text-13)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{musicText(item.labelKey)}</span>
    </a>
  )
}

function MusicPlaceholder(): ReactElement {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] bg-[var(--bg-sunken)] px-6 py-10 text-center">
      <p className="text-[length:var(--text-13-5)] font-medium text-[var(--text-secondary)]">
        {musicText('music.placeholder.title')}
      </p>
      <p className="mt-1.5 max-w-[320px] text-[length:var(--text-12)] leading-relaxed text-[var(--text-quaternary)]">
        {musicText('music.placeholder.description')}
      </p>
    </div>
  )
}

/**
 * One screen per address. This lane owns discovery and detail; the second page lane supplies the
 * remaining screens, imported statically so a missing file is a build error rather than a tab that
 * silently does nothing. `notFound` is the only kind without a screen: the address named something
 * this app never links to, and the placeholder says so without pretending to be a failed query.
 */
function MusicPageContent({ page }: { page: MusicPage }): ReactElement {
  switch (page.kind) {
    case 'home':
      return <HomePage />
    case 'search':
      return <SearchPage query={page.query} />
    case 'playlist':
      return <PlaylistPage key={page.id} id={page.id} />
    case 'album':
      return <AlbumPage key={page.id} id={page.id} />
    case 'artist':
      return <ArtistPage key={page.id} id={page.id} />
    case 'toplist':
      return <ToplistPage key={page.id} id={page.id} />
    case 'mv':
    case 'mvDetail':
      return <MvPage />
    case 'podcast':
    case 'podcastDetail':
      return <PodcastPage />
    case 'favorites':
      return <FavoritesPage />
    case 'history':
      return <HistoryPage />
    case 'uploads':
      return <UploadsPage />
    case 'downloads':
      return <DownloadsPage />
    case 'user':
      return <UserPage />
    case 'login':
      return <LoginPage />
    case 'settings':
      return <MusicSettingsPage />
    default:
      return <MusicPlaceholder />
  }
}

export function MusicApp(): ReactElement {
  const pathname = usePathname()
  const search = useSearch()
  const page = useMemo(() => parseMusicAddress(pathname, search), [pathname, search])
  const headingId = useId()
  useMusicShortcuts()

  // A restored queue is a promise the browser will not let us keep without a gesture: it comes back
  // paused, and the bar says so. Restore is idempotent, which is what makes the StrictMode second
  // call harmless.
  useEffect(() => {
    useMusicPlayer.getState().restore()
  }, [])

  // The address is the source of truth; the store mirrors it so panels can read one selector.
  useEffect(() => {
    useMusicUi.getState().setPage(page)
  }, [page])

  // Favourites and the library shelves are read by rows on many pages, so the first load belongs to
  // the frame rather than to whichever page happens to mount first. A failure is reported once here;
  // pages that need the library for their whole screen surface their own retry.
  useEffect(() => {
    const library = useMusicLibrary.getState()
    if (library.status !== 'idle') return
    void library.load().then(() => {
      const next = useMusicLibrary.getState()
      if (next.status !== 'error') return
      useUi.getState().toast({
        title: musicText(next.error ?? 'music.library.error.load'),
        description: next.errorDetail ?? undefined,
        tone: 'danger',
      })
    })
  }, [])

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <Music size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <h1 id={headingId} className="min-w-0 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
          {musicText(PAGE_TITLE_KEYS[page.kind])}
        </h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] md:w-[var(--nav-w)] md:border-b-0 md:border-r">
          <nav
            aria-label={musicText('music.nav.label')}
            className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible"
          >
            {NAV_ITEMS.map((item) => (
              <MusicNavLink key={item.path} item={item} active={isNavActive(pathname, item.path)} />
            ))}
          </nav>
        </aside>

        <main aria-labelledby={headingId} className="min-h-0 min-w-0 flex-1 overflow-auto p-3 md:p-4">
          <MusicPageContent page={page} />
        </main>
      </div>

      <PlayBar />
      <MiniPlayer onExpand={() => useMusicUi.getState().setLyricsOpen(true)} />
      <QueueDrawer />
      <FullLyrics />
    </section>
  )
}
