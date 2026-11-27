/** Calendar registry reconciliation and calendar-level writes, separate from event persistence. */
import { useCallback, useEffect, useRef } from 'react'
import type { CalendarType, ICalendarApp } from '@dayflow/react'
import type { CalendarDto, CalendarMetaDto } from '@shared/calendar/model'
import { isSharedCalendarId } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { toastFailure } from './calendar-notifications'
import { readHiddenShared, writeHiddenShared } from './shared-visibility'
import { toCalendarType } from './model'
import { applyCalendarOrder, calendarCreateInput, calendarNeedsUpdate, calendarPatch } from './calendar-registry'
import * as api from './api'

interface UseCalendarRegistryOptions {
  app: ICalendarApp
  userId: string | undefined
  calendars: CalendarDto[]
  onRefreshMeta: () => Promise<CalendarMetaDto>
  onReloadEvents: () => Promise<void>
}

export function useCalendarRegistry({
  app,
  userId,
  calendars,
  onRefreshMeta,
  onReloadEvents,
}: UseCalendarRegistryOptions) {
  const suppressUpdate = useRef(new Set<string>())
  const suppressCreate = useRef(new Set<string>())
  const suppressDelete = useRef(new Set<string>())
  const suppressReorder = useRef(false)
  const calendarsRef = useRef(calendars)
  calendarsRef.current = calendars

  const syncRegistry = useCallback(async (next: CalendarDto[]): Promise<void> => {
    const hiddenShared = userId ? readHiddenShared(userId) : new Set<string>()
    const desired = next.map((dto) => {
      const calendar = toCalendarType(dto)
      if (isSharedCalendarId(dto.id) && hiddenShared.has(dto.id)) calendar.isVisible = false
      return calendar
    })
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
  }, [app, userId])

  const refreshCalendars = useCallback(async (reloadEvents: boolean): Promise<void> => {
    const next = await onRefreshMeta()
    await syncRegistry(next.calendars)
    if (reloadEvents) await onReloadEvents()
  }, [onRefreshMeta, onReloadEvents, syncRegistry])

  const persistCalendarChange = useCallback(async (calendar: CalendarType): Promise<void> => {
    if (suppressUpdate.current.delete(calendar.id)) return
    if (isSharedCalendarId(calendar.id)) {
      const hidden = userId ? readHiddenShared(userId) : new Set<string>()
      if (calendar.isVisible === false) hidden.add(calendar.id)
      else hidden.delete(calendar.id)
      if (userId) writeHiddenShared(userId, hidden)
      return
    }
    const dto = calendarsRef.current.find(item => item.id === calendar.id)
    if (!dto) return
    const patch = calendarPatch(dto, calendar)
    if (Object.keys(patch).length === 0) return
    try {
      await api.updateCalendar(calendar.id, patch, dto.rev)
    } catch (error) {
      toastFailure(t('calendar.sidebar.visibility_failed'), error)
      try {
        await onRefreshMeta()
      } catch (refreshError) {
        toastFailure(t('calendar.error.refresh'), refreshError)
      }
      return
    }
    try {
      await onRefreshMeta()
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
    }
  }, [onRefreshMeta, userId])

  const persistOrder = useCallback((): void => {
    if (suppressReorder.current) return
    const ids = app.getCalendars().filter(calendar => !isSharedCalendarId(calendar.id)).map(calendar => calendar.id)
    void api.reorderCalendars(ids).catch(async (error) => {
      toastFailure(t('calendar.sidebar.order_failed'), error)
      try {
        await onRefreshMeta()
      } catch (refreshError) {
        toastFailure(t('calendar.error.refresh'), refreshError)
      }
    })
  }, [app, onRefreshMeta])

  const persistCalendarCreate = useCallback(async (calendar: CalendarType): Promise<void> => {
    if (suppressCreate.current.delete(calendar.id)) return
    try {
      await api.createCalendar(calendarCreateInput(calendar))
    } catch (error) {
      suppressDelete.current.add(calendar.id)
      await app.deleteCalendar(calendar.id)
      toastFailure(t('calendar.calendar.action_failed'), error)
      return
    }
    try {
      await onRefreshMeta()
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
    }
  }, [app, onRefreshMeta])

  const persistCalendarDelete = useCallback(async (calendarId: string): Promise<void> => {
    if (suppressDelete.current.delete(calendarId)) return
    if (isSharedCalendarId(calendarId)) return
    const dto = calendarsRef.current.find(item => item.id === calendarId)
    if (!dto) return
    try {
      await api.deleteCalendar(calendarId, { kind: 'delete', rev: dto.rev })
    } catch (error) {
      toastFailure(t('calendar.calendar.action_failed'), error)
      try {
        await onRefreshMeta()
      } catch (refreshError) {
        toastFailure(t('calendar.error.refresh'), refreshError)
      }
      return
    }
    try {
      await onRefreshMeta()
    } catch (error) {
      toastFailure(t('calendar.error.refresh'), error)
    }
  }, [onRefreshMeta])

  useEffect(() => {
    void syncRegistry(calendars).catch(error => toastFailure(t('calendar.error.refresh'), error))
  }, [calendars, syncRegistry])

  return {
    refreshCalendars,
    persistCalendarChange,
    persistOrder,
    persistCalendarCreate,
    persistCalendarDelete,
  }
}
