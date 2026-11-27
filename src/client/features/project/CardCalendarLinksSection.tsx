import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { CalendarDays, Link2, Plus, Trash2 } from 'lucide-react'
import type { ProjectCalendarLink, ProjectProperty } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { Modal } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { useUi } from '../../store/ui'
import { getEvents, getMeta } from '../calendar/api'
import { fetchProjectCalendarLinks, linkProjectCalendar, unlinkProjectCalendar } from './api'

export function CardCalendarLinksSection({ cardId, properties, canEdit }: {
  cardId: string
  properties: ProjectProperty[]
  canEdit: boolean
}): ReactElement {
  const locale = useLocale()
  const toast = useUi((state) => state.toast)
  const [links, setLinks] = useState<ProjectCalendarLink[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const [propertyId, setPropertyId] = useState('')
  const [calendarId, setCalendarId] = useState('')
  const [eventId, setEventId] = useState('')
  const [events, setEvents] = useState<Array<{ id: string, title: string, calendarId: string, start: number }>>([])
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [saving, setSaving] = useState(false)
  const dateProperties = useMemo(() => properties.filter((property) => property.type === 'date'), [properties])

  useEffect(() => {
    const controller = new AbortController()
    setLinks(null)
    setError(false)
    fetchProjectCalendarLinks(cardId, controller.signal)
      .then(setLinks)
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [cardId, attempt])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoadingOptions(true)
    const now = Date.now()
    Promise.all([
      getMeta(undefined, controller.signal),
      getEvents({ from: now - 30 * 86_400_000, to: now + 365 * 86_400_000, includeOccurrences: false }, controller.signal),
    ])
      .then(([meta, range]) => {
        const writable = new Set(meta.calendars.filter((calendar) => !calendar.readOnly).map((calendar) => calendar.id))
        setEvents(range.events.filter((event) => writable.has(event.calendarId)).map((event) => ({
          id: event.id,
          title: event.title,
          calendarId: event.calendarId,
          start: new Date(event.start.value).getTime(),
        })))
        setCalendarId(meta.calendars.find((calendar) => writable.has(calendar.id))?.id ?? '')
        setPropertyId(dateProperties[0]?.id ?? '')
        setEventId(range.events.find((event) => writable.has(event.calendarId))?.id ?? '')
      })
      .catch(() => { if (!controller.signal.aborted) setEvents([]) })
      .finally(() => { if (!controller.signal.aborted) setLoadingOptions(false) })
    return () => controller.abort()
  }, [open, dateProperties])

  const save = useCallback(async (): Promise<void> => {
    if (!propertyId || !calendarId || !eventId) return
    setSaving(true)
    try {
      await linkProjectCalendar(cardId, { propertyId, calendarId, eventId })
      setOpen(false)
      setAttempt((current) => current + 1)
    } catch (cause: unknown) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }, [cardId, propertyId, calendarId, eventId, toast])

  const remove = async (linkId: string): Promise<void> => {
    try {
      await unlinkProjectCalendar(cardId, linkId)
      setAttempt((current) => current + 1)
    } catch (cause: unknown) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  return (
    <section aria-label={t('project.card.calendar_links')} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]"><CalendarDays size={13} aria-hidden="true" />{t('project.card.calendar_links')}</h3>
        {canEdit && dateProperties.length > 0 && <IconButton label={t('project.card.link_calendar')} size="sm" onClick={() => setOpen(true)}><Plus size={13} /></IconButton>}
      </div>
      {error
        ? <Button size="sm" variant="ghost" onClick={() => setAttempt((current) => current + 1)}>{t('common.retry')}</Button>
        : links === null
          ? <LoadingBlock />
          : links.length === 0
            ? <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.card.calendar_links_empty')}</p>
            : (
                <ul className="space-y-1">
                  {links.map((link) => (
                    <li key={link.id} className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1.5">
                      <Link2 size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{link.eventTitle}</span>
                      <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{new Date(link.eventStart).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
                      {canEdit && <IconButton label={t('project.card.unlink_calendar')} size="sm" onClick={() => void remove(link.id)}><Trash2 size={12} /></IconButton>}
                    </li>
                  ))}
                </ul>
              )}
      {open && (
        <Modal open onClose={() => setOpen(false)} title={t('project.card.link_calendar')} width={520}>
          <div className="space-y-3">
            <SelectMenu className="w-full" label={t('project.card.calendar_property')} value={propertyId} onChange={setPropertyId} options={dateProperties.map((property) => ({ value: property.id, label: property.name }))} />
            <SelectMenu
              className="w-full"
              label={t('project.card.calendar_event')}
              value={eventId}
              onChange={(id) => {
                setEventId(id)
                const event = events.find((entry) => entry.id === id)
                if (event?.calendarId) setCalendarId(event.calendarId)
              }}
              options={events.map((event) => ({ value: event.id, label: `${event.title || t('project.board.untitled_card')} · ${new Date(event.start).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}` }))}
            />
            {loadingOptions
              ? <LoadingBlock />
              : events.length === 0
                ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.card.calendar_events_empty')}</p>
                : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" loading={saving} disabled={!propertyId || !calendarId || !eventId || loadingOptions} onClick={() => void save()}>{t('common.save')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
