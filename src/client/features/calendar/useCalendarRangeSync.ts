/**
 * Range reads, cached first paint, occurrence projection and revision probing for the calendar surface.
 *
 * The hook owns the data lifecycle around DayFlow: it turns visible-range notifications into bounded
 * requests, applies complete server snapshots without echoing them back as writes, and keeps the
 * occurrence view in step with the current month. The surface only renders the resulting state.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Event, ICalendarApp } from '@dayflow/react'
import type {
  CalendarEventDto,
  CalendarPreferences,
  CalendarRangeRevisionDto,
} from '@shared/calendar/model'
import { temporalToEpochMs } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { toastFailure } from './calendar-notifications'
import { EventPersistence } from './persistence'
import { outboxEventIds } from './offline-outbox'
import { paintableRange, rangeFor, sameRevision, saveRange } from './range-cache'
import { canProbeRangeRevision, nextRevisionProbeCount, paddedCalendarRange, rangeIsCovered, type CalendarRange } from './range-sync'
import { printPeriod } from './print'
import {
  isRecurrenceOccurrence,
  planEventSnapshot,
  toDayFlowEvent,
  toPersistedCalendarEvent,
} from './model'
import * as api from './api'

interface UseCalendarRangeSyncOptions {
  app: ICalendarApp
  userId: string | undefined
  initialEvents: CalendarEventDto[]
  initialOccurrences: CalendarEventDto[]
  initialTruncated: boolean
  initialRecurrenceTruncated: boolean
  initialRevision: CalendarRangeRevisionDto | null
  initialCached: boolean
  initialRange: CalendarRange
  preferences: () => CalendarPreferences
  revs: Map<string, number>
  persistenceRef: RefObject<EventPersistence | null>
  onVisibleRange: (from: number, to: number) => void
}

/** Only a complete, fingerprinted answer is safe to replay after a reload. */
function rememberRange(userId: string, from: number, to: number, page: api.EventRangeResponse): void {
  if (!page.revision || page.truncated || page.recurrenceTruncated) return
  saveRange(userId, {
    from,
    to,
    savedAt: Date.now(),
    revision: page.revision,
    events: page.events.map(toPersistedCalendarEvent),
    occurrences: page.occurrences.map(toPersistedCalendarEvent),
  })
}

export function useCalendarRangeSync({
  app,
  userId,
  initialEvents,
  initialOccurrences,
  initialTruncated,
  initialRecurrenceTruncated,
  initialRevision,
  initialCached,
  initialRange,
  preferences,
  revs,
  persistenceRef,
  onVisibleRange,
}: UseCalendarRangeSyncOptions) {
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [rangeLoading, setRangeLoading] = useState(false)
  const [rangeTruncated, setRangeTruncated] = useState(initialTruncated || initialRecurrenceTruncated)

  const accountRef = useRef<string | null>(null)
  accountRef.current = userId ?? null

  // A truncated first page cannot prove that a smaller visible range is covered; let the surface
  // fetch that range on its own instead of trusting a page that already hit its row ceiling.
  const covered = useRef<Array<[number, number]>>(
    initialTruncated || initialRecurrenceTruncated || initialCached ? [] : [[initialRange.from, initialRange.to]],
  )
  const inFlight = useRef<Array<[number, number]>>([])
  const latestRangeRequest = useRef(0)
  const lastRange = useRef<CalendarRange>(initialRange)
  const failedRange = useRef<CalendarRange | null>(null)
  /** Silent refreshes answered by the fingerprint alone; the fifth one re-reads the rows anyway. */
  const probedRefreshes = useRef(0)
  /** The last complete answer, kept so it can be remembered once the account is known. */
  const lastPage = useRef<{ from: number; to: number; page: api.EventRangeResponse } | null>(
    initialRevision && !initialTruncated && !initialRecurrenceTruncated
      ? {
          from: initialRange.from,
          to: initialRange.to,
          page: {
            events: initialEvents,
            occurrences: initialOccurrences,
            truncated: initialTruncated,
            recurrenceTruncated: initialRecurrenceTruncated,
            revision: initialRevision,
          },
        }
      : null,
  )
  /** The fingerprint whose rows the grid already holds; the shell can replace its page after a cached paint. */
  const appliedRevision = useRef<CalendarRangeRevisionDto | null>(initialRevision ?? null)

  const occurrenceRef = useRef<Map<string, Event> | null>(null)
  if (!occurrenceRef.current) {
    occurrenceRef.current = new Map(initialOccurrences.map(dto => [dto.id, toDayFlowEvent(dto, preferences().timeZone)]))
  }
  const occurrenceRefreshTimer = useRef<number | undefined>(undefined)
  /** Masters whose rule was just hidden by an exception; the next month read must expand them. */
  const freshExceptionMasters = useRef(new Set<string>())

  const syncOccurrences = useCallback((events: Event[] = app.getEvents(), view: string = app.getCurrentView().type) => {
    const occurrences = occurrenceRef.current
    if (!occurrences) return
    const current = new Set(events.filter(event => isRecurrenceOccurrence(event)).map(event => event.id))
    const exceptionMasters = new Set(events
      .filter(event => Array.isArray(event.meta?.exdates) && event.meta.exdates.length > 0)
      .map(event => event.id))
    const desired = view === 'month'
      ? [...occurrences.values()].filter(event => exceptionMasters.has(event.id.split('::repeat-')[0] ?? ''))
      : [...occurrences.values()]
    const desiredIds = new Set(desired.map(event => event.id))
    const add = desired.filter(event => !current.has(event.id))
    const remove = [...current].filter(id => !desiredIds.has(id))
    if (add.length === 0 && remove.length === 0) return
    app.applyEventsChanges({
      ...(add.length > 0 ? { add } : {}),
      ...(remove.length > 0 ? { delete: remove } : {}),
    }, false, 'remote')
  }, [app])

  const dropOccurrencesForMaster = useCallback((masterId: string): void => {
    const occurrences = occurrenceRef.current
    if (!occurrences) return
    let changed = false
    for (const [id, event] of occurrences) {
      if (event.id.startsWith(`${masterId}::repeat-`)) {
        occurrences.delete(id)
        changed = true
      }
    }
    if (changed) syncOccurrences()
  }, [syncOccurrences])

  const updateOccurrences = useCallback((dtos: CalendarEventDto[], range: CalendarRange): void => {
    const occurrences = occurrenceRef.current
    if (!occurrences) return
    const timeZone = preferences().timeZone
    const incoming = new Map(dtos.map(dto => [dto.id, toDayFlowEvent(dto, timeZone)]))
    for (const [id, event] of occurrences) {
      const start = temporalToEpochMs(event.start, timeZone)
      if (start >= range.from && start <= range.to && !incoming.has(id)) occurrences.delete(id)
    }
    for (const [id, event] of incoming) occurrences.set(id, event)
    syncOccurrences()
  }, [preferences, syncOccurrences])

  useEffect(() => () => window.clearTimeout(occurrenceRefreshTimer.current), [])

  const applySnapshot = useCallback((
    dtos: CalendarEventDto[],
    range: CalendarRange,
    truncated: boolean,
    options: { mirror?: boolean; updateRevisions?: boolean } = {},
  ): Set<string> => {
    const queued = accountRef.current ? outboxEventIds(accountRef.current) : new Set<string>()
    const plan = planEventSnapshot({
      dtos,
      existing: app.getEvents().filter(event => !isRecurrenceOccurrence(event)),
      range,
      timeZone: preferences().timeZone,
      truncated,
      mirror: options.mirror,
      updateRevisions: options.updateRevisions,
      hasPending: id => queued.has(id) || persistenceRef.current?.hasPending(id) === true,
    })
    for (const [id, rev] of plan.revisions) revs.set(id, rev)
    if (plan.add.length > 0 || plan.update.length > 0) {
      persistenceRef.current?.skip(plan.fetched)
      app.applyEventsChanges({ add: plan.add, update: plan.update }, false, 'remote')
    }
    if (plan.stale.length > 0) {
      persistenceRef.current?.skip(plan.stale)
      app.applyEventsChanges({ delete: plan.stale }, false, 'remote')
      for (const id of plan.stale) revs.delete(id)
    }
    return plan.fetched
  }, [app, persistenceRef, preferences, revs])

  const fetchRange = useCallback(async (from: number, to: number, requestId?: number): Promise<Set<string>> => {
    const month = app.getCurrentView().type === 'month'
    const exceptionMasters = month
      ? [...new Set([
          ...app.getEvents()
            .filter(event => Array.isArray(event.meta?.exdates) && event.meta.exdates.length > 0)
            .map(event => event.id),
          ...freshExceptionMasters.current,
        ])]
      : []
    const page = await api.getEvents({
      from,
      to,
      includeOccurrences: !month || exceptionMasters.length > 0,
      ...(month && exceptionMasters.length > 0 ? { occurrenceMasters: exceptionMasters } : {}),
    })
    if (requestId !== undefined && requestId !== latestRangeRequest.current) return new Set()
    const fetched = applySnapshot(page.events, { from, to }, page.truncated)
    updateOccurrences(page.occurrences, { from, to })
    setRangeTruncated(page.truncated || page.recurrenceTruncated)
    lastRange.current = { from, to }
    lastPage.current = { from, to, page }
    if (accountRef.current) rememberRange(accountRef.current, from, to, page)
    return fetched
  }, [app, applySnapshot, updateOccurrences])

  /** Ask the fingerprint before pulling rows; every fifth refresh is a full-read backstop. */
  const rangeIsUnchanged = useCallback(async (from: number, to: number): Promise<boolean> => {
    const cached = userId ? rangeFor(userId, from, to) : null
    if (!cached || !canProbeRangeRevision(probedRefreshes.current)) {
      if (cached && !canProbeRangeRevision(probedRefreshes.current)) probedRefreshes.current = 0
      return false
    }
    try {
      const revision = await api.getEventsRevision({ from, to })
      const unchanged = sameRevision(revision, cached.revision)
      probedRefreshes.current = nextRevisionProbeCount(probedRefreshes.current, unchanged)
      return unchanged
    } catch {
      // The probe is an optimisation; a refused or failed one means the rows are read as before.
      return false
    }
  }, [userId])

  const reloadLastRange = useCallback(async (eventId?: string, status?: number): Promise<void> => {
    const range = lastRange.current
    try {
      // A refresh with no write behind it is the one worth probing; a call naming an event is handling
      // that write's outcome and always re-reads.
      if (eventId === undefined && status === undefined && await rangeIsUnchanged(range.from, range.to)) {
        return
      }
      const fetched = await fetchRange(range.from, range.to)
      if (eventId && status && (status === 400 || status === 404) && !fetched.has(eventId)) {
        revs.delete(eventId)
        persistenceRef.current?.skip([eventId])
        app.applyEventsChanges({ delete: [eventId] }, false, 'remote')
        lastRange.current = range
      }
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
    }
  }, [app, fetchRange, persistenceRef, rangeIsUnchanged, revs])

  const reloadRef = useRef(reloadLastRange)
  reloadRef.current = reloadLastRange

  const runRangeFetch = useCallback(async (from: number, to: number): Promise<void> => {
    const requestId = ++latestRangeRequest.current
    setRangeLoading(true)
    try {
      await fetchRange(from, to, requestId)
      if (requestId !== latestRangeRequest.current) return
      covered.current.push([from, to])
      failedRange.current = null
      setRangeError(null)
    } catch (error) {
      if (requestId !== latestRangeRequest.current) return
      failedRange.current = { from, to }
      setRangeError(error instanceof Error && error.message ? error.message : t('calendar.error.range'))
    } finally {
      if (requestId === latestRangeRequest.current) setRangeLoading(false)
    }
  }, [fetchRange])

  const loadRange = useCallback((start: number, end: number): void => {
    // A visible day/week already inside the shell's first page needs no padded refetch, even though
    // the padded range would extend past it. This keeps the first week at one request.
    if (rangeIsCovered(covered.current, start, end) || rangeIsCovered(inFlight.current, start, end)) return
    const { from, to } = paddedCalendarRange(start, end)
    if (rangeIsCovered(covered.current, from, to) || rangeIsCovered(inFlight.current, from, to)) return
    // The last complete answer for this range goes up before the request leaves, so a reload paints the
    // reader's week instead of an empty grid. The fetch below replaces it with the server's answer.
    const cached = userId ? paintableRange(userId, from, to) : null
    if (cached) {
      applySnapshot(cached.events, { from, to }, false, { mirror: false, updateRevisions: false })
      updateOccurrences(cached.occurrences, { from, to })
    }
    inFlight.current.push([from, to])
    void runRangeFetch(from, to).finally(() => {
      inFlight.current = inFlight.current.filter(([rangeFrom, rangeTo]) => rangeFrom !== from || rangeTo !== to)
    })
  }, [applySnapshot, runRangeFetch, updateOccurrences, userId])

  const retryRange = useCallback((): void => {
    const range = failedRange.current
    if (!range) return
    inFlight.current.push([range.from, range.to])
    void runRangeFetch(range.from, range.to).finally(() => {
      inFlight.current = inFlight.current.filter(([from, to]) => from !== range.from || to !== range.to)
    })
  }, [runRangeFetch])

  const scheduleOccurrenceRefresh = useCallback((masterId: string): void => {
    dropOccurrencesForMaster(masterId)
    window.clearTimeout(occurrenceRefreshTimer.current)
    occurrenceRefreshTimer.current = window.setTimeout(() => { void reloadRef.current() }, 300)
  }, [dropOccurrencesForMaster])

  const markExceptionMaster = useCallback((masterId: string): void => {
    freshExceptionMasters.current.add(masterId)
  }, [])

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      void reloadRef.current()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  /** Apply a page that arrives after the first paint, including deletions from a cached first frame. */
  useEffect(() => {
    if (!initialRevision) return
    const page: api.EventRangeResponse = {
      events: initialEvents,
      occurrences: initialOccurrences,
      truncated: initialTruncated,
      recurrenceTruncated: initialRecurrenceTruncated,
      revision: initialRevision,
    }
    if (accountRef.current) rememberRange(accountRef.current, initialRange.from, initialRange.to, page)
    if (appliedRevision.current && sameRevision(appliedRevision.current, initialRevision)) return
    appliedRevision.current = initialRevision
    applySnapshot(initialEvents, { from: initialRange.from, to: initialRange.to }, initialTruncated, {
      mirror: !initialCached,
      updateRevisions: !initialCached,
    })
    updateOccurrences(initialOccurrences, { from: initialRange.from, to: initialRange.to })
    lastRange.current = { from: initialRange.from, to: initialRange.to }
    lastPage.current = { from: initialRange.from, to: initialRange.to, page }
  }, [
    applySnapshot,
    initialCached,
    initialEvents,
    initialOccurrences,
    initialRange.from,
    initialRange.to,
    initialRecurrenceTruncated,
    initialRevision,
    initialTruncated,
    updateOccurrences,
  ])

  /** Once the account is known, remember the first answer and paint what the last visit left. */
  useEffect(() => {
    if (!userId) return
    const page = lastPage.current
    if (page) rememberRange(userId, page.from, page.to, page.page)
    const range = lastRange.current
    const cached = paintableRange(userId, range.from, range.to)
    if (!cached) return
    applySnapshot(cached.events, { from: range.from, to: range.to }, false, { mirror: false, updateRevisions: false })
    updateOccurrences(cached.occurrences, { from: range.from, to: range.to })
  }, [applySnapshot, updateOccurrences, userId])

  // The shell fetches only a two-week first page. A month or year view still needs its own
  // (padded) range, and waiting for the first scroll to ask for it would leave the grid empty.
  const initialVisibleRangeLoaded = useRef(false)
  useEffect(() => {
    if (initialVisibleRangeLoaded.current) return
    initialVisibleRangeLoaded.current = true
    const current = preferences()
    const period = printPeriod(
      String(app.getCurrentView().type).toLowerCase(),
      app.getCurrentDate(),
      current.timeZone,
      current.weekStart,
      current.agendaDays,
    )
    loadRange(period.fromMs, period.toMs)
  }, [app, loadRange, preferences])

  useEffect(() => app.subscribeVisibleRangeChange(payload => {
    const from = payload.start.getTime()
    const to = payload.end.getTime()
    onVisibleRange(from, to)
    loadRange(from, to)
  }), [app, loadRange, onVisibleRange])

  useEffect(() => {
    let previousEvents = app.getEvents()
    let previousView = app.getCurrentView().type
    const sync = (): void => {
      const events = app.getEvents()
      const view = app.getCurrentView().type
      if (events === previousEvents && view === previousView) return
      previousEvents = events
      previousView = view
      syncOccurrences(events, view)
    }
    syncOccurrences(previousEvents, previousView)
    return app.subscribe(sync)
  }, [app, syncOccurrences])

  return {
    rangeError,
    rangeLoading,
    rangeTruncated,
    retryRange,
    loadRange,
    reloadRef,
    lastRange,
    dropOccurrencesForMaster,
    scheduleOccurrenceRefresh,
    markExceptionMaster,
  }
}
