/** A Netease profile: public playlists and the counts that describe the account. */
import { useId, type ReactElement } from 'react'
import type { MusicUserProfile } from '@shared/music/api'
import { Empty } from '../../../components/feedback'
import { Button } from '../../../components/primitives'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { useMusicUi } from '../store/ui'
import { musicText } from '../components/labels'
import { MediaCard, MediaGridSkeleton, RemoteAvatar } from './parts/P2MediaCard'
import {
  PAGE_STACK,
  QueryError,
  formatCount,
} from './parts/P2QueryState'

type UserPageData =
  | { connected: false; expired: boolean }
  | { connected: true; profile: MusicUserProfile }

export function UserPage(): ReactElement {
  const page = useMusicUi((state) => state.page)
  const id = page.kind === 'user' ? page.id : ''
  const headingId = useId()
  const query = useMusicQuery<UserPageData>(async () => {
    const account = await musicApi.account()
    if (!account.account || account.account.status === 'expired') {
      return { connected: false, expired: Boolean(account.account) }
    }
    return { connected: true, profile: await musicApi.user(id) }
  }, [id], { enabled: Boolean(id) })

  const loginHref = musicPathFor({ kind: 'login' })
  const homeHref = musicPathFor({ kind: 'home' })

  if (!id) {
    return (
      <section aria-label={musicText('music.page.user')} className={PAGE_STACK}>
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
      </section>
    )
  }

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <h2 id={headingId} className="sr-only">{musicText('music.page.user')}</h2>

      {query.status === 'error' && !query.data ? (
        <QueryError
          title={musicText('music.user.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !query.data ? (
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
      ) : query.data && !query.data.connected ? (
        <Empty
          art="subscriptions"
          title={musicText(query.data.expired ? 'music.user.expired' : 'music.user.disconnected')}
          description={musicText(query.data.expired ? 'music.user.expired_hint' : 'music.user.disconnected_hint')}
          action={(
            <Button variant="primary" onClick={() => navigateToAddress(loginHref)}>
              {musicText('music.user.connect')}
            </Button>
          )}
        />
      ) : query.data?.connected ? (
        <>
          {query.status === 'error' && (
            <QueryError title={musicText('music.user.error')} detail={query.error} onRetry={query.reload} />
          )}
          <header className="flex flex-col gap-[var(--sp-4)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-5)] sm:flex-row sm:items-center">
            <RemoteAvatar src={query.data.profile.avatarUrl || undefined} name={query.data.profile.nickname} size={96} />
            <div className="min-w-0 flex-1">
              <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-22)] font-semibold leading-tight tracking-[var(--tracking-title)] text-[var(--text-primary)]">
                {query.data.profile.nickname}
              </h2>
              <p className="mt-[var(--sp-1)] max-w-[60ch] text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">
                {query.data.profile.signature || musicText('music.user.signature_empty')}
              </p>
              <dl className="mt-[var(--sp-3)] flex flex-wrap items-center gap-[var(--sp-5)]">
                <div className="flex flex-col">
                  <dt className="text-[length:var(--text-10-5)] uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
                    {musicText('music.user.following')}
                  </dt>
                  <dd className="text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">
                    {formatCount(query.data.profile.follows)}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-[length:var(--text-10-5)] uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
                    {musicText('music.user.followers')}
                  </dt>
                  <dd className="text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">
                    {formatCount(query.data.profile.followers)}
                  </dd>
                </div>
              </dl>
            </div>
          </header>

          <section aria-label={musicText('music.user.playlists')} className="flex flex-col gap-[var(--sp-3)]">
            <header className="music-section-header">
              <div className="music-section-header__text">
                <h3 className="music-section-header__title">{musicText('music.user.playlists')}</h3>
                <p className="music-section-header__description">
                  {musicText('music.user.playlist_total', { count: query.data.profile.playlists.length })}
                </p>
              </div>
            </header>
            {query.data.profile.playlists.length === 0 ? (
              <Empty
                art="folder"
                compact
                title={musicText('music.user.no_playlists')}
                description={musicText('music.user.no_playlists_hint')}
              />
            ) : (
              <div className="music-card-grid">
                {query.data.profile.playlists.map((playlist) => (
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
        </>
      ) : (
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
    </section>
  )
}
