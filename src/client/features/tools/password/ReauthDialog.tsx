import { useEffect, useState, type FormEvent } from 'react'
import { t } from '../../../lib/i18n'
import { Button, Spinner } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { PasswordApiError, passwordApi } from './api'

export interface ReauthDialogProps {
  open: boolean
  onClose: () => void
  onAuthorized: (token: string) => void
  description?: string
}

/**
 * The second factor for destructive actions: the server accepts wipe/restore/delete only with a
 * token minted from the master password seconds earlier, and this is where that token comes from.
 */
export function ReauthDialog({ open, onClose, onAuthorized, description }: ReauthDialogProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      // Never keep the master password in a component that stays mounted behind a closed modal.
      setPassword('')
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (submitting) return
    if (!password) {
      setError(t('tools.password.door.placeholder'))
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const { token } = await passwordApi.reauth(password)
      setPassword('')
      onAuthorized(token)
    } catch (err) {
      setError(
        err instanceof PasswordApiError && err.code === 'wrong_password'
          ? t('tools.password.door.fail')
          : err instanceof Error
            ? err.message
            : t('tools.password.door.fail'),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.password.reauth.title')}
      width={440}
      dismissible={!submitting}
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4 pt-1">
        <p className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]">
          {description ?? t('tools.password.reauth.description')}
        </p>

        <Input
          data-testid="reauth-password"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          autoFocus
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
            if (error) setError(null)
          }}
          placeholder={t('tools.password.door.placeholder')}
          aria-label={t('tools.password.reauth.title')}
          aria-invalid={Boolean(error)}
        />

        {error && (
          <div
            data-testid="reauth-error"
            role="alert"
            className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]"
          >
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="reauth-submit" type="submit" variant="primary" disabled={submitting}>
            {submitting ? <Spinner size={14} className="mr-1.5" /> : null}
            <span>{t('tools.password.reauth.submit')}</span>
          </Button>
        </div>
      </form>
    </Modal>
  )
}
