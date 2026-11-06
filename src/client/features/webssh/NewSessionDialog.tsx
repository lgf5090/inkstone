import { useEffect, useState } from 'react'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Input, Field } from '../../components/form'
import { t } from '../../lib/i18n'

/**
 * W3 owns the host and credential library. Until it lands this dialog only names a demo session,
 * and the description says exactly that — no host, port or password field is shown, so nothing here
 * can be mistaken for a real connection form.
 */
export function NewSessionDialog({
  open,
  onClose,
  onCreate,
  defaultName,
}: {
  open: boolean
  onClose: () => void
  onCreate: (name: string) => void
  defaultName: string
}) {
  const [name, setName] = useState(defaultName)
  useEffect(() => {
    if (open) setName(defaultName)
  }, [open, defaultName])
  const trimmed = name.trim()
  const submit = () => {
    if (!trimmed) return
    onCreate(trimmed)
    setName('')
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.session.dialog_title')}
      description={t('webssh.session.dialog_description')}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={!trimmed}>
            {t('webssh.session.create')}
          </Button>
        </>
      }
    >
      <Field label={t('webssh.session.label')}>
        <Input
          value={name}
          autoFocus
          placeholder={t('webssh.session.label_placeholder')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
      </Field>
    </Modal>
  )
}
