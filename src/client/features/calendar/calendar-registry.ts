import type { ICalendarApp, CalendarType } from '@dayflow/react'
import type { CalendarDto } from '@shared/calendar/model'
import type { CalendarCreateInput, CalendarPatchInput } from './api'
import { calendarSourceOf } from './model'

export function calendarNeedsUpdate(current: CalendarType, desired: CalendarType): boolean {
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

export function applyCalendarOrder(app: ICalendarApp, ids: string[]): void {
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

export function calendarPatch(dto: CalendarDto, calendar: CalendarType): Omit<CalendarPatchInput, 'rev'> {
  const patch: Omit<CalendarPatchInput, 'rev'> = {}
  if (calendar.name !== dto.name) patch.name = calendar.name
  if (calendar.colors.lineColor !== dto.color) {
    patch.color = calendar.colors.lineColor
    patch.darkColor = calendar.darkColors?.lineColor
  }
  if ((calendar.readOnly === true) !== dto.readOnly) patch.readOnly = calendar.readOnly === true
  if ((calendar.isVisible !== false) !== dto.isVisible) patch.isVisible = calendar.isVisible !== false
  if ((calendar.isDefault === true) !== dto.isDefault) patch.isDefault = calendar.isDefault === true
  return patch
}

export function calendarCreateInput(calendar: CalendarType): CalendarCreateInput {
  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.colors.lineColor,
    darkColor: calendar.darkColors?.lineColor,
    isDefault: calendar.isDefault,
    isVisible: calendar.isVisible !== false,
    readOnly: calendar.readOnly === true,
    source: calendarSourceOf(calendar.source),
  }
}
