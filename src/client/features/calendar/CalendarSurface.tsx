/**
 * The live calendar surface: DayFlow, the plugins, the native sidebar and the write queue.
 *
 * Configuration is created once, because `useCalendarApp` builds its app from the first config. Later
 * preference changes go through `app.updateConfig`, which re-installs views without rebuilding the
 * app or losing the current selection. Range loading and persistence both apply server state with
 * `source: 'remote'` and a skip set, so a refresh never echoes back as a write.
 */
import '@dayflow/core/dist/styles.components.css'
import '@dayflow/plugin-sidebar/dist/styles.components.css'
import './calendar.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DayFlowCalendar,
  ViewType,
  createAgendaView,
  createDayView,
  createMonthView,
  createWeekView,
  createYearView,
  useCalendarApp,
  type CalendarAppConfig,
  type CalendarCallbacks,
  type CalendarSearchProps,
  type CalendarPlugin,
  type CalendarType,
  type CalendarView,
  type Event,
  type ICalendarApp,
} from '@dayflow/react'
import { createDragPlugin } from '@dayflow/plugin-drag'
import { createKeyboardShortcutsPlugin } from '@dayflow/plugin-keyboard-shortcuts'
import { createLocalizationPlugin, zh } from '@dayflow/plugin-localization'
import { createSidebarPlugin } from '@dayflow/plugin-sidebar'
import { AlertTriangle, Menu as MenuIcon } from 'lucide-react'
import type {
  CalendarDto,
  CalendarEventDto,
  CalendarMetaDto,
  CalendarPreferences,
} from '@shared/calendar/model'
import { CALENDAR_RANGE_MAX_MS, CALENDAR_VIEWS, MAX_EVENTS_PER_QUERY, temporalToEpochMs, type CalendarViewName } from '@shared/calendar/model'
import type { AppLocale } from '@shared/types'
import { t, useLocale, useLocaleRepaint } from '../../lib/i18n'
import { useThemeDark } from '../../lib/hooks'
import { useUi, toastWithUndo } from '../../store/ui'
import { useSession } from '../../store/session'
import { Button, IconButton } from '../../components/primitives'
import { Drawer, confirm } from '../../components/overlay'
import { CalendarSidebar } from './CalendarSidebar'
import { CalendarSettings } from './CalendarSettings'
import { CalendarConflictDialog, type ConflictTarget } from './CalendarConflictDialog'
import { CalendarEventExtras } from './CalendarEventExtras'
import { CalendarFilteredSearch, calendarSearchResultDate } from './CalendarFilteredSearch'
import { CalendarConnections } from './CalendarConnections'
import { CalendarEditHistory } from './history'
import { EventPersistence } from './persistence'
import type { ConflictRequest, ConflictResolution } from './persistence'
import type { ConflictView } from './conflict'
import { attachCalendarProviders } from './providers'
import { calendarRouteHref, readCalendarRouteState } from './view-state'
import * as api from './api'
import type { CalendarPatchInput } from './api'
import {
  calendarSourceOf,
  MONTH_EVENT_HEIGHT,
  RANGE_PADDING_DAYS,
  eventCalendarIds,
  isRecurrenceOccurrence,
  missingRangeEventIds,
  toCalendarType,
  toDayFlowEvent,
  toEventUpdates,
  toSearchEvent,
} from './model'

const COLLAPSED_STORAGE_KEY = 'inkstone:calendar:sidebar-collapsed'
const DAY_MS = 24 * 60 * 60 * 1000

interface CalendarSurfaceProps {
  meta: CalendarMetaDto
  initialEvents: CalendarEventDto[]
  initialOccurrences: CalendarEventDto[]
  initialTruncated?: boolean
  initialRecurrenceTruncated?: boolean
  initialRange: { from: number; to: number }
  onRefreshMeta: () => Promise<CalendarMetaDto>
  onSavePreferences: (next: CalendarPreferences) => Promise<void>
}

interface SurfaceActions {
  onCalendarCreate?: (calendar: CalendarType) => void | Promise<void>
  onCalendarUpdate?: (calendar: CalendarType) => void
  onCalendarDelete?: (calendarId: string) => void | Promise<void>
  onCalendarReorder?: (fromIndex: number, toIndex: number) => void
}

function viewType(name: CalendarPreferences['defaultView']): ViewType {
  return ViewType[name.toUpperCase() as keyof typeof ViewType]
}

function toViews(preferences: CalendarPreferences): CalendarView[] {
  const secondary = preferences.secondaryTimeZone ?? undefined
  const weekStart = preferences.weekStart
  return [
    createDayView({
      hourHeight: preferences.dayHourHeight,
      timeFormat: preferences.timeFormat,
      showHalfHourLines: preferences.showHalfHourLines,
      secondaryTimeZone: secondary,
      showAllDay: true,
      scrollToCurrentTime: true,
      showEventDots: preferences.showEventDots,
    }),
    createWeekView({
      hourHeight: preferences.dayHourHeight,
      timeFormat: preferences.timeFormat,
      showHalfHourLines: preferences.showHalfHourLines,
      showAllDay: true,
      startOfWeek: weekStart,
      scrollToCurrentTime: true,
      secondaryTimeZone: secondary,
      showEventDots: preferences.showEventDots,
      gridDateDoubleClick: 'create-event',
    }),
    createMonthView({
      startOfWeek: weekStart,
      showWeekNumbers: preferences.showWeekNumbers,
      showMonthIndicator: true,
      snapToMonth: preferences.snapToMonth,
      scroll: { disabled: !preferences.monthScroll },
      eventHeight: MONTH_EVENT_HEIGHT,
      showEventDots: preferences.showEventDots,
      gridDateDoubleClick: 'create-event',
    }),
    createYearView({
      startOfWeek: weekStart,
      mode: preferences.yearViewMode,
      showTimedEventsInYearView: preferences.yearShowTimedEvents,
      gridHeatmapLevels: preferences.yearHeatmapLevels,
      showEventDots: preferences.showEventDots,
      gridDateDoubleClick: 'create-event',
    }),
    createAgendaView({
      daysToShow: preferences.agendaDays,
      showEmptyDays: preferences.agendaShowEmptyDays,
      timeFormat: preferences.timeFormat,
    }),
  ]
}

function defaultCalendarId(meta: CalendarMetaDto): string | undefined {
  return meta.calendars.find(calendar => calendar.isDefault)?.id ?? meta.calendars[0]?.id
}

function calendarNeedsUpdate(current: CalendarType, desired: CalendarType): boolean {
  return JSON.stringify([
    current.name,
    current.colors,
    current.darkColors,
    current.icon,
    current.isDefault,
    current.isVisible,
    current.readOnly,
    current.source,
  ]) !== JSON.stringify([
    desired.name,
    desired.colors,
    desired.darkColors,
    desired.icon,
    desired.isDefault,
    desired.isVisible,
    desired.readOnly,
    desired.source,
  ])
}

function applyCalendarOrder(app: ICalendarApp, ids: string[]): void {
  const current = app.getCalendars().map(calendar => calendar.id)
  if (current.join('\u0000') === ids.join('\u0000')) return
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]
    if (!id) continue
    const from = current.indexOf(id)
    if (from < 0 || from === index) continue
    const [moved] = current.splice(from, 1)
    if (!moved) continue
    current.splice(index, 0, moved)
    app.reorderCalendars(from, index)
  }
}

function toastFailure(title: string, error: unknown): void {
  useUi.getState().toast({
    title,
    description: error instanceof Error && error.message ? error.message : undefined,
    tone: 'danger',
  })
}

function isCovered(intervals: Array<[number, number]>, from: number, to: number): boolean {
  return intervals.some(([start, end]) => start <= from && end >= to)
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    // A browser that refuses storage gets the expanded sidebar; the choice is a convenience.
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
  } catch {
    // Same as above: the sidebar still collapses for this visit.
  }
}

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)')
    const update = (): void => setWide(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}

const KEYBOARD_CLEANUP = Symbol.for('inkstone.calendar.keyboard.cleanup')

function singleInstanceKeyboardPlugin(
  config: Parameters<typeof createKeyboardShortcutsPlugin>[0],
): CalendarPlugin {
  const plugin = createKeyboardShortcutsPlugin(config)
  return {
    ...plugin,
    install(app) {
      const holder = globalThis as unknown as Record<PropertyKey, unknown>
      const previous = holder[KEYBOARD_CLEANUP]
      if (typeof previous === 'function') previous()
      const cleanup = plugin.install(app)
      holder[KEYBOARD_CLEANUP] = typeof cleanup === 'function' ? cleanup : null
      return () => {
        if (holder[KEYBOARD_CLEANUP] === cleanup) holder[KEYBOARD_CLEANUP] = null
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
}

function buildConfig(input: {
  meta: CalendarMetaDto
  initialEvents: CalendarEventDto[]
  preferences: CalendarPreferences
  locale: AppLocale
  mode: 'light' | 'dark'
  history: CalendarEditHistory
  actions: { current: SurfaceActions }
  initialView?: CalendarPreferences['defaultView'] | null
  initialDate?: Date | null
}): CalendarAppConfig {
  const { meta, initialEvents, preferences, locale, mode, history, actions, initialView, initialDate } = input
  const timeZone = preferences.timeZone
  const callbacks: CalendarCallbacks = {
    onCalendarCreate: calendar => actions.current.onCalendarCreate?.(calendar),
    onCalendarUpdate: calendar => actions.current.onCalendarUpdate?.(calendar),
    onCalendarDelete: calendarId => actions.current.onCalendarDelete?.(calendarId),
    onCalendarReorder: (from, to) => actions.current.onCalendarReorder?.(from, to),
    onEventDoubleClick: event => {
      if (!isRecurrenceOccurrence(event)) return undefined
      useUi.getState().toast({ title: t('calendar.error.recurring'), tone: 'warning' })
      return false
    },
  }
  return {
    views: toViews(preferences),
    plugins: [
      createDragPlugin({
        enableDrag: true,
        enableResize: true,
        enableCreate: true,
        enableAllDayCreate: true,
        supportedViews: [ViewType.DAY, ViewType.WEEK, ViewType.MONTH, ViewType.YEAR],
      }),
      singleInstanceKeyboardPlugin({
        enabled: true,
        callbacks: {
          undo: app => {
            if (!history.undo(app)) useUi.getState().toast({ title: t('calendar.history.empty') })
          },
          redo: app => {
            if (!history.redo(app)) useUi.getState().toast({ title: t('calendar.history.empty') })
          },
          delete: async (app, event) => {
            if (!event) return
            if (isRecurrenceOccurrence(event)) {
              useUi.getState().toast({ title: t('calendar.error.recurring'), tone: 'warning' })
              return
            }
            const calendarIds = eventCalendarIds(event)
            if (calendarIds.length > 0 && !calendarIds.some(id => app.canMutateFromUI(id))) {
              useUi.getState().toast({ title: t('calendar.event.delete_read_only'), tone: 'warning' })
              return
            }
            try {
              await app.deleteEvent(event.id)
            } catch (error) {
              toastFailure(t('calendar.event.delete_failed'), error)
            }
          },
        },
      }),
      createLocalizationPlugin({ locales: [zh] }),
      // The bridge is installed for the header's reference quick-create behavior; the default
      // Preact sidebar is overridden below, so its client-side subscription UI never mounts.
      createSidebarPlugin({ width: '0px', miniWidth: '0px', initialCollapsed: true, componentsOrder: [] }),
    ],
    events: initialEvents.map(event => toDayFlowEvent(event, timeZone)),
    defaultView: viewType(initialView ?? preferences.defaultView),
    initialDate: initialDate ?? new Date(),
    switcherMode: 'buttons',
    calendars: meta.calendars.map(toCalendarType),
    defaultCalendar: defaultCalendarId(meta),
    theme: { mode },
    locale,
    timeZone,
    timeFormat: preferences.timeFormat,
    calendarSystem: preferences.calendarSystem,
    useEventDetailDialog: preferences.eventDetailDialog,
    enableTasks: preferences.enableTasks,
    eventDetailTrigger: preferences.eventDetailTrigger,
    useCalendarHeader: true,
    callbacks,
  }
}

export function CalendarSurface({ meta, initialEvents, initialOccurrences, initialTruncated = false, initialRecurrenceTruncated = false, initialRange, onRefreshMeta, onSavePreferences }: CalendarSurfaceProps) {
  useLocaleRepaint()
  const appLocale = useLocale()
  const dark = useThemeDark()
  const wide = useWide()
  const [history] = useState(() => new CalendarEditHistory())
  const actions = useRef<SurfaceActions>({})
  const [route] = useState(() => readCalendarRouteState(window.location.search))
  const [config] = useState(() => buildConfig({
    meta,
    initialEvents,
    preferences: meta.preferences,
    locale: appLocale,
    mode: dark ? 'dark' : 'light',
    history,
    actions,
    initialView: route.view,
    initialDate: route.date,
  }))
  const { app } = useCalendarApp(config)

  const userId = useSession(state => state.user?.id)
  const connectionKey = meta.connections
    .map(connection => `${connection.id}:${connection.kind}:${connection.writable ? 1 : 0}:${connection.calendarHomeUrl ?? ''}`)
    .join('|')

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filteredSearchOpen, setFilteredSearchOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [rangeTruncated, setRangeTruncated] = useState(initialTruncated || initialRecurrenceTruncated)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictTarget | null>(null)
  const [extrasEventId, setExtrasEventId] = useState<string | null>(null)
  const shownRef = useRef<string | null>(null)
  const dismissedRef = useRef<string | null>(null)

  const conflictView = useMemo<ConflictView>(() => ({
    locale: appLocale,
    timeZone: meta.preferences.timeZone,
    calendarNames: new Map(meta.calendars.map(calendar => [calendar.id, calendar.name])),
  }), [appLocale, meta.preferences.timeZone, meta.calendars])
  const conflictRef = useRef<ConflictTarget | null>(null)
  conflictRef.current = conflict

  const decideConflict = useCallback((resolution: ConflictResolution): void => {
    const id = conflictRef.current?.id
    setConflict(null)
    if (id) void persistenceRef.current?.resolveConflict(id, resolution)
  }, [])

  /**
   * DayFlow's event panel and mobile drawer still hold the revision the refused write was sent
   * against, and their portals stack above this app's dialogs — a stale editor behind a merge prompt
   * is both a competing writer and an unreachable one.
   */
  const closeEventSurfaces = useCallback((): void => {
    app.onEventDetailToggle(null)
    app.onMobileEventDetailToggle(null)
  }, [app])

  /** A parked 409 needs the server's copy before there is anything to compare against. */
  const openConflict = useCallback(async (request: ConflictRequest): Promise<void> => {
    let theirs: CalendarEventDto | null
    try {
      theirs = await api.getEvent(request.id)
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
      await reloadRef.current(request.id)
      return
    }
    if (!theirs) {
      await reloadRef.current(request.id)
      return
    }
    if (request.intent === 'delete' || !request.mine) {
      closeEventSurfaces()
      const drop = await confirm({
        title: t('calendar.conflict.delete_heading', { title: theirs.title || t('calendar.event.untitled') }),
        description: t('calendar.conflict.delete_hint'),
        confirmLabel: t('calendar.conflict.delete_anyway'),
        cancelLabel: t('calendar.conflict.keep_server'),
      })
      void persistenceRef.current?.resolveConflict(request.id, drop
        ? { action: 'delete', rev: theirs.rev }
        : { action: 'server' })
      return
    }
    closeEventSurfaces()
    setConflict({ id: request.id, mine: request.mine, theirs })
  }, [closeEventSurfaces])

  const metaRef = useRef(meta)
  metaRef.current = meta
  const preferencesRef = useRef(meta.preferences)
  preferencesRef.current = meta.preferences
  const refreshRef = useRef(onRefreshMeta)
  refreshRef.current = onRefreshMeta

  const [revs] = useState(() => new Map(initialEvents.map(event => [event.id, event.rev])))
  const persistenceRef = useRef<EventPersistence | null>(null)
  const covered = useRef<Array<[number, number]>>([[initialRange.from, initialRange.to]])
  const inFlight = useRef<Array<[number, number]>>([])
  const lastRange = useRef(initialRange)
  const failedRange = useRef<{ from: number; to: number } | null>(null)

  const occurrenceRef = useRef<Map<string, Event> | null>(null)
  if (!occurrenceRef.current) {
    occurrenceRef.current = new Map(initialOccurrences.map(dto => [dto.id, toDayFlowEvent(dto, meta.preferences.timeZone)]))
  }
  const occurrenceRefreshTimer = useRef<number | undefined>(undefined)

  const syncOccurrences = useCallback(() => {
    const occurrences = occurrenceRef.current
    if (!occurrences) return
    const current = new Set(app.getEvents().filter(event => isRecurrenceOccurrence(event)).map(event => event.id))
    const desired = app.getCurrentView().type === 'month' ? [] : [...occurrences.values()]
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

  const updateOccurrences = useCallback((dtos: CalendarEventDto[], range: { from: number; to: number }): void => {
    const occurrences = occurrenceRef.current
    if (!occurrences) return
    const timeZone = preferencesRef.current.timeZone
    const incoming = new Map(dtos.map(dto => [dto.id, toDayFlowEvent(dto, timeZone)]))
    for (const [id, event] of occurrences) {
      const start = temporalToEpochMs(event.start, timeZone)
      if (start >= range.from && start <= range.to && !incoming.has(id)) occurrences.delete(id)
    }
    for (const [id, event] of incoming) occurrences.set(id, event)
    syncOccurrences()
  }, [syncOccurrences])

  useEffect(() => () => window.clearTimeout(occurrenceRefreshTimer.current), [])

  const suppressUpdate = useRef(new Set<string>())
  const suppressCreate = useRef(new Set<string>())
  const suppressDelete = useRef(new Set<string>())
  const suppressReorder = useRef(false)

  const searchAbort = useRef<AbortController | null>(null)
  useEffect(() => () => searchAbort.current?.abort(), [])

  const applySnapshot = useCallback((dtos: CalendarEventDto[], range: { from: number; to: number }, truncated: boolean): Set<string> => {
    const timeZone = preferencesRef.current.timeZone
    const revById = new Map(dtos.map(dto => [dto.id, dto.rev]))
    const mapped = dtos.map(dto => toDayFlowEvent(dto, timeZone))
    const existing = new Map(
      app.getEvents()
        .filter(event => !isRecurrenceOccurrence(event))
        .map(event => [event.id, event]),
    )
    const add: Event[] = []
    const update: Array<{ id: string; updates: Partial<Event> }> = []
    for (const event of mapped) {
      revs.set(event.id, revById.get(event.id) ?? 0)
      if (existing.has(event.id)) update.push({ id: event.id, updates: toEventUpdates(event) })
      else add.push(event)
    }
    const fetched = new Set(mapped.map(event => event.id))
    if (add.length > 0 || update.length > 0) {
      persistenceRef.current?.skip(fetched)
      app.applyEventsChanges({ add, update }, false, 'remote')
    }
    // A complete range is a mirror: anything local that overlaps it and did not come back was deleted
    // elsewhere. Recurring masters and generated occurrences are views, never rows of their own; a
    // truncated page cannot prove absence, and a queued write must be allowed to reach the server.
    const stale = truncated || dtos.length >= MAX_EVENTS_PER_QUERY
      ? []
      : missingRangeEventIds({
          events: [...existing.values()],
          fetched,
          from: range.from,
          to: range.to,
          timeZone,
          hasPending: id => persistenceRef.current?.hasPending(id) === true,
        })
    if (stale.length > 0) {
      persistenceRef.current?.skip(stale)
      app.applyEventsChanges({ delete: stale }, false, 'remote')
      for (const id of stale) revs.delete(id)
    }
    return fetched
  }, [app, revs])

  const fetchRange = useCallback(async (from: number, to: number): Promise<Set<string>> => {
    const page = await api.getEvents({ from, to })
    const fetched = applySnapshot(page.events, { from, to }, page.truncated)
    updateOccurrences(page.occurrences, { from, to })
    setRangeTruncated(page.truncated || page.recurrenceTruncated)
    lastRange.current = { from, to }
    return fetched
  }, [applySnapshot, updateOccurrences])

  const reloadLastRange = useCallback(async (eventId?: string, status?: number): Promise<void> => {
    const range = lastRange.current
    try {
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
  }, [app, fetchRange, revs])

  const reloadRef = useRef(reloadLastRange)
  reloadRef.current = reloadLastRange

  const runRangeFetch = useCallback(async (from: number, to: number): Promise<void> => {
    try {
      await fetchRange(from, to)
      covered.current.push([from, to])
      failedRange.current = null
      setRangeError(null)
    } catch (error) {
      failedRange.current = { from, to }
      setRangeError(error instanceof Error && error.message ? error.message : t('calendar.error.range'))
    }
  }, [fetchRange])

  const paddedRange = useCallback((start: number, end: number): { from: number; to: number } => {
    let from = start - RANGE_PADDING_DAYS * DAY_MS
    let to = end + RANGE_PADDING_DAYS * DAY_MS
    if (to - from > CALENDAR_RANGE_MAX_MS) {
      const center = (start + end) / 2
      from = center - CALENDAR_RANGE_MAX_MS / 2
      to = center + CALENDAR_RANGE_MAX_MS / 2
    }
    return { from, to }
  }, [])

  const loadRange = useCallback((start: number, end: number): void => {
    const { from, to } = paddedRange(start, end)
    if (isCovered(covered.current, from, to) || isCovered(inFlight.current, from, to)) return
    inFlight.current.push([from, to])
    void runRangeFetch(from, to).finally(() => {
      inFlight.current = inFlight.current.filter(([rangeFrom, rangeTo]) => rangeFrom !== from || rangeTo !== to)
    })
  }, [paddedRange, runRangeFetch])

  const requestMiniRange = useCallback((from: number, to: number): void => loadRange(from, to), [loadRange])

  const retryRange = (): void => {
    const range = failedRange.current
    if (!range) return
    inFlight.current.push([range.from, range.to])
    void runRangeFetch(range.from, range.to).finally(() => {
      inFlight.current = inFlight.current.filter(([from, to]) => from !== range.from || to !== range.to)
    })
  }

  const syncRegistry = useCallback(async (calendars: CalendarDto[]): Promise<void> => {
    const desired = calendars.map(toCalendarType)
    const desiredById = new Map(desired.map(calendar => [calendar.id, calendar]))
    for (const current of app.getCalendars()) {
      if (desiredById.has(current.id)) continue
      suppressDelete.current.add(current.id)
      await app.deleteCalendar(current.id)
    }
    for (const calendar of desired) {
      const current = app.getCalendars().find(item => item.id === calendar.id)
      if (!current) {
        suppressCreate.current.add(calendar.id)
        await app.createCalendar(calendar)
      } else if (calendarNeedsUpdate(current, calendar)) {
        suppressUpdate.current.add(calendar.id)
        app.updateCalendar(calendar.id, calendar)
      }
    }
    suppressReorder.current = true
    try {
      applyCalendarOrder(app, desired.map(calendar => calendar.id))
    } finally {
      suppressReorder.current = false
    }
    const defaultId = desired.find(calendar => calendar.isDefault)?.id ?? desired[0]?.id
    if (defaultId) app.getCalendarRegistry().setDefaultCalendar(defaultId)
  }, [app])

  const refreshCalendars = useCallback(async (reloadEvents: boolean): Promise<void> => {
    const next = await onRefreshMeta()
    await syncRegistry(next.calendars)
    if (reloadEvents) await reloadLastRange()
  }, [onRefreshMeta, reloadLastRange, syncRegistry])

  const persistCalendarChange = useCallback(async (calendar: CalendarType): Promise<void> => {
    if (suppressUpdate.current.delete(calendar.id)) return
    const dto = metaRef.current.calendars.find(item => item.id === calendar.id)
    if (!dto) return
    const patch: Omit<CalendarPatchInput, 'rev'> = {}
    if (calendar.name !== dto.name) patch.name = calendar.name
    if (calendar.colors.lineColor !== dto.color) {
      patch.color = calendar.colors.lineColor
      patch.darkColor = calendar.darkColors?.lineColor
    }
    if ((calendar.readOnly === true) !== dto.readOnly) patch.readOnly = calendar.readOnly === true
    if ((calendar.isVisible !== false) !== dto.isVisible) patch.isVisible = calendar.isVisible !== false
    if ((calendar.isDefault === true) !== dto.isDefault) patch.isDefault = calendar.isDefault === true
    if (Object.keys(patch).length === 0) return
    try {
      await api.updateCalendar(calendar.id, patch, dto.rev)
    } catch (error) {
      toastFailure(t('calendar.sidebar.visibility_failed'), error)
      try {
        await refreshRef.current()
      } catch (refreshError) {
        toastFailure(t('calendar.error.refresh'), refreshError)
      }
      return
    }
    try {
      await refreshRef.current()
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
    }
  }, [app])

  const persistOrder = useCallback((): void => {
    if (suppressReorder.current) return
    const ids = app.getCalendars().map(calendar => calendar.id)
    void api.reorderCalendars(ids).catch(async (error) => {
      toastFailure(t('calendar.sidebar.order_failed'), error)
      try {
        await refreshRef.current()
      } catch (refreshError) {
        toastFailure(t('calendar.error.refresh'), refreshError)
      }
    })
  }, [app])

  const persistCalendarCreate = useCallback(async (calendar: CalendarType): Promise<void> => {
    if (suppressCreate.current.delete(calendar.id)) return
    try {
      await api.createCalendar({
        id: calendar.id,
        name: calendar.name,
        color: calendar.colors.lineColor,
        darkColor: calendar.darkColors?.lineColor,
        isDefault: calendar.isDefault,
        isVisible: calendar.isVisible !== false,
        readOnly: calendar.readOnly === true,
        source: calendarSourceOf(calendar.source),
      })
    } catch (error) {
      suppressDelete.current.add(calendar.id)
      await app.deleteCalendar(calendar.id)
      toastFailure(t('calendar.calendar.action_failed'), error)
      return
    }
    try {
      await refreshRef.current()
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
    }
  }, [app])

  const persistCalendarDelete = useCallback(async (calendarId: string): Promise<void> => {
    if (suppressDelete.current.delete(calendarId)) return
    const dto = metaRef.current.calendars.find(item => item.id === calendarId)
    if (!dto) return
    try {
      await api.deleteCalendar(calendarId, { kind: 'delete', rev: dto.rev })
    } catch (error) {
      toastFailure(t('calendar.calendar.action_failed'), error)
      try {
        await refreshRef.current()
      } catch (refreshError) {
        toastFailure(t('calendar.error.refresh'), refreshError)
      }
      return
    }
    try {
      await refreshRef.current()
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
    }
  }, [])

  actions.current = {
    onCalendarCreate: calendar => persistCalendarCreate(calendar),
    onCalendarUpdate: calendar => { void persistCalendarChange(calendar) },
    onCalendarDelete: calendarId => persistCalendarDelete(calendarId),
    onCalendarReorder: () => persistOrder(),
  }

  useEffect(() => {
    const persistence = new EventPersistence({
      app,
      revs,
      history,
      timeZone: () => preferencesRef.current.timeZone,
      fallbackTitle: () => t('calendar.event.untitled'),
      onServerState: (eventId, status) => reloadRef.current(eventId, status),
      onError: error => toastFailure(t('calendar.error.save_failed'), error),
      onConflict: request => { void openConflict(request) },
      onRecurringEdit: () => useUi.getState().toast({ title: t('calendar.error.recurring'), tone: 'warning' }),
      onReadOnlyEdit: () => useUi.getState().toast({ title: t('calendar.event.delete_read_only'), tone: 'warning' }),
      onCommitted: (id, recurring) => {
        if (!recurring) return
        dropOccurrencesForMaster(id)
        window.clearTimeout(occurrenceRefreshTimer.current)
        occurrenceRefreshTimer.current = window.setTimeout(() => { void reloadRef.current() }, 300)
      },
      onDeleted: (id, title) => {
        toastWithUndo(title ? t('calendar.event.deleted_named', { title }) : t('calendar.event.deleted'), () => {
          if (!history.undo(app, id)) useUi.getState().toast({ title: t('calendar.history.empty') })
        })
      },
    })
    persistenceRef.current = persistence
    const dispose = persistence.start()
    return () => {
      dispose()
      persistenceRef.current = null
    }
  }, [app, history, revs, dropOccurrencesForMaster])

  useEffect(() => {
    syncOccurrences()
    return app.subscribe(() => syncOccurrences())
  }, [app, syncOccurrences])

  // The extras section follows DayFlow's selection rather than a click callback, because providing one
  // changes what a click does to the event surfaces. A click anywhere outside the calendar — including
  // on this section's own controls — clears that selection, so an open section stays open until the
  // reader closes it or picks another event.
  useEffect(() => app.subscribe(() => {
    const selected = app.state.selectedEventId ?? null
    if (!selected) {
      dismissedRef.current = null
      return
    }
    if (selected.includes('::repeat-') || selected === shownRef.current) return
    if (selected === dismissedRef.current) return
    shownRef.current = selected
    setExtrasEventId(selected)
  }), [app])

  useEffect(() => app.subscribeVisibleRangeChange(payload => {
    loadRange(payload.start.getTime(), payload.end.getTime())
  }), [app, loadRange])

  useEffect(() => {
    void syncRegistry(meta.calendars).catch(error => toastFailure(t('calendar.error.refresh'), error))
  }, [meta.calendars, syncRegistry])

  useEffect(() => {
    if (!userId || metaRef.current.connections.length === 0) return
    const attachment = attachCalendarProviders(app, {
      userId,
      connections: metaRef.current.connections,
      getInitialSnapshot: () => ({
        events: app.getEvents(),
        calendars: app.getCalendars(),
      }),
      onStatus: (connection, status, error) => {
        if (status === 'connected') {
          setSyncError(null)
          return
        }
        setSyncError(t('calendar.sync.failed', { name: connection.label || connection.kind }))
        console.warn('[inkstone] Calendar sync failed:', {
          connection: connection.id,
          error: error instanceof Error ? error.message : error,
        })
        void Promise.resolve(refreshRef.current()).catch((refreshError: unknown) => {
          toastFailure(t('calendar.error.refresh'), refreshError)
        })
      },
      onRefreshMeta: async () => { await refreshRef.current() },
    })
    return () => attachment.stop()
  }, [app, connectionKey, userId])

  const preferencesSignature = useMemo(() => JSON.stringify(meta.preferences), [meta.preferences])
  const appliedPreferences = useRef<string | null>(null)

  useEffect(() => {
    app.updateConfig({ theme: { mode: dark ? 'dark' : 'light' }, locale: appLocale })
  }, [app, appLocale, dark])

  useEffect(() => {
    // A provider refresh replaces the meta object with the same values; rebuilding every view for
    // that defeats the point of updateConfig.
    if (appliedPreferences.current === preferencesSignature) return
    appliedPreferences.current = preferencesSignature
    app.updateConfig({
      views: toViews(meta.preferences),
      timeZone: meta.preferences.timeZone,
      timeFormat: meta.preferences.timeFormat,
      calendarSystem: meta.preferences.calendarSystem,
      enableTasks: meta.preferences.enableTasks,
      useEventDetailDialog: meta.preferences.eventDetailDialog,
      eventDetailTrigger: meta.preferences.eventDetailTrigger,
    })
  }, [app, meta.preferences, preferencesSignature])

  useEffect(() => app.subscribe(() => {
    const view = app.getCurrentView().type
    if (!(CALENDAR_VIEWS as readonly string[]).includes(view)) return
    const next = calendarRouteHref(window.location.href, view as CalendarViewName, app.getCurrentDate())
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (next !== current) window.history.replaceState(window.history.state, '', next)
  }), [app])

  const search = useMemo<CalendarSearchProps>(() => ({
    debounceDelay: 300,
    emptyText: t('calendar.search.empty'),
    timeFormat: meta.preferences.timeFormat,
    onSearch: async (keyword) => {
      searchAbort.current?.abort()
      const controller = new AbortController()
      searchAbort.current = controller
      try {
        const response = await api.searchEvents(keyword, controller.signal)
        return response.results.map(result => toSearchEvent(result, preferencesRef.current.timeZone))
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return []
        toastFailure(t('calendar.search.failed'), error)
        return []
      }
    },
    onResultClick: ({ defaultAction }) => defaultAction(),
  }), [meta.preferences.timeFormat, appLocale])

  const toggleCollapsed = (): void => {
    setCollapsed((current) => {
      const next = !current
      writeCollapsed(next)
      return next
    })
  }

  const sidebar = (
    <CalendarSidebar
      app={app}
      meta={meta}
      preferences={meta.preferences}
      variant={wide ? 'inline' : 'drawer'}
      collapsed={collapsed}
      onToggleCollapsed={toggleCollapsed}
      onClose={() => setDrawerOpen(false)}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenFilteredSearch={() => setFilteredSearchOpen(true)}
      onRefresh={refreshCalendars}
      onSelectDate={date => app.setCurrentDate(date)}
      onRequestRange={requestMiniRange}
      extras={extrasEventId ? (
        <CalendarEventExtras
          eventId={extrasEventId}
          accountTimeZone={meta.preferences.timeZone}
          locale={appLocale}
          onClose={() => {
            dismissedRef.current = extrasEventId
            shownRef.current = null
            setExtrasEventId(null)
          }}
          onRevision={(id, rev) => { revs.set(id, rev) }}
          onChanged={(id) => { void reloadRef.current(id) }}
        />
      ) : undefined}
    />
  )

  return (
    <div className="relative flex h-full min-h-0 bg-[var(--bg-base)]">
      {wide
        ? sidebar
        : (
            <Drawer
              open={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              side="left"
              width={300}
              bodyClassName="overflow-hidden p-0"
              ariaLabel={t('calendar.sidebar.title')}
            >
              {sidebar}
            </Drawer>
          )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {rangeError && (
          <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
            <AlertTriangle size={13} className="shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{rangeError}</span>
            <Button size="sm" onClick={retryRange}>{t('common.retry')}</Button>
          </div>
        )}

        {rangeTruncated && (
          <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
            <AlertTriangle size={13} className="shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('calendar.range.truncated')}</span>
          </div>
        )}

        {syncError && (
          <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
            <AlertTriangle size={13} className="shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{syncError}</span>
            <Button size="sm" onClick={() => setConnectionsOpen(true)}>{t('calendar.sync.open_connections')}</Button>
          </div>
        )}

        <div className="inkstone-calendar min-h-0 flex-1">
          <DayFlowCalendar calendar={app} search={search} sidebar={() => null} />
        </div>
      </div>

      {!wide && !drawerOpen && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-[var(--z-pop)]">
          <IconButton
            label={t('calendar.sidebar.open')}
            onClick={() => setDrawerOpen(true)}
            className="pointer-events-auto size-10 rounded-full border border-[var(--border-default)] bg-[var(--bg-raised)] shadow-[var(--shadow-pop)]"
          >
            <MenuIcon size={18} />
          </IconButton>
        </div>
      )}

      {settingsOpen && (
        <CalendarSettings
          open
          preferences={meta.preferences}
          onClose={() => setSettingsOpen(false)}
          onSave={onSavePreferences}
          onOpenConnections={() => {
            setSettingsOpen(false)
            setConnectionsOpen(true)
          }}
        />
      )}

      <CalendarFilteredSearch
        open={filteredSearchOpen}
        calendars={meta.calendars}
        onClose={() => setFilteredSearchOpen(false)}
        onPick={(result) => {
          const date = calendarSearchResultDate(result)
          if (date) app.setCurrentDate(date)
          app.highlightEvent(result.event.id)
          app.selectEvent(result.event.id)
        }}
      />

      <CalendarConnections
        open={connectionsOpen}
        connections={meta.connections}
        onClose={() => setConnectionsOpen(false)}
        onChanged={async () => { await refreshRef.current() }}
      />

      {conflict && (
        <CalendarConflictDialog
          key={conflict.id}
          request={conflict}
          view={conflictView}
          onDecide={decideConflict}
        />
      )}
    </div>
  )
}
