import { useEffect, useRef } from 'react'
import { ViewType, type ICalendarApp } from '@dayflow/react'
import { CALENDAR_VIEWS, type CalendarPreferences, type CalendarViewName } from '@shared/calendar/model'
import { calendarRouteHref, readCalendarRouteState } from './view-state'

const CONTINUOUS_NAVIGATION_MS = 400

interface NavigationSnapshot {
  view: ViewType
  date: number
}

export function calendarViewType(name: CalendarPreferences['defaultView']): ViewType {
  return ViewType[name.toUpperCase() as keyof typeof ViewType]
}

function snapshot(app: ICalendarApp): NavigationSnapshot {
  return { view: app.getCurrentView().type as ViewType, date: app.getCurrentDate().getTime() }
}

function sameDay(left: number, right: number): boolean {
  const a = new Date(left)
  const b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function useCalendarNavigation(app: ICalendarApp, defaultView: CalendarPreferences['defaultView']): void {
  const applyingPopState = useRef(false)

  useEffect(() => {
    let previous = snapshot(app)
    let lastDateChange = Number.NEGATIVE_INFINITY
    let frame: number | undefined
    let frameMode: 'push' | 'replace' = 'replace'

    const write = (mode: 'push' | 'replace'): void => {
      frame = undefined
      frameMode = 'replace'
      if (!(CALENDAR_VIEWS as readonly string[]).includes(previous.view)) return
      const next = calendarRouteHref(window.location.href, previous.view as CalendarViewName, new Date(previous.date))
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
      if (next === current) return
      window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', next)
    }

    const schedule = (): void => {
      if (applyingPopState.current) return
      const next = snapshot(app)
      if (next.view === previous.view && next.date === previous.date) return
      const now = performance.now()
      const viewChanged = next.view !== previous.view
      const continuous = !viewChanged && now - lastDateChange < CONTINUOUS_NAVIGATION_MS
      const mode = viewChanged || !continuous ? 'push' : 'replace'
      if (!viewChanged) lastDateChange = now
      previous = next
      if (frame === undefined) frameMode = mode
      else if (mode === 'push') frameMode = 'push'
      frame ??= window.requestAnimationFrame(() => write(frameMode))
    }

    const onPopState = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = undefined
      frameMode = 'replace'
      const route = readCalendarRouteState(window.location.search)
      const view = calendarViewType(route.view ?? defaultView)
      const date = route.date ?? new Date()
      applyingPopState.current = true
      try {
        if (app.getCurrentView().type !== view) app.changeView(view)
        if (!sameDay(app.getCurrentDate().getTime(), date.getTime())) app.setCurrentDate(date)
      } finally {
        applyingPopState.current = false
      }
      previous = snapshot(app)
      lastDateChange = Number.NEGATIVE_INFINITY
      write('replace')
    }

    const normalized = calendarRouteHref(window.location.href, previous.view as CalendarViewName, new Date(previous.date))
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (normalized !== current) window.history.replaceState(window.history.state, '', normalized)
    const unsubscribe = app.subscribe(schedule)
    window.addEventListener('popstate', onPopState)
    return () => {
      unsubscribe()
      window.removeEventListener('popstate', onPopState)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [app, defaultView])
}
