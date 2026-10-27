/**
 * The one-field dialog that names a new namespace, database or bucket.
 *
 * The parent owns the request and the success toast; this dialog owns the draft, the pending state and
 * the failure, so a rejected name stays on screen with its reason instead of closing over it.
 */
import { useEffect, useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Field, Input, commitOnEnter } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'

export function CreateNameDialog({
  open,
  title,
  label,
  placeholder,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  label: string
  placeholder?: string
  submitLabel: string
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName('')
    setError('')
    setSaving(false)
  }, [open])

  async function submit(): Promise<void> {
    const value = name.trim()
    if (!value || saving) return
    setSaving(true)
    setError('')
    try {
      await onSubmit(value)
      onClose()
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={440}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{uiT('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => { void submit() }}>
            {submitLabel}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={label}>
          <Input
            value={name}
            autoFocus
            placeholder={placeholder}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => commitOnEnter(event, () => { void submit() })}
          />
        </Field>
        {error && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
