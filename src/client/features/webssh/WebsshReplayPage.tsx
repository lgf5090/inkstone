import { useCallback, useEffect, useState } from 'react'
import { KeyRound, SquareTerminal } from 'lucide-react'
import type { WebsshPublicShareView } from '@shared/webssh/types'
import { Button } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { CastPlayer } from './CastPlayer'
import { websshApi } from './api'

type Phase = 'loading' | 'password' | 'ready' | 'missing' | 'rate' | 'error'

export function WebsshReplayPage({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [view, setView] = useState<WebsshPublicShareView | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retryAfter, setRetryAfter] = useState<number | null>(null)

  const open = useCallback(async (passcode?: string) => {
    setPhase('loading')
    setError(null)
    try {
      const opened = await websshApi.openShare(slug, passcode)
      setView(opened)
      setPhase('ready')
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 401) {
          setPhase('password')
          setError(passcode ? t('webssh.replay.wrong_password') : null)
          return
        }
        if (caught.status === 404) {
          setPhase('missing')
          return
        }
        if (caught.status === 429) {
          const details = caught.details as { retryAfter?: number } | undefined
          setRetryAfter(typeof details?.retryAfter === 'number' ? details.retryAfter : null)
          setPhase('rate')
          return
        }
        setError(caught.message)
      } else {
        setError(t('webssh.error.generic'))
      }
      setPhase('error')
    }
  }, [slug])

  useEffect(() => {
    void open()
  }, [open])

  const loadSlice = useCallback(async (offset: number, limit: number) => {
    const slice = await websshApi.publicFrames(slug, offset, limit)
    return { nextOffset: slice.nextOffset, complete: slice.complete, frames: slice.frames, header: slice.header }
  }, [slug])

  return (
    <div className="flex min-h-screen w-full flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <SquareTerminal size={16} aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]" />
        <h1 className="min-w-0 flex-1 truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {view?.share.title || t('webssh.replay.public_title')}
        </h1>
        {view && (
          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('webssh.replay.public_badge')}
          </span>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-[1100px] min-w-0 flex-1 flex-col gap-3 p-3 sm:p-5">
        {phase === 'loading' && (
          <p className="text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('webssh.replay.loading')}</p>
        )}

        {phase === 'password' && (
          <form
            className="mx-auto w-full max-w-[380px] space-y-3 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-4"
            onSubmit={(event) => {
              event.preventDefault()
              void open(password)
            }}
          >
            <div className="flex items-center gap-2">
              <KeyRound size={16} aria-hidden="true" className="text-[var(--text-secondary)]" />
              <h2 className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('webssh.replay.password_title')}</h2>
            </div>
            <Field label={t('webssh.replay.password_label')}>
              <Input value={password} autoFocus type="password" onChange={(event) => setPassword(event.target.value)} />
            </Field>
            {error && <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
            <Button variant="primary" type="submit" block>{t('webssh.replay.open_public')}</Button>
          </form>
        )}

        {phase === 'ready' && view && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              <span>{t('webssh.replay.size', { size: view.recording.sizeBytes })}</span>
              <span>{t('webssh.replay.duration', { seconds: Math.round(view.recording.durationMs / 1000) })}</span>
              <span>{t('webssh.replay.dimensions', { cols: view.recording.cols, rows: view.recording.rows })}</span>
              <span>{t('webssh.replay.views', { views: view.share.views })}</span>
            </div>
            <CastPlayer loadSlice={loadSlice} durationMs={view.recording.durationMs} />
          </>
        )}

        {phase === 'missing' && (
          <div className="mx-auto w-full max-w-[440px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
            <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('webssh.replay.missing')}</p>
          </div>
        )}

        {phase === 'rate' && (
          <div className="mx-auto w-full max-w-[440px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
            <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
              {retryAfter === null ? t('webssh.replay.rate_limited') : t('webssh.replay.rate_retry', { seconds: retryAfter })}
            </p>
          </div>
        )}

        {phase === 'error' && (
          <div className="mx-auto w-full max-w-[440px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
            <p className="text-[length:var(--text-13)] text-[var(--danger)]">{error ?? t('webssh.error.generic')}</p>
          </div>
        )}
      </main>
    </div>
  )
}
