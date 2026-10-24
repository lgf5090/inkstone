/**
 * A shared playlist, read outside the account.
 *
 * The page is deliberately a still photograph: metadata and the track list, with no player. The public
 * API never returns audio addresses or provider ids, so even a copied link cannot be used to stream
 * the owner's library.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { ArrowUpRight, ListMusic, Music2 } from 'lucide-react'
import { formatDuration } from '@shared/music/format'
import type { MusicPublicPlaylistPayload } from '@shared/music/api'
import { Button, Spinner } from '../../../components/primitives'
import { musicApi } from '../api'
import { musicText } from '../components/labels'
import { formatDateTime } from './parts/P2QueryState'

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: MusicPublicPlaylistPayload }
  | { status: 'error'; error: string }

export function PublicPlaylistPage({ slug }: { slug: string }): ReactElement {
  const [state, setState] = useState<State>({ status: 'loading' })

  const load = (): void => {
    setState({ status: 'loading' })
    musicApi.publicPlaylist(slug).then(
      (data) => setState({ status: 'ready', data }),
      (error: unknown) => setState({ status: 'error', error: error instanceof Error ? error.message : String(error) }),
    )
  }

  useEffect(() => {
    load()
  }, [slug])

  useEffect(() => {
    if (state.status === 'ready') document.title = `${state.data.playlist.name} · ${musicText('music.public.eyebrow')}`
  }, [state])

  return (
    <main className="min-h-full bg-[var(--bg-base)] px-4 py-8 md:px-8 md:py-12">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
        <header className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            <Music2 size={16} className="text-[var(--accent)]" aria-hidden="true" />
            {musicText('music.page.home')}
          </span>
          <a
            href="/"
            className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            {musicText('music.public.open_app')}
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </header>

        {state.status === 'loading' && (
          <div className="flex min-h-[320px] items-center justify-center" role="status" aria-label={musicText('music.public.loading')}>
            <Spinner />
          </div>
        )}

        {state.status === 'error' && (
          <section className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-6 py-10 text-center">
            <ListMusic size={26} className="text-[var(--text-quaternary)]" aria-hidden="true" />
            <h1 className="text-[length:var(--text-17)] font-semibold text-[var(--text-primary)]">
              {musicText('music.public.not_found')}
            </h1>
            <p className="max-w-[420px] text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
              {musicText('music.public.not_found_hint')}
            </p>
            <Button variant="secondary" onClick={load}>{musicText('common.retry')}</Button>
          </section>
        )}

        {state.status === 'ready' && (
          <>
            <section className="flex flex-col gap-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-5)] sm:flex-row sm:items-end">
              <span className="flex size-[132px] shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-[var(--bg-sunken)]">
                {state.data.playlist.coverUrl
                  ? <img src={state.data.playlist.coverUrl} alt="" className="size-full object-cover" />
                  : <ListMusic size={30} className="text-[var(--text-quaternary)]" aria-hidden="true" />}
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[length:var(--text-11)] font-medium uppercase tracking-[var(--tracking-section)] text-[var(--accent)]">
                  {musicText('music.public.eyebrow')}
                </span>
                <h1 className="break-words font-[family-name:var(--font-display)] text-[length:var(--text-26)] font-semibold leading-tight text-[var(--text-primary)]">
                  {state.data.playlist.name}
                </h1>
                {state.data.playlist.description && (
                  <p className="max-w-[560px] whitespace-pre-line text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">
                    {state.data.playlist.description}
                  </p>
                )}
                <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                  {musicText('music.common.track_count', { count: state.data.playlist.trackCount })}
                  {' · '}
                  {musicText('music.public.updated', { date: formatDateTime(state.data.playlist.updatedAt) })}
                </p>
              </div>
            </section>

            <p role="note" className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
              {musicText('music.public.audio_note')}
            </p>

            <section aria-label={musicText('music.public.tracks')} className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              <ol className="divide-y divide-[var(--border-subtle)]">
                {state.data.tracks.map((track) => (
                  <li key={track.position} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                    <span className="w-6 shrink-0 text-right text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
                      {track.position}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{track.title}</span>
                      <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        {[track.artists, track.album].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="shrink-0 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
                      {formatDuration(track.durationMs)}
                    </span>
                  </li>
                ))}
              </ol>
              {state.data.tracks.length === 0 && (
                <p className="px-4 py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {musicText('music.public.empty')}
                </p>
              )}
            </section>
            {state.data.truncated && (
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {musicText('music.public.truncated', { count: state.data.tracks.length })}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  )
}
