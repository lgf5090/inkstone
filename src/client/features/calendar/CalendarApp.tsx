/**
 * `/calendar`: the container that owns loading, failure, empty and ready.
 *
 * The surface is mounted only after metadata and the first range have arrived, so DayFlow never sees
 * a half-built registry. A reload keeps the same range around today; navigation beyond it is the
 * surface's own incremental fetch.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CalendarDays } from 'lucide-react'
import type { CalendarEventDto, CalendarMetaDto, CalendarPreferences, CalendarRangeRevisionDto } from '@shared/calendar/model'
import { normalizeCalendarPreferences } from '@shared/calendar/model'
import { t, useLocaleRepaint } from '../../lib/i18n'
import { Empty, Skeleton } from '../../components/feedback'
import { Button } from '../../components/primitives'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { CalendarSurface } from './CalendarSurface'
import { paintableRange } from './range-cache'
import { readFirstPaintMeta, saveFirstPaintMeta } from './first-paint'
import { CalendarFormDialog } from './CalendarDialogs'
import { INITIAL_RANGE_DAYS } from './model'
import * as api from './api'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; meta: CalendarMetaDto; events: CalendarEventDto[]; occurrences: CalendarEventDto[]; truncated: boolean; recurrenceTruncated: boolean; revision: CalendarRangeRevisionDto | null }

const DAY_MS = 24 * 60 * 60 * 1000

const OAUTH_ERROR_KEYS = {
  access_denied: 'calendar.connections.oauth_error_access_denied',
  invalid_state: 'calendar.connections.oauth_error_invalid_state',
  provider_not_configured: 'calendar.connections.oauth_error_provider_not_configured',
  unauthenticated: 'calendar.connections.oauth_error_unauthenticated',
  failed: 'calendar.connections.oauth_error_failed',
} as const

function oauthErrorKey(code: string | null): keyof typeof OAUTH_ERROR_KEYS {
  return code && code in OAUTH_ERROR_KEYS ? code as keyof typeof OAUTH_ERROR_KEYS : 'failed'
}

function initialRange(): { from: number; to: number } {
  const now = Date.now()
  return { from: now - INITIAL_RANGE_DAYS * DAY_MS, to: now + INITIAL_RANGE_DAYS * DAY_MS }
}

function LoadingCalendar() {
  return (
    <section aria-busy="true" className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <span role="status" className="sr-only">{t('calendar.loading')}</span>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <CalendarDays size={15} className="text-[var(--text-secondary)]" aria-hidden="true" />
        <Skeleton className="h-3 w-24" />
      </header>
      <div className="flex min-h-0 flex-1">
        <aside aria-hidden="true" className="hidden w-60 shrink-0 space-y-2 border-r border-[var(--border-subtle)] p-3 md:block">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-4/5" />
        </aside>
        <div aria-hidden="true" className="grid min-w-0 flex-1 grid-cols-7 gap-px p-3">
          {Array.from({ length: 35 }, (_, index) => (
            <Skeleton key={index} className="min-h-16" />
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * The last visit's calendars and range, in the shape the ready state wants.
 *
 * Returned only when both halves exist: metadata without events is a skeleton with extra steps, and
 * events without metadata cannot be drawn at all.
 */
function cachedFirstPaint(userId: string | null, range: { from: number; to: number }): LoadState | null {
  if (!userId) return null
  const meta = readFirstPaintMeta(userId)
  const page = paintableRange(userId, range.from, range.to)
  if (!meta || !page) return null
  return {
    status: 'ready',
    meta,
    events: page.events,
    occurrences: page.occurrences,
    truncated: false,
    recurrenceTruncated: false,
    revision: page.revision,
  }
}

export function CalendarApp() {
  useLocaleRepaint()
  const userId = useSession(state => state.user?.id ?? null)
  const [range] = useState(initialRange)
  const [state, setState] = useState<LoadState>(() => cachedFirstPaint(userId, range) ?? { status: 'loading' })
  const statusRef = useRef(state.status)
  statusRef.current = state.status
  const [attempt, setAttempt] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    const url = new URL(window.location.href)
    const result = url.searchParams.get('calendarConnect')
    if (!result) return
    const code = url.searchParams.get('code')
    if (result === 'done') {
      useUi.getState().toast({ title: t('calendar.connections.oauth_done'), tone: 'success' })
    } else {
      useUi.getState().toast({
        title: t('calendar.connections.oauth_failed'),
        description: t(OAUTH_ERROR_KEYS[oauthErrorKey(code)]),
        tone: 'danger',
      })
    }
    url.searchParams.delete('calendarConnect')
    url.searchParams.delete('code')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  const fetchAll = useCallback(async (signal?: AbortSignal): Promise<{ meta: CalendarMetaDto; events: CalendarEventDto[]; occurrences: CalendarEventDto[]; truncated: boolean; recurrenceTruncated: boolean; revision: CalendarRangeRevisionDto | null }> => {
    const [meta, eventPage] = await Promise.all([
      api.getMeta(signal),
      api.getEvents(range, signal),
    ])
    const { events, occurrences, truncated, recurrenceTruncated, revision } = eventPage
    if (meta.preferencesInitialized === false) {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const preferences = normalizeCalendarPreferences({
        ...meta.preferences,
        ...(timeZone ? { timeZone } : {}),
      })
      try {
        await api.putPreferences(preferences)
        return { meta: { ...meta, preferences, preferencesInitialized: true }, events, occurrences, truncated, recurrenceTruncated, revision }
      } catch (error) {
        useUi.getState().toast({
          title: t('calendar.error.save_failed'),
          description: error instanceof Error ? error.message : undefined,
          tone: 'danger',
        })
      }
    }
    return { meta, events, occurrences, truncated, recurrenceTruncated, revision }
  }, [range])

  useEffect(() => {
    const controller = new AbortController()
    // A cached paint is already on screen; replacing it with the skeleton would be a flash of nothing.
    setState(current => (current.status === 'ready' ? current : { status: 'loading' }))
    void fetchAll(controller.signal).then(({ meta, events, occurrences, truncated, recurrenceTruncated, revision }) => {
      if (controller.signal.aborted) return
      if (userId) saveFirstPaintMeta(userId, meta)
      setState({ status: 'ready', meta, events, occurrences, truncated, recurrenceTruncated, revision })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const message = error instanceof Error && error.message ? error.message : t('calendar.error.load')
      // A page already painted from the cache keeps working when the revalidation fails; replacing it
      // with the error screen would take a readable calendar away because a refresh did not answer.
      if (statusRef.current === 'ready') {
        useUi.getState().toast({ title: t('calendar.error.refresh'), description: message, tone: 'danger' })
        return
      }
      setState({ status: 'error', error: message })
    })
    return () => controller.abort()
  }, [attempt, fetchAll])

  const refreshMeta = useCallback(async (): Promise<CalendarMetaDto> => {
    const meta = await api.getMeta()
    if (userId) saveFirstPaintMeta(userId, meta)
    setState(current => (current.status === 'ready' ? { ...current, meta } : current))
    return meta
  }, [userId])

  const savePreferences = useCallback(async (next: CalendarPreferences): Promise<void> => {
    await api.putPreferences(next)
    const preferences = normalizeCalendarPreferences(next)
    setState(current => (current.status === 'ready'
      ? { ...current, meta: { ...current.meta, preferences } }
      : current))
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const { meta, events, occurrences, truncated, recurrenceTruncated, revision } = await fetchAll()
    setState({ status: 'ready', meta, events, occurrences, truncated, recurrenceTruncated, revision })
  }, [fetchAll])

  if (state.status === 'loading') return <LoadingCalendar />

  if (state.status === 'error') {
    return (
      <section className="flex h-full min-h-0 items-center justify-center bg-[var(--bg-base)] px-6">
        <div role="alert" className="flex max-w-md flex-col items-center text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--danger)]">
            <AlertTriangle size={22} aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('calendar.error.load')}</h1>
          <p className="mt-1.5 text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-tertiary)]">{t('calendar.error.load_hint')}</p>
          <p className="mt-1 max-w-full break-words text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{state.error}</p>
          <Button className="mt-4" variant="primary" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</Button>
        </div>
      </section>
    )
  }

  if (state.meta.calendars.length === 0) {
    return (
      <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
          <CalendarDays size={15} className="text-[var(--text-secondary)]" aria-hidden="true" />
          <h1 className="min-w-0 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">{t('calendar.app.title')}</h1>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Empty
            art="subscriptions"
            title={t('calendar.empty.title')}
            description={t('calendar.empty.description')}
            action={<Button variant="primary" onClick={() => setCreateOpen(true)}>{t('calendar.empty.action')}</Button>}
          />
        </div>
        {createOpen && (
          <CalendarFormDialog
            open
            mode="create"
            groups={state.meta.groups}
            onClose={() => setCreateOpen(false)}
            onSaved={async () => {
              try {
                await reload()
              } catch (error) {
                useUi.getState().toast({
                  title: t('calendar.error.load'),
                  description: error instanceof Error ? error.message : undefined,
                  tone: 'danger',
                })
                throw error
              }
            }}
          />
        )}
      </section>
    )
  }

  return (
    <CalendarSurface
      meta={state.meta}
      initialEvents={state.events}
      initialOccurrences={state.occurrences}
      initialTruncated={state.truncated}
      initialRecurrenceTruncated={state.recurrenceTruncated}
      initialRevision={state.revision}
      initialRange={range}
      onRefreshMeta={refreshMeta}
      onSavePreferences={savePreferences}
    />
  )
}

export default CalendarApp
