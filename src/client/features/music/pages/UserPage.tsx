/**
 * A Netease profile, and for `/music/user` the account's own centre: local plays and playlists stay
 * visible even before a Netease account is connected, because the Inkstone library is still theirs.
 */
import { useId, useState, type ReactElement } from 'react'
import { Clock3, Heart, ListMusic, ListPlus, Play, UserRound } from 'lucide-react'
import { formatPlayCount, musicArtistNames } from '@shared/music/format'
import type { MusicHistorySummary, MusicUserProfile } from '@shared/music/api'
import type { MusicAccount, MusicPlaylist, MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Button, IconButton } from '../../../components/primitives'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { musicPathFor, type MusicPage } from '../music-address'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { Cover } from '../components/Cover'
import { PlaylistImportDialog } from '../components/PlaylistImportDialog'
import { musicText } from '../components/labels'
import { MediaCard, MediaGridSkeleton, RemoteAvatar } from './parts/P2MediaCard'
import { MusicStatCard } from './parts/StatCard'
import {
  PAGE_STACK,
  QueryError,
} from './parts/P2QueryState'

interface UserPageData {
  connected: boolean
  expired: boolean
  profile: MusicUserProfile | null
  account: MusicAccount | null
}

export function UserPage({ page }: { page: MusicPage }): ReactElement {
  const isMe = page.kind === 'me'
  const id = page.kind === 'user' ? page.id : ''
  const headingId = useId()
  const [importOpen, setImportOpen] = useState(false)
  const favorites = useMusicLibrary((state) => state.favorites)
  const playlists = useMusicLibrary((state) => state.playlists)
  const summaryQuery = useMusicQuery(() => musicApi.historySummary(), [], { enabled: isMe })
  const query = useMusicQuery<UserPageData>(async () => {
    const status = await musicApi.account()
    const account = status.account
    if (!account || account.status === 'expired') {
      return { connected: false, expired: Boolean(account), profile: null, account }
    }
    const target = isMe ? account.accountId : id
    return {
      connected: true,
      expired: false,
      profile: await musicApi.user(target),
      account,
    }
  }, [isMe, id])

  const data = query.data
  const connected = Boolean(data?.connected && data.profile)
  const profile = data?.profile ?? null
  const summary = summaryQuery.data
  const loginHref = musicPathFor({ kind: 'login' })
  const homeHref = musicPathFor({ kind: 'home' })
  const historyHref = musicPathFor({ kind: 'history' })
  const displayName = profile?.nickname
    ?? data?.account?.nickname
    ?? musicText('music.user.local_title')
  const avatarUrl = profile?.avatarUrl || data?.account?.avatarUrl || ''
  if (!isMe && data && !connected) {
    return (
      <section aria-label={musicText('music.page.user')} className={PAGE_STACK}>
        <h1 className="sr-only">{musicText('music.page.user')}</h1>
        <Empty
          art="subscriptions"
          title={musicText(data.expired ? 'music.user.expired' : 'music.user.disconnected')}
          description={musicText(data.expired ? 'music.user.expired_hint' : 'music.user.disconnected_hint')}
          action={(
            <Button variant="primary" onClick={() => navigateToAddress(loginHref)}>
              {musicText('music.user.connect')}
            </Button>
          )}
        />
      </section>
    )
  }

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <h1 id={headingId} className="sr-only">
        {musicText(isMe ? 'music.user.me' : 'music.page.user')}
      </h1>

      {query.status === 'error' && !data ? (
        <QueryError
          title={musicText('music.user.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !data ? (
        <div className="flex flex-col gap-[var(--sp-4)]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
          <div className="flex items-center gap-[var(--sp-4)]">
            <div className="size-[96px] rounded-full bg-[var(--bg-sunken)]" />
            <div className="flex flex-1 flex-col gap-[var(--sp-2)]">
              <div className="h-[22px] w-1/3 rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
              <div className="h-[12px] w-1/2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
            </div>
          </div>
          <MediaGridSkeleton count={5} />
        </div>
      ) : (
        <>
          {query.status === 'error' && (
            <QueryError title={musicText('music.user.error')} detail={query.error} onRetry={query.reload} />
          )}

          <header className="flex flex-col gap-[var(--sp-4)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-5)] sm:flex-row sm:items-center">
            <RemoteAvatar src={avatarUrl || undefined} name={displayName} size={96} />
            <div className="min-w-0 flex-1">
              <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-22)] font-semibold leading-tight tracking-[var(--tracking-title)] text-[var(--text-primary)]">
                {displayName}
              </h2>
              <p className="mt-[var(--sp-1)] max-w-[60ch] text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">
                {profile?.signature
                  || (isMe
                    ? musicText(connected ? 'music.user.me_hint' : 'music.user.local_hint')
                    : musicText('music.user.signature_empty'))}
              </p>
              {profile && (
                <dl className="mt-[var(--sp-3)] flex flex-wrap items-center gap-[var(--sp-5)]">
                  <div className="flex flex-col">
                    <dt className="text-[length:var(--text-10-5)] uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
                      {musicText('music.user.following')}
                    </dt>
                    <dd className="text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">
                      {formatPlayCount(profile.follows)}
                    </dd>
                  </div>
                  <div className="flex flex-col">
                    <dt className="text-[length:var(--text-10-5)] uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
                      {musicText('music.user.followers')}
                    </dt>
                    <dd className="text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">
                      {formatPlayCount(profile.followers)}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-[var(--sp-2)] sm:justify-end">
              {isMe && !connected && (
                <Button variant="primary" icon={<UserRound size={14} />} onClick={() => navigateToAddress(loginHref)}>
                  {musicText(data?.expired ? 'music.user.reconnect' : 'music.user.connect')}
                </Button>
              )}
            </div>
          </header>

          {isMe && (
            <UserCentre
              summary={summary}
              summaryLoading={summaryQuery.status === 'loading'}
              summaryError={summaryQuery.error}
              onRetrySummary={summaryQuery.reload}
              favorites={favorites.length}
              playlists={playlists}
              historyHref={historyHref}
              onImport={() => setImportOpen(true)}
              homeHref={homeHref}
            />
          )}

          {profile && (
            <section aria-label={musicText('music.user.playlists')} className="flex flex-col gap-[var(--sp-3)]">
              <header className="music-section-header">
                <div className="music-section-header__text">
                  <h2 className="music-section-header__title">
                    {musicText(isMe ? 'music.user.netease_playlists' : 'music.user.playlists')}
                  </h2>
                  <p className="music-section-header__description">
                    {musicText('music.user.playlist_total', { count: profile.playlists.length })}
                  </p>
                </div>
              </header>
              {profile.playlists.length === 0 ? (
                <Empty
                  art="folder"
                  compact
                  title={musicText('music.user.no_playlists')}
                  description={musicText('music.user.no_playlists_hint')}
                />
              ) : (
                <div className="music-card-grid">
                  {profile.playlists.map((playlist) => (
                    <MediaCard
                      key={playlist.id}
                      href={musicPathFor({ kind: 'playlist', id: playlist.id })}
                      title={playlist.name}
                      meta={musicText('music.user.playlist_count', { count: playlist.trackCount })}
                      description={playlist.description}
                      coverUrl={playlist.coverUrl}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {!isMe && !profile && (
            <Empty
              art="select"
              title={musicText('music.user.empty')}
              description={musicText('music.user.empty_hint')}
              action={(
                <Button variant="secondary" onClick={() => navigateToAddress(homeHref)}>
                  {musicText('music.user.home')}
                </Button>
              )}
            />
          )}

          {isMe && (
            <PlaylistImportDialog
              open={importOpen}
              onClose={() => setImportOpen(false)}
              onImported={(playlistId) => navigateToAddress(musicPathFor({ kind: 'playlist', id: playlistId }))}
            />
          )}
        </>
      )}
    </section>
  )
}

function UserCentre({
  summary,
  summaryLoading,
  summaryError,
  onRetrySummary,
  favorites,
  playlists,
  historyHref,
  onImport,
  homeHref,
}: {
  summary: MusicHistorySummary | null
  summaryLoading: boolean
  summaryError: string | null
  onRetrySummary: () => void
  favorites: number
  playlists: readonly MusicPlaylist[]
  historyHref: string
  onImport: () => void
  homeHref: string
}): ReactElement {
  const top = summary?.topTracks ?? []
  const queue = top.map((row) => row.track)
  return (
    <>
      <section aria-label={musicText('music.user.stats')} className="flex flex-col gap-[var(--sp-3)]">
        <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
          <h2 className="music-section-header__title">{musicText('music.user.stats')}</h2>
          <Button variant="ghost" size="sm" icon={<Clock3 size={14} />} onClick={() => navigateToAddress(historyHref)}>
            {musicText('music.user.heatmap')}
          </Button>
        </div>
        {summaryLoading && !summary ? (
          <div className="grid gap-[var(--sp-3)] sm:grid-cols-2 xl:grid-cols-4" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-[84px] rounded-[var(--r-lg)] bg-[var(--bg-sunken)]" />
            ))}
          </div>
        ) : (
          <>
            {summaryError && (
              <QueryError title={musicText('music.heatmap.error')} detail={summaryError} onRetry={onRetrySummary} />
            )}
            <div className="grid gap-[var(--sp-3)] sm:grid-cols-2 xl:grid-cols-4">
              <MusicStatCard
                icon={<Play size={16} aria-hidden="true" />}
                label={musicText('music.user.stat.plays')}
                value={musicText('music.heatmap.plays', { count: summary?.totalPlays ?? 0 })}
              />
              <MusicStatCard
                icon={<Clock3 size={16} aria-hidden="true" />}
                label={musicText('music.user.stat.active_days')}
                value={musicText('music.heatmap.days', { count: summary?.activeDays ?? 0 })}
              />
              <MusicStatCard
                icon={<Heart size={16} aria-hidden="true" />}
                label={musicText('music.user.stat.favorites')}
                value={musicText('music.common.track_count', { count: favorites })}
              />
              <MusicStatCard
                icon={<ListMusic size={16} aria-hidden="true" />}
                label={musicText('music.user.stat.playlists')}
                value={musicText('music.user.count_playlists', { count: playlists.length })}
              />
            </div>
          </>
        )}
      </section>

      <section aria-label={musicText('music.user.created_playlists')} className="flex flex-col gap-[var(--sp-3)]">
        <header className="music-section-header">
          <div className="music-section-header__text">
            <h2 className="music-section-header__title">{musicText('music.user.created_playlists')}</h2>
            <p className="music-section-header__description">
              {musicText('music.user.count_playlists', { count: playlists.length })}
            </p>
          </div>
          <Button variant="secondary" size="sm" icon={<ListPlus size={14} />} onClick={onImport}>
            {musicText('music.user.import_playlist')}
          </Button>
        </header>
        {playlists.length === 0 ? (
          <Empty
            art="folder"
            compact
            title={musicText('music.user.created_empty')}
            description={musicText('music.user.created_empty_hint')}
            action={(
              <Button variant="secondary" onClick={onImport}>
                {musicText('music.user.import_playlist')}
              </Button>
            )}
          />
        ) : (
          <div className="music-card-grid">
            {playlists.map((playlist) => (
              <MediaCard
                key={playlist.id}
                href={musicPathFor({ kind: 'playlist', id: playlist.id })}
                title={playlist.name}
                meta={musicText('music.common.track_count', { count: playlist.trackCount })}
                coverUrl={playlist.coverUrl}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label={musicText('music.user.ranking')} className="flex flex-col gap-[var(--sp-3)]">
        <header className="music-section-header">
          <div className="music-section-header__text">
            <h2 className="music-section-header__title">{musicText('music.user.ranking')}</h2>
            <p className="music-section-header__description">
              {musicText('music.user.ranking_hint')}
            </p>
          </div>
        </header>
        {top.length === 0 ? (
          <Empty
            art="archive"
            compact
            title={musicText('music.user.ranking_empty')}
            description={musicText('music.user.ranking_empty_hint')}
            action={(
              <Button variant="secondary" onClick={() => navigateToAddress(homeHref)}>
                {musicText('music.user.home')}
              </Button>
            )}
          />
        ) : (
          <ol className="flex flex-col gap-[var(--sp-0-5)]">
            {top.map((row, index) => (
              <li key={row.track.id} className="flex items-center gap-[var(--sp-2)] rounded-[var(--r-sm)] hover:bg-[var(--bg-hover)]">
                <span className="w-6 shrink-0 text-center text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
                  {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() => playTop(row.track, queue)}
                  className="flex min-w-0 flex-1 items-center gap-[var(--sp-3)] rounded-[var(--r-sm)] px-[var(--sp-2)] py-[var(--sp-1)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                >
                  <Cover trackId={row.track.id} size="sm" />
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                      {row.track.title}
                    </span>
                    <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {musicArtistNames(row.track)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
                    {musicText('music.user.times', { count: row.count })}
                  </span>
                </button>
                <IconButton
                  label={musicText('music.history.play_track', { title: row.track.title })}
                  size="sm"
                  className="me-[var(--sp-1)]"
                  onClick={() => playTop(row.track, queue)}
                >
                  <Play size={14} />
                </IconButton>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}

function playTop(track: MusicTrack, queue: readonly MusicTrack[]): void {
  void useMusicPlayer.getState().playTrack(track, { queue })
}
