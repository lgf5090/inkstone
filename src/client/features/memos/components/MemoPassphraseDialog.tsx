import { useEffect, useId, useState, type FormEvent, type ReactElement } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { t, type MessageKey } from '../../../lib/i18n'

export type MemoCipherMode = 'seal' | 'open' | 'unseal'

const TITLE_KEYS: Record<MemoCipherMode, MessageKey> = {
  seal: 'memos.cipher.seal_title',
  open: 'memos.cipher.open_title',
  unseal: 'memos.cipher.unseal_title',
}

const DESCRIPTION_KEYS: Record<MemoCipherMode, MessageKey> = {
  seal: 'memos.cipher.seal_description',
  open: 'memos.cipher.open_description',
  unseal: 'memos.cipher.unseal_description',
}

const CONFIRM_KEYS: Record<MemoCipherMode, MessageKey> = {
  seal: 'memos.cipher.seal_confirm',
  open: 'memos.cipher.open_confirm',
  unseal: 'memos.cipher.unseal_confirm',
}

export interface MemoPassphraseDialogProps {
  open: boolean
  mode: MemoCipherMode
  defaultPassphrase?: string
  onClose: () => void
  onSubmit: (passphrase: string) => Promise<void>
}

export function MemoPassphraseDialog({
  open,
  mode,
  defaultPassphrase = '',
  onClose,
  onSubmit,
}: MemoPassphraseDialogProps): ReactElement {
  const fieldId = useId()
  const [passphrase, setPassphrase] = useState(defaultPassphrase)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPassphrase(defaultPassphrase)
    setBusy(false)
    setError(null)
  }, [open, defaultPassphrase, mode])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const value = passphrase.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
      onClose()
    } catch (failure) {
      const raw = failure instanceof Error ? failure.message : ''
      const message = raw === 'The passphrase did not open this memo'
        ? t('memos.cipher.wrong_passphrase')
        : raw.includes('does not carry a readable sealed body')
          ? t('memos.cipher.broken')
          : raw || t('memos.cipher.failed')
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(TITLE_KEYS[mode])}
      description={t(DESCRIPTION_KEYS[mode])}
      width={460}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('memos.common.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={fieldId}
            loading={busy}
            disabled={!passphrase.trim()}
            icon={<ShieldCheck size={13} />}
          >
            {t(CONFIRM_KEYS[mode])}
          </Button>
        </div>
      )}
    >
      <form id={fieldId} onSubmit={(event) => void submit(event)} className="space-y-3 pt-1">
        <Field label={t('memos.cipher.passphrase_label')} hint={t('memos.cipher.passphrase_hint')}>
          <Input
            id={`${fieldId}-passphrase`}
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            aria-invalid={error !== null}
          />
        </Field>
        <p className="rounded-[var(--r-sm)] bg-[var(--bg-raised)] px-2.5 py-2 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
          {t('memos.cipher.security_note')}
        </p>
        {error ? (
          <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>
        ) : null}
      </form>
    </Modal>
  )
}
