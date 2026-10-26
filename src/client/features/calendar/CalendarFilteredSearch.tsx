/** A filtered calendar search: keyword, calendar, date span and kind, in one panel. */
import { useEffect, useState } from 'react'
import { CalendarDays, CalendarSearch } from 'lucide-react'
import type { CalendarDto, CalendarEventDto, CalendarSearchResultDto } from '@shared/calendar/model'
import { parseTemporalValue } from '@shared/calendar/model'
import { t, useLocale } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input, Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import * as api from './api'

interface CalendarFilteredSearchProps {
  open: boolean
  calendars: readonly CalendarDto[]
  onClose: () => void
  onPick: (result: CalendarSearchResultDto) => void
}

export function calendarSearchResultDate(result: CalendarSearchResultDto): Date | null {
  try {
    const value = parseTemporalValue(result.event.start)
    if ('epochMilliseconds' in value) return new Date(value.epochMilliseconds)
    return new Date(value.year, value.month - 1, value.day)
  } catch {
    return null
  }
}

function resultLabel(result: CalendarSearchResultDto, locale: string): string {
  const date = calendarSearchResultDate(result)
  if (!date) return ''
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

export function CalendarFilteredSearch({ open, calendars, onClose, onPick }: CalendarFilteredSearchProps) {
  const locale = useLocale()
  const [keyword, setKeyword] = useState('')
  const [calendarId, setCalendarId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<'' | 'event' | 'task'>('')
  const [results, setResults] = useState<CalendarSearchResultDto[]>([])
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<CalendarSearchResultDto | null>(null)

  const submit = async (): Promise<void> => {
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : undefined
    const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : undefined
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
      setError(t('calendar.filtered_search.date_order'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await api.searchEvents(keyword, undefined, {
        ...(calendarId ? { calendarIds: [calendarId] } : {}),
        ...(fromMs === undefined ? {} : { from: fromMs }),
        ...(toMs === undefined ? {} : { to: toMs }),
        ...(kind ? { kind } : {}),
      })
      setResults(response.results)
      setSearched(true)
    } catch (searchError) {
      setError(searchError instanceof Error && searchError.message ? searchError.message : t('calendar.search.failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.filtered_search.title')}
      description={t('calendar.filtered_search.description')}
      width={620}
      footer={<Button variant="primary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
            <span className="font-medium">{t('calendar.filtered_search.keyword')}</span>
            <Input
              data-autofocus
              value={keyword}
              placeholder={t('calendar.filtered_search.keyword_placeholder')}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
            <span className="font-medium">{t('calendar.filtered_search.calendar')}</span>
            <Select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>
              <option value="">{t('calendar.filtered_search.all_calendars')}</option>
              {calendars.map(calendar => (
                <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
            <span className="font-medium">{t('calendar.filtered_search.from')}</span>
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
            <span className="font-medium">{t('calendar.filtered_search.to')}</span>
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
            <span className="font-medium">{t('calendar.filtered_search.kind')}</span>
            <Select value={kind} onChange={(event) => setKind(event.target.value as '' | 'event' | 'task')}>
              <option value="">{t('calendar.filtered_search.all_kinds')}</option>
              <option value="event">{t('calendar.filtered_search.kind_event')}</option>
              <option value="task">{t('calendar.filtered_search.kind_task')}</option>
            </Select>
          </label>
          <div className="flex items-end">
            <Button variant="primary" loading={loading} onClick={() => void submit()} icon={<CalendarSearch size={14} aria-hidden="true" />}>
              {t('calendar.filtered_search.submit')}
            </Button>
          </div>
        </div>

        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}

        {searched && (
          results.length === 0
            ? <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('calendar.search.empty')}</p>
            : (
                <ul className="max-h-72 overflow-y-auto rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
                  {results.map(result => (
                    <li key={result.event.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
                      <div className="flex items-center gap-1 pr-1.5">
                        <button
                          type="button"
                          onClick={() => { onPick(result); onClose() }}
                          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                        >
                          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: result.calendarColor }} aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{result.event.title}</span>
                            <span className="block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                              {result.calendarName} · {resultLabel(result, locale)}
                            </span>
                          </span>
                        </button>
                        <IconButton
                          size="xs"
                          label={t('calendar.filtered_search.manage')}
                          onClick={() => setEditing(result)}
                        >
                          <CalendarDays size={13} />
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )
        )}
      </div>

      {editing && (
        <EventCalendarDialog
          result={editing}
          calendars={calendars}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setResults(current => current.map(entry => entry.event.id === updated.id
              ? { ...entry, event: updated }
              : entry))
          }}
        />
      )}
    </Modal>
  )
}


function EventCalendarDialog({
  result,
  calendars,
  onClose,
  onSaved,
}: {
  result: CalendarSearchResultDto
  calendars: readonly CalendarDto[]
  onClose: () => void
  onSaved: (event: CalendarEventDto) => void
}) {
  const initial = result.event.calendarIds.length > 0
    ? result.event.calendarIds
    : result.event.calendarId ? [result.event.calendarId] : []
  const [selected, setSelected] = useState<string[]>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelected(initial)
    setSaving(false)
    setError(null)
  }, [result.event.id])

  const toggle = (id: string, checked: boolean): void => {
    setSelected(current => checked
      ? [...new Set([...current, id])]
      : current.filter(value => value !== id))
  }

  const save = async (): Promise<void> => {
    if (selected.length === 0) {
      setError(t('calendar.filtered_search.pick_one'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateEventCalendars(result.event.id, selected, result.event.rev)
      useUi.getState().toast({ title: t('calendar.filtered_search.updated'), tone: 'success' })
      onSaved(updated)
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error && saveError.message ? saveError.message : t('calendar.filtered_search.update_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('calendar.filtered_search.manage_title')}
      description={t('calendar.filtered_search.manage_description')}
      width={420}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-1.5">
        {calendars.map(calendar => (
          <Checkbox
            key={calendar.id}
            checked={selected.includes(calendar.id)}
            disabled={calendar.readOnly}
            onChange={checked => toggle(calendar.id, checked)}
            label={(
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: calendar.color }} aria-hidden="true" />
                <span>{calendar.name}</span>
                {calendar.readOnly && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('calendar.sidebar.read_only')}</span>}
              </span>
            )}
          />
        ))}
        {error && <p role="alert" className="mt-2 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
