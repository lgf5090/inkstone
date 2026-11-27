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
} from '@dayflow/react'
import { createDragPlugin } from '@dayflow/plugin-drag'
import { createKeyboardShortcutsPlugin } from '@dayflow/plugin-keyboard-shortcuts'
import { createLocalizationPlugin, zh } from '@dayflow/plugin-localization'
import { createSidebarPlugin } from '@dayflow/plugin-sidebar'
import { AlertTriangle, Menu as MenuIcon } from 'lucide-react'
import type {
  CalendarEventDto,
  CalendarMetaDto,
  CalendarPreferences,
  CalendarRangeRevisionDto,
  CalendarTemplateDto,
} from '@shared/calendar/model'
import type { AppLocale } from '@shared/types'
import type { AssistantPageContext } from '@shared/assistant'
import type { MessageKey } from '@shared/locales/en-US'
import { holidayNoticeOf } from '@shared/calendar/holidays'
import { localDate } from '@shared/assistant-time'
import { t, useLocale, useLocaleRepaint } from '../../lib/i18n'
import { useBreakpoint, useThemeDark } from '../../lib/hooks'
import { useUi, toastWithUndo } from '../../store/ui'
import { useSession } from '../../store/session'
import { Button, IconButton } from '../../components/primitives'
import { AssistantDock } from '../chat/AssistantDock'
import { Drawer, confirm } from '../../components/overlay'
import { CalendarSidebar } from './CalendarSidebar'
import { CalendarSettings } from './CalendarSettings'
import { CalendarConflictDialog, type ConflictTarget } from './CalendarConflictDialog'
import { CalendarRecurrenceDialog } from './CalendarRecurrenceDialog'
import { CalendarFreeBusyDialog } from './CalendarFreeBusyDialog'
import { CalendarResourcesDialog } from './CalendarResourcesDialog'
import { CalendarSchedulingDialog } from './CalendarSchedulingDialog'
import { CalendarShortcutsDialog } from './CalendarShortcutsDialog'
import { CalendarEventExtras } from './CalendarEventExtras'
import { CalendarEventDialog, type NewCalendarEvent } from './CalendarEventDialog'
import { CalendarContactsDialog } from './CalendarContactsDialog'
import { CalendarTemplatesDialog } from './CalendarTemplatesDialog'
import { CalendarTasksPanel } from './CalendarTasksPanel'
import { CalendarAlmanacDialog } from './CalendarAlmanacDialog'
import { CountdownDialog, CountdownStrip, CountdownsCard, useCountdowns } from './CalendarCountdowns'
import { CalendarHeatmapCard } from './CalendarHeatmap'
import { attachAlmanacChrome } from './almanac-chrome'
import { cellLabel } from './almanac'
import type { CalendarCountdownDto } from '@shared/calendar/countdown'
import { navigateToPath } from '../../lib/app-history'
import { holidayPresets } from './holidays'
import { CalendarQuickAdd } from './CalendarQuickAdd'
import { attachCalendarChrome } from './calendar-chrome'
import { CalendarPrintSheet } from './CalendarPrintSheet'
import { CalendarBatchDialog } from './CalendarBatchDialog'
import { batchColorUpdates, batchMoveUpdates } from './batch'
import { nextEventSelection, type EventSelectionModifiers } from './event-selection'
import { buildPrintSheet, printCalendarSheet, printPeriod } from './print'
import { observeViewSwitcher } from './view-switcher-a11y'
import type { PrintSheet } from './print'
import { CalendarFilteredSearch, calendarSearchResultDate } from './CalendarFilteredSearch'
import { CalendarConnections } from './CalendarConnections'
import { CalendarEditHistory } from './history'
import type { ConflictRequest, ConflictResolution, EventPersistence, RecurrenceOccurrenceRequest } from './persistence'
import type { ConflictView } from './conflict'
import { attachCalendarProviders } from './providers'
import { readCalendarRouteState } from './view-state'
import { calendarViewType, useCalendarNavigation } from './useCalendarNavigation'
import * as api from './api'
import {
  MONTH_EVENT_HEIGHT,
  eventCalendarIds,
  FULL_DAY_HOURS,
  isRecurrenceOccurrence,
  toCalendarType,
  toDayFlowEvent,
  toSearchEvent,
} from './model'
import { toastFailure } from './calendar-notifications'
import { useCalendarPersistence } from './useCalendarPersistence'
import { useCalendarRangeSync } from './useCalendarRangeSync'
import { useCalendarRegistry } from './useCalendarRegistry'

const COLLAPSED_STORAGE_KEY = 'inkstone:calendar:sidebar-collapsed'

/** The calendar's own view names, so the assistant reads the same word the toolbar shows. */
const ASSISTANT_VIEW_KEYS: Record<string, MessageKey> = {
  day: 'calendar.view.day',
  week: 'calendar.view.week',
  month: 'calendar.view.month',
  year: 'calendar.view.year',
  agenda: 'calendar.view.agenda',
}

interface CalendarSurfaceProps {
  meta: CalendarMetaDto
  initialEvents: CalendarEventDto[]
  initialOccurrences: CalendarEventDto[]
  initialTruncated?: boolean
  initialRecurrenceTruncated?: boolean
  /** The fingerprint the app shell's first read carried; null when that answer had none. */
  initialRevision?: CalendarRangeRevisionDto | null
  initialCached?: boolean
  initialRange: { from: number; to: number }
  onRefreshMeta: () => Promise<CalendarMetaDto>
  onSavePreferences: (next: CalendarPreferences) => Promise<void>
}

interface SurfaceActions {
  onCalendarCreate?: (calendar: CalendarType) => void | Promise<void>
  onCalendarUpdate?: (calendar: CalendarType) => void
  onCalendarDelete?: (calendarId: string) => void | Promise<void>
  onCalendarReorder?: (fromIndex: number, toIndex: number) => void
  /** A double-click on an empty grid cell; the date is the cell the reader pointed at. */
  onGridDoubleClick?: (date: Date) => void
  onPrint?: () => void
}

function toViews(
  preferences: CalendarPreferences,
  onGridDoubleClick: (date: Date) => void,
): CalendarView[] {
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
      // The runtime day view reads this callback even though its declaration omits it.
      gridDateDoubleClick: onGridDoubleClick,
      ...FULL_DAY_HOURS,
    } as Parameters<typeof createDayView>[0] & { gridDateDoubleClick: (date: Date) => void }),
    createWeekView({
      hourHeight: preferences.dayHourHeight,
      timeFormat: preferences.timeFormat,
      showHalfHourLines: preferences.showHalfHourLines,
      showAllDay: true,
      startOfWeek: weekStart,
      scrollToCurrentTime: true,
      secondaryTimeZone: secondary,
      showEventDots: preferences.showEventDots,
      gridDateDoubleClick: onGridDoubleClick,
      ...FULL_DAY_HOURS,
    }),
    createMonthView({
      startOfWeek: weekStart,
      // The library's own week number is drawn inside the first cell of every row, where it collides
      // with the lunar line; the reader's switch now draws a gutter column instead, in our chrome.
      showWeekNumbers: false,
      showMonthIndicator: true,
      snapToMonth: preferences.snapToMonth,
      scroll: { disabled: !preferences.monthScroll },
      eventHeight: MONTH_EVENT_HEIGHT,
      showEventDots: preferences.showEventDots,
      gridDateDoubleClick: onGridDoubleClick,
    }),
    createYearView({
      startOfWeek: weekStart,
      mode: preferences.yearViewMode,
      showTimedEventsInYearView: preferences.yearShowTimedEvents,
      gridHeatmapLevels: preferences.yearHeatmapLevels,
      showEventDots: preferences.showEventDots,
      gridDateDoubleClick: onGridDoubleClick,
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
  }
  return {
    views: toViews(preferences, date => actions.current.onGridDoubleClick?.(date)),
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
          print: () => actions.current.onPrint?.(),
        },
      }),
      createLocalizationPlugin({ locales: [zh] }),
      // The bridge is installed for the header's reference quick-create behavior; the default
      // Preact sidebar is overridden below, so its client-side subscription UI never mounts.
      createSidebarPlugin({ width: '0px', miniWidth: '0px', initialCollapsed: true, componentsOrder: [] }),
    ],
    events: initialEvents.map(event => toDayFlowEvent(event, timeZone)),
    defaultView: calendarViewType(initialView ?? preferences.defaultView),
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

export function CalendarSurface({ meta, initialEvents, initialOccurrences, initialTruncated = false, initialRecurrenceTruncated = false, initialRevision = null, initialCached = false, initialRange, onRefreshMeta, onSavePreferences }: CalendarSurfaceProps) {
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
  useCalendarNavigation(app, meta.preferences.defaultView)

  const assistantDockOpen = useUi(state => state.assistantDockOpen)
  const isMobile = useBreakpoint() === 'mobile'
  const [assistantChrome, setAssistantChrome] = useState(() => ({
    view: String(app.getCurrentView().type).toLowerCase(),
    date: app.getCurrentDate().getTime(),
    from: initialRange.from,
    to: initialRange.to,
  }))

  const userId = useSession(state => state.user?.id)
  const connectionKey = meta.connections
    .map(connection => `${connection.id}:${connection.kind}:${connection.writable ? 1 : 0}:${connection.calendarHomeUrl ?? ''}`)
    .join('|')

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filteredSearchOpen, setFilteredSearchOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [createStart, setCreateStart] = useState<Date | null>(null)
  const [contactsOpen, setContactsOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [template, setTemplate] = useState<CalendarTemplateDto | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictTarget | null>(null)
  const [extrasEventId, setExtrasEventId] = useState<string | null>(null)
  const [extrasReadOnly, setExtrasReadOnly] = useState(false)
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set())
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const selectionAnchorRef = useRef<string | null>(null)
  const [recurrenceRequest, setRecurrenceRequest] = useState<RecurrenceOccurrenceRequest | null>(null)
  const [freeBusyOpen, setFreeBusyOpen] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  useEffect(() => history.subscribe(() => setHistoryVersion(version => version + 1)), [history])
  const historyView = useMemo(() => ({ canUndo: history.canUndo, canRedo: history.canRedo }), [history, historyVersion])
  const [resourcesOpen, setResourcesOpen] = useState(false)
  const [schedulingOpen, setSchedulingOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [almanacDate, setAlmanacDate] = useState<string | null>(null)
  const [countdownEditing, setCountdownEditing] = useState<CalendarCountdownDto | null | undefined>(undefined)
  const [printSheet, setPrintSheet] = useState<PrintSheet | null>(null)
  const shownRef = useRef<string | null>(null)
  const dismissedRef = useRef<string | null>(null)
  const selectedEvents = app.getEvents().filter(event => selectedEventIds.has(event.id) && !isRecurrenceOccurrence(event))
  const isEventSelected = useCallback((id: string) => selectedEventIds.has(id), [selectedEventIds])
  const clearEventSelection = useCallback(() => {
    setSelectedEventIds(new Set())
    selectionAnchorRef.current = null
  }, [])
  const selectCalendarEvent = useCallback((id: string, modifiers?: EventSelectionModifiers) => {
    const root = document.querySelector<HTMLElement>('.inkstone-calendar')
    const ordered = root
      ? [...root.querySelectorAll<HTMLElement>('.df-event[data-event-id]')]
        .map(element => element.dataset.eventId ?? '')
        .filter(Boolean)
      : []
    const next = nextEventSelection(selectedEventIds, ordered, id, modifiers ?? { shift: false, meta: false }, selectionAnchorRef.current)
    selectionAnchorRef.current = next.anchor
    setSelectedEventIds(next.selected)
    if (modifiers) return
    const event = app.getEvents().find(item => item.id === id)
    setExtrasReadOnly(event ? eventCalendarIds(event).some(calendarId => !app.canMutateFromUI(calendarId)) : false)
    dismissedRef.current = null
    shownRef.current = id
    setExtrasEventId(id)
    if (!wide) setDrawerOpen(true)
    else if (collapsed) {
      setCollapsed(false)
      writeCollapsed(false)
    }
  }, [app, collapsed, selectedEventIds, wide])

  /**
   * Countdown rows: their own table, their own read, and never part of the event range.
   *
   * They are loaded once when the surface opens rather than with every range fetch, because their
   * distance is counted from today and does not change when the reader navigates a month.
   */
  const countdownFailure = useCallback((message: string) => {
    useUi.getState().toast({ title: t('calendar.countdown.load_failed'), description: message, tone: 'danger' })
  }, [])
  const countdowns = useCountdowns(countdownFailure)
  useEffect(() => {
    void countdowns.reload()
  }, [countdowns.reload])

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

  /** The printed page is built from a range read, so it does not depend on which view is showing. */
  const printCurrentPeriod = useCallback(async (): Promise<void> => {
    const preferences = preferencesRef.current
    const view = String(app.getCurrentView().type).toLowerCase()
    const period = printPeriod(view, app.getCurrentDate(), preferences.timeZone, preferences.weekStart, preferences.agendaDays)
    try {
      const fetched = await api.getEvents({ from: period.fromMs, to: period.toMs })
      if (fetched.truncated || fetched.recurrenceTruncated) {
        useUi.getState().toast({ title: t('calendar.print.truncated'), tone: 'warning' })
        return
      }
      const visible = metaRef.current.calendars.filter(calendar => calendar.isVisible)
      const shown = new Set(visible.map(calendar => calendar.id))
      const events = [...fetched.events, ...fetched.occurrences].filter(event => (
        event.calendarIds.some(id => shown.has(id))
      ))
      const day = (millis: number): string => new Intl.DateTimeFormat(appLocale, {
        dateStyle: 'long', timeZone: preferences.timeZone,
      }).format(new Date(millis))
      setPrintSheet(buildPrintSheet({
        events,
        calendars: visible,
        fromMs: period.fromMs,
        toMs: period.toMs,
        timeZone: preferences.timeZone,
        locale: appLocale,
        timeFormat: preferences.timeFormat,
        title: t('calendar.app.title'),
        subtitle: `${day(period.fromMs)} – ${day(period.toMs)}`,
        emptyLabel: t('calendar.print.empty'),
      }))
    } catch (error) {
      toastFailure(t('calendar.print.failed'), error)
    }
  }, [app, appLocale])

  useEffect(() => {
    if (!printSheet) return
    printCalendarSheet(() => setPrintSheet(null))
  }, [printSheet])

  const closeEventSurfaces = useCallback((): void => {
    app.onEventDetailToggle(null)
    app.onMobileEventDetailToggle(null)
  }, [app])

  const moveSelectedEvents = useCallback((date: string, time: string) => {
    try {
      const updates = batchMoveUpdates(selectedEvents, date, time, preferencesRef.current.timeZone)
      app.applyEventsChanges({ update: updates }, false, 'local')
      clearEventSelection()
      setBatchDialogOpen(false)
    } catch (error) {
      console.debug('[inkstone] Calendar batch move failed.', error)
      useUi.getState().toast({ title: t('calendar.batch.move_failed'), tone: 'danger' })
    }
  }, [app, clearEventSelection, selectedEvents])

  const colorSelectedEvents = useCallback((color: string) => {
    try {
      app.applyEventsChanges({ update: batchColorUpdates(selectedEvents, color) }, false, 'local')
      clearEventSelection()
      setBatchDialogOpen(false)
    } catch (error) {
      console.debug('[inkstone] Calendar batch color update failed.', error)
      useUi.getState().toast({ title: t('calendar.batch.color_failed'), tone: 'danger' })
    }
  }, [app, clearEventSelection, selectedEvents])

  const deleteSelectedEvents = useCallback(async () => {
    const count = selectedEvents.length
    if (count === 0) return
    if (!await confirm({
      title: t('calendar.batch.delete_confirm', { count }),
      confirmLabel: t('calendar.batch.delete'),
      tone: 'danger',
    })) return
    try {
      app.applyEventsChanges({ delete: selectedEvents.map(event => event.id) }, false, 'local')
      clearEventSelection()
      useUi.getState().toast({ title: t('calendar.batch.deleted', { count }), tone: 'success' })
    } catch (error) {
      console.debug('[inkstone] Calendar batch delete failed.', error)
      useUi.getState().toast({ title: t('calendar.event.delete_failed'), tone: 'danger' })
    }
  }, [app, clearEventSelection, selectedEvents])

  /**
   * DayFlow's event panel and mobile drawer still hold the revision the refused write was sent
   * against, and their portals stack above this app's dialogs — a stale editor behind a merge prompt
   * is both a competing writer and an unreachable one.
   */
  /** A parked 409 needs the server's copy before there is anything to compare against. */
  const openConflict = useCallback(async (request: ConflictRequest): Promise<void> => {
    let theirs: CalendarEventDto | null
    try {
      theirs = await api.getEvent(request.id)
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
      await persistenceRef.current?.resolveConflict(request.id, { action: 'server' })
      return
    }
    if (!theirs) {
      await persistenceRef.current?.resolveConflict(request.id, { action: 'server' })
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
  const preferences = useCallback(() => preferencesRef.current, [])
  const handleVisibleRange = useCallback((from: number, to: number): void => {
    setAssistantChrome(current => (current.from === from && current.to === to ? current : { ...current, from, to }))
  }, [])
  const {
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
  } = useCalendarRangeSync({
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
    onVisibleRange: handleVisibleRange,
  })

  const reloadServerState = useCallback((eventId?: string, status?: number) => reloadRef.current(eventId, status), [])
  const {
    refreshCalendars,
    persistCalendarChange,
    persistOrder,
    persistCalendarCreate,
    persistCalendarDelete,
  } = useCalendarRegistry({
    app,
    userId,
    calendars: meta.calendars,
    onRefreshMeta,
    onReloadEvents: reloadServerState,
  })

  const searchAbort = useRef<AbortController | null>(null)
  useEffect(() => () => searchAbort.current?.abort(), [])

  // The library draws the current view; this makes it announce which one that is.
  useEffect(() => observeViewSwitcher(document), [])

  /**
   * DayFlow owns the grid, but not the interaction contract around it: a click must select the event
   * for our extras — inline on a wide screen or in the narrow drawer — instead of opening the
   * library's full-screen sheet, every event needs a keyboard stop, and the compact header/add button
   * must speak the reader's language. The bridge observes re-renders so these stay true after a switch.
   */
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.inkstone-calendar')
    if (!root) return
    return attachCalendarChrome({
      root,
      app,
      locale: appLocale,
      weekStart: meta.preferences.weekStart,
      detailTrigger: meta.preferences.eventDetailTrigger,
      timeFormat: meta.preferences.timeFormat,
      workingHours: meta.preferences.workingHours,
      addLabel: t('calendar.event.new'),
      untitledLabel: t('calendar.event.untitled'),
      allDayLabel: t('calendar.event.all_day'),
      interceptEvents: true,
      isSelected: isEventSelected,
      onAdd: () => setQuickAddOpen(true),
      onRecurring: id => {
        const event = app.getEvents().find(item => item.id === id)
        if (!event) return
        const masterId = event._recurrenceMasterId ?? id.split('::repeat-')[0]
        const masterRev = revs.get(masterId)
        if (!masterId || masterRev === undefined) return
        setRecurrenceRequest({ masterId, masterRev, intent: 'save', before: event, after: event })
      },
      onSelect: selectCalendarEvent,
      onOpenDetail: id => app.onEventDetailToggle(id),
    })
  }, [app, appLocale, isEventSelected, meta.preferences.weekStart, meta.preferences.eventDetailTrigger, meta.preferences.timeFormat, meta.preferences.workingHours, revs, selectCalendarEvent])

  /**
   * The almanac line inside the month cells.
   *
   * The month map is resolved once per render pass and cached for the months a reader actually
   * visited, so the library's re-renders cost a lookup rather than forty-two lunar conversions.
   * `auto` follows the language: a Han interface expects an almanac, others do not.
   */
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.inkstone-calendar')
    if (!root) return
    const showAlmanac = meta.preferences.almanac === 'on'
      || (meta.preferences.almanac === 'auto' && appLocale.toLowerCase().startsWith('zh'))
    return attachAlmanacChrome({
      root,
      weekStart: meta.preferences.weekStart,
      showAlmanac,
      showHolidayMarks: meta.preferences.holidayMarks,
      showWeekColumn: meta.preferences.showWeekNumbers,
      weekLabel: (week, year) => t('calendar.week.column', { week, year }),
      formatDate: (key) => {
        const [year, month, day] = key.split('-').map(Number) as [number, number, number]
        return new Intl.DateTimeFormat(appLocale, { month: 'long', day: 'numeric', weekday: 'short' })
          .format(new Date(year, month - 1, day))
      },
      labelOf: info => cellLabel(info, true),
      holidayLabel: info => info.holiday.makeup
        ? t('calendar.almanac.badge_makeup')
        : info.holiday.off
          ? t('calendar.almanac.badge_off')
          : null,
      onOpenDay: (key) => setAlmanacDate(key),
    })
  }, [appLocale, meta.preferences.almanac, meta.preferences.holidayMarks, meta.preferences.showWeekNumbers, meta.preferences.weekStart])

  const addHolidays = useCallback(async (): Promise<void> => {
    const year = new Date().getFullYear()
    if (!holidayNoticeOf(year)) {
      useUi.getState().toast({ title: t('calendar.holidays.unpublished', { year }), tone: 'warning' })
      return
    }
    try {
      await api.addHolidays({
        calendarName: t('calendar.holidays.calendar_name', { year }),
        holidays: holidayPresets(year),
      })
      useUi.getState().toast({ title: t('calendar.holidays.added'), tone: 'success' })
      await refreshRef.current()
    } catch (error) {
      toastFailure(t('calendar.holidays.failed'), error)
    }
  }, [])

  actions.current = {
    onCalendarCreate: calendar => persistCalendarCreate(calendar),
    onCalendarUpdate: calendar => { void persistCalendarChange(calendar) },
    onCalendarDelete: calendarId => persistCalendarDelete(calendarId),
    onCalendarReorder: () => persistOrder(),
    onGridDoubleClick: date => setCreateStart(date),
    onPrint: () => { void printCurrentPeriod() },
  }

  const persistenceTimeZone = useCallback(() => preferencesRef.current.timeZone, [])
  const persistenceFallbackTitle = useCallback(() => t('calendar.event.untitled'), [])
  const notifyRecurringEdit = useCallback(() => {
    useUi.getState().toast({ title: t('calendar.error.recurring'), tone: 'warning' })
  }, [])
  const notifyReadOnlyEdit = useCallback(() => {
    useUi.getState().toast({ title: t('calendar.event.delete_read_only'), tone: 'warning' })
  }, [])
  const handleCommitted = useCallback((id: string, recurring: boolean): void => {
    if (recurring) scheduleOccurrenceRefresh(id)
  }, [scheduleOccurrenceRefresh])
  const handleDeleted = useCallback((id: string, title: string | undefined): void => {
    toastWithUndo(title ? t('calendar.event.deleted_named', { title }) : t('calendar.event.deleted'), () => {
      if (!history.undo(app, id)) useUi.getState().toast({ title: t('calendar.history.empty') })
    })
  }, [app, history])
  const handleHistoryChange = useCallback(() => setHistoryVersion(version => version + 1), [])

  useCalendarPersistence({
    app,
    userId,
    revs,
    history,
    persistenceRef,
    timeZone: persistenceTimeZone,
    fallbackTitle: persistenceFallbackTitle,
    onServerState: reloadServerState,
    onConflict: openConflict,
    onRecurringEdit: notifyRecurringEdit,
    onRecurrenceOccurrence: setRecurrenceRequest,
    onReadOnlyEdit: notifyReadOnlyEdit,
    onCommitted: handleCommitted,
    onDeleted: handleDeleted,
    onHistoryChange: handleHistoryChange,
  })

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
    const event = app.getEvents().find(item => item.id === selected)
    setExtrasReadOnly(event ? eventCalendarIds(event).some(id => !app.canMutateFromUI(id)) : false)
    setExtrasEventId(selected)
    if (!wide) setDrawerOpen(true)
    else if (collapsed) {
      setCollapsed(false)
      writeCollapsed(false)
    }
  }), [app, wide, collapsed])

  // The assistant's page chip follows the same state the toolbar draws: the view, the day in focus and
  // the range DayFlow has loaded. Reading it on each app change keeps it current when the reader
  // navigates or switches views without this component re-rendering for another reason.
  useEffect(() => {
    const sync = (): void => {
      const view = String(app.getCurrentView().type).toLowerCase()
      const date = app.getCurrentDate().getTime()
      setAssistantChrome(current => (current.view === view && current.date === date ? current : { ...current, view, date }))
    }
    sync()
    return app.subscribe(sync)
  }, [app])

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
      views: toViews(meta.preferences, date => actions.current.onGridDoubleClick?.(date)),
      timeZone: meta.preferences.timeZone,
      timeFormat: meta.preferences.timeFormat,
      calendarSystem: meta.preferences.calendarSystem,
      enableTasks: meta.preferences.enableTasks,
      useEventDetailDialog: meta.preferences.eventDetailDialog,
      eventDetailTrigger: meta.preferences.eventDetailTrigger,
    })
  }, [app, meta.preferences, preferencesSignature])

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
        if (response.truncated) {
          useUi.getState().toast({
            title: t('calendar.search.truncated', { count: response.results.length }),
            tone: 'warning',
          })
        }
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

  // What the assistant is told about this screen: the view, the loaded range and the calendars the
  // reader can actually see. It is rebuilt only when one of those changes, so opening the dock does
  // not re-attach a chip the reader already took off.
  const assistantPageContext = useMemo<AssistantPageContext>(() => {
    const viewKey = ASSISTANT_VIEW_KEYS[assistantChrome.view]
    const viewLabel = viewKey ? t(viewKey) : assistantChrome.view
    const visible = meta.calendars.filter(calendar => calendar.isVisible).map(calendar => calendar.name)
    const names = visible.length > 6 ? `${visible.slice(0, 6).join(', ')}, +${visible.length - 6}` : visible.join(', ')
    return {
      surface: 'calendar',
      label: `${viewLabel} · ${localDate(assistantChrome.date, meta.preferences.timeZone)}`,
      facts: [
        `view: ${assistantChrome.view}`,
        `range: ${localDate(assistantChrome.from, meta.preferences.timeZone)}..${localDate(assistantChrome.to, meta.preferences.timeZone)}`,
        `calendars: ${names || 'none'}`,
        `time zone: ${meta.preferences.timeZone}`,
      ],
    }
  }, [assistantChrome, meta.calendars, meta.preferences.timeZone])

  const sidebar = (
    <CalendarSidebar
      app={app}
      meta={meta}
      preferences={meta.preferences}
      assistantOpen={assistantDockOpen && !isMobile}
      onToggleAssistant={isMobile ? undefined : () => useUi.getState().toggleAssistantDock()}
      variant={wide ? 'inline' : 'drawer'}
      collapsed={collapsed}
      onToggleCollapsed={toggleCollapsed}
      onClose={() => setDrawerOpen(false)}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenFilteredSearch={() => setFilteredSearchOpen(true)}
      onOpenQuickAdd={() => setQuickAddOpen(true)}
      onOpenTemplates={() => setTemplatesOpen(true)}
      onOpenFreeBusy={() => setFreeBusyOpen(true)}
      onOpenResources={() => setResourcesOpen(true)}
      onOpenScheduling={() => setSchedulingOpen(true)}
      onOpenShortcuts={() => setShortcutsOpen(true)}
      onOpenContacts={() => setContactsOpen(true)}
      onAddHolidays={() => { void addHolidays() }}
      onRefresh={refreshCalendars}
      onSelectDate={date => app.setCurrentDate(date)}
      onRequestRange={loadRange}
      onPrint={() => { void printCurrentPeriod() }}
      canUndo={historyView.canUndo}
      canRedo={historyView.canRedo}
      onUndo={() => { if (history.undo(app)) setHistoryVersion(version => version + 1) }}
      onRedo={() => { if (history.redo(app)) setHistoryVersion(version => version + 1) }}
      tasks={meta.preferences.enableTasks ? (
        <CalendarTasksPanel app={app} calendars={meta.calendars} from={lastRange.current.from} to={lastRange.current.to} timeZone={meta.preferences.timeZone} onChanged={() => { void reloadRef.current() }} />
      ) : undefined}
      countdowns={(
        <CountdownsCard
          items={countdowns.items}
          timeZone={meta.preferences.timeZone}
          loading={countdowns.loading}
          error={countdowns.error}
          onAdd={() => setCountdownEditing(null)}
          onOpenCountdown={(id) => {
            const item = countdowns.items.find(row => row.id === id) ?? null
            if (item) setCountdownEditing(item)
          }}
        />
      )}
      activity={<CalendarHeatmapCard today={new Date()} />}
      extras={extrasEventId ? (
        <CalendarEventExtras
          eventId={extrasEventId}
          accountTimeZone={meta.preferences.timeZone}
          locale={appLocale}
          calendars={meta.calendars}
          readOnly={extrasReadOnly}
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
        {meta.preferences.travelMode
          && Intl.DateTimeFormat().resolvedOptions().timeZone !== meta.preferences.timeZone
          && (
            <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {t('calendar.travel_mode.notice', {
                  device: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  calendar: meta.preferences.timeZone,
                })}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  void onSavePreferences({
                    ...meta.preferences,
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  }).catch((error: unknown) => toastFailure(t('calendar.error.save_failed'), error))
                }}
              >
                {t('calendar.travel_mode.switch')}
              </Button>
            </div>
          )}

        {rangeLoading && (
          <div role="status" aria-live="polite" className="shrink-0">
            <span className="sr-only">{t('calendar.range.loading')}</span>
            <div aria-hidden="true" className="h-0.5 w-full animate-pulse bg-[var(--accent)]" />
          </div>
        )}

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

        {assistantChrome.view === 'month' && (
          <CountdownStrip
            items={countdowns.items}
            timeZone={meta.preferences.timeZone}
            onOpen={(id) => {
              const item = countdowns.items.find(row => row.id === id) ?? null
              if (item) setCountdownEditing(item)
            }}
          />
        )}

        {selectedEvents.length > 1 && (
          <div role="toolbar" aria-label={t('calendar.batch.title', { count: selectedEvents.length })} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
            <span role="status" className="mr-auto text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('calendar.batch.title', { count: selectedEvents.length })}
            </span>
            <Button size="sm" variant="ghost" onClick={clearEventSelection}>{t('calendar.batch.clear')}</Button>
            <Button size="sm" variant="secondary" onClick={() => setBatchDialogOpen(true)}>{t('calendar.batch.edit')}</Button>
            <Button size="sm" variant="danger" onClick={() => { void deleteSelectedEvents() }}>{t('calendar.batch.delete')}</Button>
          </div>
        )}

        <div className="inkstone-calendar min-h-0 flex-1">
          <DayFlowCalendar calendar={app} search={search} sidebar={() => null} />
        </div>
      </div>

      {assistantDockOpen && !isMobile && (
        <AssistantDock surface="calendar" pageContext={assistantPageContext} />
      )}

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

      {batchDialogOpen && selectedEvents.length > 1 && (
        <CalendarBatchDialog
          open
          events={selectedEvents}
          timeZone={meta.preferences.timeZone}
          onClose={() => setBatchDialogOpen(false)}
          onMove={moveSelectedEvents}
          onColor={colorSelectedEvents}
        />
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

      {quickAddOpen && (
        <CalendarQuickAdd
          open
          app={app}
          timeZone={meta.preferences.timeZone}
          onClose={() => setQuickAddOpen(false)}
        />
      )}

      {createStart && (
        <CalendarEventDialog
          open
          initialStart={createStart}
          timeZone={meta.preferences.timeZone}
          calendars={meta.calendars}
          resources={meta.resources ?? []}
          defaultCalendarId={defaultCalendarId(meta)}
          template={template}
          onClose={() => { setCreateStart(null); setTemplate(null) }}
          onCreate={(draft: NewCalendarEvent) => {
            app.addEvent({
              id: crypto.randomUUID(),
              title: draft.title,
              description: draft.description || undefined,
              start: draft.allDay ? draft.startDate : draft.start,
              end: draft.allDay ? draft.endDate : draft.end,
              allDay: draft.allDay,
              calendarId: draft.calendarId,
              calendarIds: [draft.calendarId],
              meta: {
                ...(draft.color ? { color: draft.color } : {}),
                ...(draft.resourceId ? { resourceId: draft.resourceId } : {}),
                ...(draft.location ? { location: draft.location } : {}),
              },
            })
            useUi.getState().toast({ title: t('calendar.event.created'), tone: 'success' })
            setCreateStart(null)
            setTemplate(null)
          }}
        />
      )}

      <CalendarContactsDialog
        open={contactsOpen}
        onClose={() => setContactsOpen(false)}
        onChanged={async () => { await refreshRef.current() }}
      />

      <CalendarTemplatesDialog
        open={templatesOpen}
        onUse={(chosen) => {
          setTemplatesOpen(false)
          setTemplate(chosen)
          setCreateStart(new Date())
        }}
        onClose={() => setTemplatesOpen(false)}
      />

      <CalendarAlmanacDialog
        open={almanacDate !== null}
        dateKey={almanacDate}
        countdowns={countdowns.items}
        onClose={() => setAlmanacDate(null)}
        onJump={(path) => navigateToPath(path)}
      />

      {countdownEditing !== undefined && (
        <CountdownDialog
          key={countdownEditing?.id ?? 'new'}
          open
          item={countdownEditing}
          timeZone={meta.preferences.timeZone}
          onClose={() => setCountdownEditing(undefined)}
          onSaved={() => { void countdowns.reload() }}
        />
      )}

      <CalendarFilteredSearch
        open={filteredSearchOpen}
        calendars={meta.calendars}
        timeZone={meta.preferences.timeZone}
        onClose={() => setFilteredSearchOpen(false)}
        onPick={(result) => {
          const date = calendarSearchResultDate(result, meta.preferences.timeZone)
          if (date) app.setCurrentDate(date)
          app.highlightEvent(result.event.id)
          app.selectEvent(result.event.id)
          const ids = eventCalendarIds(result.event)
          setExtrasReadOnly(ids.some(id => meta.calendars.find(calendar => calendar.id === id)?.readOnly === true))
        }}
      />

      <CalendarConnections
        open={connectionsOpen}
        connections={meta.connections}
        onClose={() => setConnectionsOpen(false)}
        onChanged={async () => { await refreshRef.current() }}
      />

      <CalendarPrintSheet sheet={printSheet} />

      <CalendarShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <CalendarSchedulingDialog
        open={schedulingOpen}
        calendars={meta.calendars}
        onClose={() => setSchedulingOpen(false)}
      />

      <CalendarResourcesDialog
        open={resourcesOpen}
        onClose={() => setResourcesOpen(false)}
        onChanged={async () => { await refreshRef.current() }}
      />

      <CalendarFreeBusyDialog
        open={freeBusyOpen}
        calendars={meta.calendars}
        timeZone={meta.preferences.timeZone}
        workingHours={meta.preferences.workingHours}
        initialDate={app.getCurrentDate()}
        onClose={() => setFreeBusyOpen(false)}
        onPick={(start) => { setCreateStart(start) }}
      />

      {recurrenceRequest && (
        <CalendarRecurrenceDialog
          request={recurrenceRequest}
          timeZone={meta.preferences.timeZone}
          onClose={() => setRecurrenceRequest(null)}
          onApplied={async () => {
            markExceptionMaster(recurrenceRequest.masterId)
            dropOccurrencesForMaster(recurrenceRequest.masterId)
            await reloadRef.current()
          }}
        />
      )}

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
