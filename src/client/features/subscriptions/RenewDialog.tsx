/**
 * Renewing by hand, with the date it will land on shown before it is saved.
 *
 * The preview is the point of the dialog: a reader choosing "two cycles" is really asking "when will I be
 * billed next", and making them save to find out is how a wrong renewal gets recorded. It runs the same
 * arithmetic the worker will — the cycle from the current expiry, or from the payment date in reset mode.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { formatAmount } from '@shared/subscriptions/format'
import { addLunarPeriod, lunar2solar, solar2lunar } from '@shared/subscriptions/lunar'
import { addCalendarPeriodInTimezone, formatDateInputInTimezone, getTimezoneDateParts, getTimestampForTimezoneParts } from '@shared/subscriptions/time'
import type { SubscriptionDetail } from '@shared/subscriptions/model'

export function RenewDialog({
  open,
  detail,
  timezone,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean
  detail: SubscriptionDetail
  timezone: string
  saving: boolean
  onClose: () => void
  onSubmit: (options: { paymentDate: string; amount: number; periodMultiplier: number; note: string }) => Promise<boolean>
}): ReactElement {
  const today = formatDateInputInTimezone(Date.now(), timezone)
  const [date, setDate] = useState(today)
  const [amount, setAmount] = useState(detail.item.amount === null ? '' : String(detail.item.amount))
  const [multiplier, setMultiplier] = useState('1')
  const [note, setNote] = useState('')

  const preview = useMemo(() => {
    const paidAt = Date.parse(`${date}T00:00:00Z`)
    const base = Number.isFinite(paidAt) ? paidAt : Date.now()
    const current = Date.parse(detail.item.expiryDate)
    const mode = detail.item.subscriptionMode
    const start = mode === 'reset' ? base : current > base ? current : base
    const cycles = Math.max(1, Math.trunc(Number(multiplier) || 1)) * detail.item.periodValue
    let next: number
    if (detail.item.useLunar) {
      const parts = getTimezoneDateParts(start, timezone)
      const lunar = solar2lunar(parts.year, parts.month, parts.day)
      const shifted = lunar ? addLunarPeriod(lunar, cycles, detail.item.periodUnit) : null
      const solar = shifted ? lunar2solar(shifted) : null
      next = solar ? getTimestampForTimezoneParts(solar, timezone) : start
    } else {
      next = addCalendarPeriodInTimezone(start, cycles, detail.item.periodUnit, timezone).getTime()
    }
    return formatDateInputInTimezone(next, timezone)
  }, [date, multiplier, detail.item, timezone])

  const submit = async (): Promise<void> => {
    const ok = await onSubmit({
      paymentDate: date,
      amount: amount === '' ? 0 : Number(amount),
      periodMultiplier: Math.max(1, Math.trunc(Number(multiplier) || 1)),
      note: note.trim(),
    })
    if (ok) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('subscriptions.renew.title', { name: detail.item.name })}
      width={460}
      bodyClassName="px-4 py-3"
      footer={(
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('subscriptions.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>{t('subscriptions.renew.confirm')}</Button>
        </div>
      )}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label={t('subscriptions.renew.date')}>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label={t('subscriptions.renew.amount')}>
            <Input type="number" min={0} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
        </div>
        <Field label={t('subscriptions.renew.periods')}>
          <Input type="number" min={1} max={120} value={multiplier} onChange={(event) => setMultiplier(event.target.value)} />
        </Field>
        <Field label={t('subscriptions.renew.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <div className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('subscriptions.renew.preview')}</p>
          <p className="mt-0.5 text-[length:var(--text-13)] font-medium tabular-nums text-[var(--text-primary)]">{preview}</p>
          <p className="mt-0.5 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
            {formatAmount(amount === '' ? 0 : Number(amount), detail.item.currency)}
          </p>
        </div>
      </div>
    </Modal>
  )
}
