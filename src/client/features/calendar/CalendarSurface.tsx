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
import { AlertTriangle, Menu as MenuIcon, Settings } from 'lucide-react'
import type {
  CalendarDto,
  CalendarEventDto,
  CalendarMetaDto,
  CalendarPreferences,
} from '@shared/calendar/model'
import { CALENDAR_RANGE_MAX_MS } from '@shared/calendar/model'
import type { AppLocale } from '@shared/types'
import { t, useLocale, useLocaleRepaint } from '../../lib/i18n'
import { useThemeDark } from '../../lib/hooks'
import { ApiError } from '../../lib/api'
import { useUi, toastWithUndo } from '../../store/ui'
import { useSession } from '../../store/session'
import { Button, IconButton } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { CalendarSidebar } from './CalendarSidebar'
import { CalendarSettings } from './CalendarSettings'
import { CalendarConnections } from './CalendarConnections'
import { CalendarEditHistory } from './history'
import { EventPersistence } from './persistence'
import { attachCalendarProviders } from './providers'
import * as api from './api'
import type { CalendarPatchInput } from './api'
import {
  calendarSourceOf,
  MONTH_EVENT_HEIGHT,
  RANGE_PADDING_DAYS,
  eventCalendarIds,
  toCalendarType,
  toDayFlowEvent,
  toEventUpdates,
  toSearchEvent,
} from './model'

const COLLAPSED_STORAGE_KEY = 'inkstone:calendar:sidebar-collapsed'
const DAY_MS = 24 * 60 * 60 * 1000
const AGENDA_DAYS = 30

interface CalendarSurfaceProps {
  meta: CalendarMetaDto
  initialEvents: CalendarEventDto[]
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
      showWeekends: preferences.showWeekends,
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
      mode: 'year-canvas',
      showTimedEventsInYearView: true,
      showEventDots: preferences.showEventDots,
      gridDateDoubleClick: 'create-event',
    }),
    createAgendaView({
      daysToShow: AGENDA_DAYS,
      showEmptyDays: true,
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
}): CalendarAppConfig {
  const { meta, initialEvents, preferences, locale, mode, history, actions } = input
  const timeZone = preferences.timeZone
  const callbacks: CalendarCallbacks = {
    onCalendarCreate: calendar => actions.current.onCalendarCreate?.(calendar),
    onCalendarUpdate: calendar => actions.current.onCalendarUpdate?.(calendar),
    onCalendarDelete: calendarId => actions.current.onCalendarDelete?.(calendarId),
    onCalendarReorder: (from, to) => actions.current.onCalendarReorder?.(from, to),
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
    defaultView: viewType(preferences.defaultView),
    initialDate: new Date(),
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

export function CalendarSurface({ meta, initialEvents, initialRange, onRefreshMeta, onSavePreferences }: CalendarSurfaceProps) {
  useLocaleRepaint()
  const appLocale = useLocale()
  const dark = useThemeDark()
  const wide = useWide()
  const [history] = useState(() => new CalendarEditHistory())
  const actions = useRef<SurfaceActions>({})
  const [config] = useState(() => buildConfig({
    meta,
    initialEvents,
    preferences: meta.preferences,
    locale: appLocale,
    mode: dark ? 'dark' : 'light',
    history,
    actions,
  }))
  const { app } = useCalendarApp(config)

  const userId = useSession(state => state.user?.id)
  const connectionKey = meta.connections
    .map(connection => `${connection.id}:${connection.kind}:${connection.writable ? 1 : 0}:${connection.calendarHomeUrl ?? ''}`)
    .join('|')

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [rangeError, setRangeError] = useState<string | null>(null)

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

  const suppressUpdate = useRef(new Set<string>())
  const suppressCreate = useRef(new Set<string>())
  const suppressDelete = useRef(new Set<string>())
  const suppressReorder = useRef(false)

  const searchAbort = useRef<AbortController | null>(null)
  useEffect(() => () => searchAbort.current?.abort(), [])

  const applySnapshot = useCallback((dtos: CalendarEventDto[]): Set<string> => {
    const timeZone = preferencesRef.current.timeZone
    const revById = new Map(dtos.map(dto => [dto.id, dto.rev]))
    const mapped = dtos.map(dto => toDayFlowEvent(dto, timeZone))
    const existing = new Map(
      app.getEvents()
        .filter(event => !event._recurrenceMasterId)
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
    if (add.length === 0 && update.length === 0) return fetched
    persistenceRef.current?.skip(fetched)
    app.applyEventsChanges({ add, update }, false, 'remote')
    return fetched
  }, [app, revs])

  const fetchRange = useCallback(async (from: number, to: number): Promise<Set<string>> => {
    const dtos = await api.getEvents({ from, to })
    const fetched = applySnapshot(dtos)
    lastRange.current = { from, to }
    return fetched
  }, [applySnapshot])

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
      onConflict: error => {
        const conflict = error instanceof ApiError && error.status === 409
        useUi.getState().toast({
          title: t(conflict ? 'calendar.error.conflict' : 'calendar.error.save_failed'),
          description: error instanceof Error && error.message ? error.message : undefined,
          tone: 'danger',
        })
      },
      onRecurringEdit: () => useUi.getState().toast({ title: t('calendar.error.recurring'), tone: 'warning' }),
      onDeleted: (_id, title) => {
        toastWithUndo(title ? t('calendar.event.deleted_named', { title }) : t('calendar.event.deleted'), () => {
          if (!history.undo(app)) useUi.getState().toast({ title: t('calendar.history.empty') })
        })
      },
    })
    persistenceRef.current = persistence
    const dispose = persistence.start()
    return () => {
      dispose()
      persistenceRef.current = null
    }
  }, [app, history, revs])

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
      onRefreshMeta: async () => { await refreshRef.current() },
    })
    return () => attachment.stop()
  }, [app, connectionKey, userId])

  useEffect(() => {
    app.updateConfig({
      views: toViews(meta.preferences),
      theme: { mode: dark ? 'dark' : 'light' },
      locale: appLocale,
      timeZone: meta.preferences.timeZone,
      timeFormat: meta.preferences.timeFormat,
      calendarSystem: meta.preferences.calendarSystem,
      enableTasks: meta.preferences.enableTasks,
      useEventDetailDialog: meta.preferences.eventDetailDialog,
      eventDetailTrigger: meta.preferences.eventDetailTrigger,
      switcherMode: 'buttons',
      useCalendarHeader: true,
    })
  }, [app, appLocale, dark, meta.preferences])

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
      onRefresh={refreshCalendars}
      onSelectDate={date => app.setCurrentDate(date)}
    />
  )

  return (
    <div className="flex h-full min-h-0 bg-[var(--bg-base)]">
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
        {!wide && (
          <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
            <IconButton label={t('calendar.sidebar.open')} size="sm" onClick={() => setDrawerOpen(true)}>
              <MenuIcon size={16} />
            </IconButton>
            <h1 className="min-w-0 flex-1 truncate px-1 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('calendar.app.title')}
            </h1>
            <IconButton label={t('calendar.sidebar.settings')} size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings size={15} />
            </IconButton>
          </header>
        )}

        {rangeError && (
          <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
            <AlertTriangle size={13} className="shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{rangeError}</span>
            <Button size="sm" onClick={retryRange}>{t('common.retry')}</Button>
          </div>
        )}

        <div className="inkstone-calendar min-h-0 flex-1">
          <DayFlowCalendar calendar={app} search={search} sidebar={() => null} />
        </div>
      </div>

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

      <CalendarConnections
        open={connectionsOpen}
        connections={meta.connections}
        onClose={() => setConnectionsOpen(false)}
        onChanged={async () => { await refreshRef.current() }}
      />
    </div>
  )
}
