/**
 * Correcting one receipt.
 *
 * Only the four fields a receipt actually carries are editable. The period it bought is not one of them:
 * moving a receipt's dates would silently move the subscription's expiry with it, and a reader fixing a
 * typo in an amount should not have to reason about that.
 */
import { useState, type ReactElement } from 'react'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { formatDateInputInTimezone } from '@shared/subscriptions/time'
import type { PaymentRecord } from '@shared/subscriptions/model'

export function PaymentDialog({
  payment,
  timezone,
  saving,
  onClose,
  onSubmit,
}: {
  payment: PaymentRecord
  timezone: string
  saving: boolean
  onClose: () => void
  onSubmit: (patch: { date: string; amount: number; note: string }) => Promise<boolean>
}): ReactElement {
  const [date, setDate] = useState(formatDateInputInTimezone(payment.paidAt, timezone))
  const [amount, setAmount] = useState(String(payment.amount))
  const [note, setNote] = useState(payment.note)

  const submit = async (): Promise<void> => {
    const ok = await onSubmit({
      date,
      amount: amount === '' ? 0 : Number(amount),
      note: note.trim(),
    })
    if (ok) onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('subscriptions.payments.edit')}
      width={420}
      bodyClassName="px-4 py-3"
      footer={(
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('subscriptions.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>{t('subscriptions.save')}</Button>
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
        <Field label={t('subscriptions.renew.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
