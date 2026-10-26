import { useMemo, useState } from 'react'
import type { Event, ICalendarApp } from '@dayflow/react'
import { t, useLocale } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { Button } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { parseQuickAdd } from './quick-add'

interface CalendarQuickAddProps {
  open: boolean
  app: ICalendarApp
  timeZone: string
  onClose: () => void
}

export function CalendarQuickAdd({ open, app, timeZone, onClose }: CalendarQuickAddProps) {
  const locale = useLocale()
  const [text, setText] = useState('')
  const fallbackTitle = t('calendar.event.untitled')
  const parsed = useMemo(
    () => parseQuickAdd(text, new Date(), timeZone, fallbackTitle),
    [text, timeZone, fallbackTitle],
  )
  const preview = useMemo(() => {
    if (!parsed) return ''
    try {
      const date = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium', timeStyle: 'short', timeZone,
      }).format(new Date(parsed.start.epochMilliseconds))
      const end = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone })
        .format(new Date(parsed.end.epochMilliseconds))
      return `${parsed.title} · ${date} – ${end}`
    } catch {
      return parsed.title
    }
  }, [parsed, locale, timeZone])

  const submit = (): void => {
    if (!parsed) return
    const calendar = app.getCalendars().find(item => item.isDefault) ?? app.getCalendars()[0]
    if (!calendar) {
      useUi.getState().toast({ title: t('calendar.error.load'), tone: 'danger' })
      return
    }
    const event: Event = {
      id: crypto.randomUUID(),
      title: parsed.title,
      start: parsed.start,
      end: parsed.end,
      allDay: false,
      calendarId: calendar.id,
      calendarIds: [calendar.id],
      meta: {},
    }
    app.addEvent(event)
    useUi.getState().toast({ title: t('calendar.quick_add.added'), tone: 'success' })
    setText('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.quick_add.title')}
      description={t('calendar.quick_add.description')}
      width={460}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!parsed} onClick={submit}>{t('calendar.quick_add.add')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('calendar.quick_add.input')}>
          <Input
            data-autofocus
            value={text}
            placeholder={t('calendar.quick_add.placeholder')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
        </Field>
        <p className={`min-h-5 text-[length:var(--text-12)] ${parsed ? 'text-[var(--text-secondary)]' : 'text-[var(--text-quaternary)]'}`}>
          {parsed ? preview : t('calendar.quick_add.hint')}
        </p>
      </div>
    </Modal>
  )
}
