/**
 * Countdowns: the strip above the month grid and the card in the sidebar.
 *
 * Both surfaces read the same sorted rows, so a pinned date sits in the same place wherever the
 * reader looks. Editing happens in one dialog, opened from the card; the grid only shows the pinned
 * few, because a strip that lists everything stops being a strip.
 *
 * A countdown never becomes a DayFlow event. The surface's write pipeline treats every event in the
 * app as calendar data, so a synthetic row would be dragged, edited and saved into the calendar's own
 * table — the one thing this feature must not do.
 */

import { useCallback, useMemo, useState } from 'react'
import { CalendarHeart, Plus, Pin, Trash2 } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { CalendarCountdownDto, CalendarCountdownInput, CountdownRepeat } from '@shared/calendar/countdown'
import {
  countdownOccurrence,
  countdownOrdinal,
  isCountdownDate,
  MAX_COUNTDOWN_NOTE,
  MAX_COUNTDOWN_TITLE,
  sortCountdowns,
} from '@shared/calendar/countdown'
import { CALENDAR_COLOR_PRESETS } from './model'
import { cn } from '../../lib/cn'
import { dateKey } from '../../lib/time'
import { t } from '../../lib/i18n'
import { Button, IconButton, SectionLabel } from '../../components/primitives'
import { Field, Input, Segmented, Switch, Textarea } from '../../components/form'
import { Modal, Tooltip } from '../../components/overlay'
import { DatePicker } from '../../components/date-picker'
import * as api from './api'

function todayOf(): Temporal.PlainDate {
  return Temporal.PlainDate.from(dateKey(new Date()))
}

function distanceLabel(days: number): string {
  if (days === 0) return t('calendar.countdown.today')
  if (days < 0) return t('calendar.countdown.passed', { days: -days })
  return t('calendar.countdown.days', { days })
}

/** The same distance in the chosen colour, or the accent when the reader never chose one. */
function rowColor(item: CalendarCountdownDto): string {
  return item.color || 'var(--accent)'
}

interface CountdownStripProps {
  items: readonly CalendarCountdownDto[]
  onOpen: (id: string) => void
}

export function CountdownStrip({ items, onOpen }: CountdownStripProps) {
  const today = useMemo(todayOf, [])
  const pinned = useMemo(
    () => sortCountdowns(items.filter(item => item.pinned), today),
    [items, today],
  )
  if (pinned.length === 0) return null
  return (
    <section
      aria-label={t('calendar.countdown.pinned_strip')}
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5"
    >
      <Pin size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
      {pinned.map((item) => {
        const occurrence = countdownOccurrence(item, today)
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item.id)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: rowColor(item) }} />
            <span className="max-w-40 truncate">{item.title}</span>
            <span className="tabular font-medium text-[var(--text-primary)]">{distanceLabel(occurrence.days)}</span>
          </button>
        )
      })}
    </section>
  )
}

interface CountdownsCardProps {
  items: readonly CalendarCountdownDto[]
  loading: boolean
  error: string | null
  onOpenCountdown: (id: string) => void
  onAdd: () => void
}

export function CountdownsCard({ items, loading, error, onOpenCountdown, onAdd }: CountdownsCardProps) {
  const today = useMemo(todayOf, [])
  const sorted = useMemo(() => sortCountdowns(items, today), [items, today])
  return (
    <section aria-label={t('calendar.countdown.title')} className="px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-1">
        <SectionLabel className="flex min-w-0 items-center gap-1">
          <CalendarHeart size={12} aria-hidden="true" />
          <span className="truncate">{t('calendar.countdown.title')}</span>
        </SectionLabel>
        <Tooltip label={t('calendar.countdown.add')}>
          <IconButton size="sm" label={t('calendar.countdown.add')} onClick={onAdd}>
            <Plus size={13} aria-hidden="true" />
          </IconButton>
        </Tooltip>
      </div>
      {loading && items.length === 0 && (
        <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('calendar.countdown.loading')}</p>
      )}
      {error && (
        <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>
      )}
      {!loading && !error && sorted.length === 0 && (
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">{t('calendar.countdown.empty_hint')}</p>
      )}
      {sorted.length > 0 && (
        <ul className="space-y-0.5">
          {sorted.map((item) => {
            const occurrence = countdownOccurrence(item, today)
            const ordinal = countdownOrdinal(item, occurrence)
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onOpenCountdown(item.id)}
                  aria-label={[item.title, occurrence.date.toString(), distanceLabel(occurrence.days), item.pinned ? t('calendar.countdown.pinned') : ''].filter(Boolean).join(' ')}
                  className="flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-1 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                >
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: rowColor(item) }} />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{item.title}</span>
                  {item.pinned && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />}
                  {item.repeat !== 'none' && ordinal > 1 && (
                    <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('calendar.countdown.ordinal', { n: ordinal })}</span>
                  )}
                  <span className={cn(
                    'shrink-0 tabular text-[length:var(--text-11)] font-medium',
                    occurrence.days < 0 ? 'text-[var(--text-quaternary)]' : 'text-[var(--text-primary)]',
                  )}>
                    {distanceLabel(occurrence.days)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {!loading && !error && sorted.length > 0 && (
        <div className="mt-1">
          <Button size="sm" variant="ghost" icon={<Plus size={12} aria-hidden="true" />} onClick={onAdd}>{t('calendar.countdown.add')}</Button>
        </div>
      )}
    </section>
  )
}

interface CountdownDialogProps {
  open: boolean
  /** The row being edited, or null for a new one. */
  item: CalendarCountdownDto | null
  onClose: () => void
  onSaved: () => void
}

export function CountdownDialog({ open, item, onClose, onSaved }: CountdownDialogProps) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [date, setDate] = useState(item?.date ?? dateKey(new Date()))
  const [repeat, setRepeat] = useState<CountdownRepeat>(item?.repeat ?? 'none')
  const [note, setNote] = useState(item?.note ?? '')
  const [color, setColor] = useState(item?.color ?? '')
  const [pinned, setPinned] = useState(item?.pinned ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!isCountdownDate(date)) {
      setError(t('calendar.countdown.date_invalid'))
      return
    }
    const payload: CalendarCountdownInput & { rev?: number } = {
      title: title.trim().slice(0, MAX_COUNTDOWN_TITLE),
      date,
      repeat,
      note: note.slice(0, MAX_COUNTDOWN_NOTE),
      color,
      pinned,
    }
    setSaving(true)
    setError(null)
    try {
      if (item) await api.updateCountdown(item.id, { ...payload, rev: item.rev })
      else await api.createCountdown(payload)
      onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.countdown.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!item) return
    setSaving(true)
    setError(null)
    try {
      await api.deleteCountdown(item.id, item.rev)
      onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.countdown.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={item ? t('calendar.countdown.edit') : t('calendar.countdown.add')}
      description={t('calendar.countdown.dialog_hint')}
      width={480}
      dismissible={!saving}
      footer={(
        <>
          {item && (
            <Button variant="ghost" className="mr-auto text-[var(--danger)]" icon={<Trash2 size={13} aria-hidden="true" />} disabled={saving} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('calendar.countdown.field.title')} required>
          <Input value={title} maxLength={MAX_COUNTDOWN_TITLE} onChange={event => setTitle(event.target.value)} />
        </Field>
        <Field label={t('calendar.countdown.field.date')}>
          <DatePicker label={t('calendar.countdown.field.date')} value={date} onChange={setDate} />
        </Field>
        <Field label={t('calendar.countdown.field.repeat')} hint={t('calendar.countdown.repeat_hint')}>
          <Segmented<CountdownRepeat>
            label={t('calendar.countdown.field.repeat')}
            value={repeat}
            onChange={setRepeat}
            options={[
              { value: 'none', label: t('calendar.countdown.repeat.none') },
              { value: 'yearly', label: t('calendar.countdown.repeat.yearly') },
              { value: 'lunar', label: t('calendar.countdown.repeat.lunar') },
            ]}
          />
        </Field>
        <Field label={t('calendar.countdown.field.color')}>
          <div role="radiogroup" aria-label={t('calendar.countdown.field.color')} className="flex flex-wrap gap-1.5">
            <button
              type="button"
              role="radio"
              aria-checked={color === ''}
              aria-label={t('calendar.countdown.color_default')}
              onClick={() => setColor('')}
              className={cn(
                'size-6 rounded-full border border-[var(--border-default)] text-[length:var(--text-9)] text-[var(--text-quaternary)]',
                color === '' && 'ring-2 ring-[var(--accent)] ring-offset-1',
              )}
            >
              —
            </button>
            {CALENDAR_COLOR_PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={color === hex}
                aria-label={hex}
                onClick={() => setColor(hex)}
                className={cn('size-6 rounded-full', color === hex && 'ring-2 ring-[var(--accent)] ring-offset-1')}
                style={{ backgroundColor: hex }}
              />
            ))}
          </div>
        </Field>
        <Field label={t('calendar.countdown.field.note')}>
          <Textarea value={note} maxLength={MAX_COUNTDOWN_NOTE} rows={3} onChange={event => setNote(event.target.value)} />
        </Field>
        <Switch checked={pinned} onChange={setPinned} label={t('calendar.countdown.field.pinned')} />
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}

/** Loads the rows once per mount and again after any write; the surface owns the list. */
export function useCountdowns(onError: (error: string) => void) {
  const [items, setItems] = useState<CalendarCountdownDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setItems(await api.listCountdowns())
    } catch (cause) {
      const message = cause instanceof Error && cause.message ? cause.message : t('calendar.countdown.load_failed')
      setError(message)
      onError(message)
    } finally {
      setLoading(false)
    }
  }, [onError])

  return { items, loading, error, reload: load, setItems }
}
