import { useState, type FormEvent } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useUi } from '../../../store/ui'
import { Button, Spinner } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { usePasswordVaultStore } from './store'
import {
  getKeyIv,
  getOriginalPasswordPlus,
  verifyMasterPasswordCandidate,
} from './crypto'

export interface RecoverProps {
  open?: boolean
  onClose?: () => void
}

export function Recover({ open, onClose }: RecoverProps) {
  const storeOpen = usePasswordVaultStore((s) => s.isRecoverOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeRecover)
  const vaultState = usePasswordVaultStore((s) => s.vaultState)
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const unlock = usePasswordVaultStore((s) => s.unlock)

  const isModalOpen = open !== undefined ? open : storeOpen
  const handleClose = onClose || storeClose

  const [suffix, setSuffix] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)

  const hint = vaultState?.recoveryHint
    ? getOriginalPasswordPlus(vaultState.recoveryHint)
    : ''

  const handleVerify = async (e?: FormEvent) => {
    e?.preventDefault()
    if (verifying) return

    if (!suffix || suffix.length !== 3) {
      setError(t('tools.password.recover.input_tail_3'))
      return
    }

    setVerifying(true)
    setError(null)

    try {
      const fullPassword = hint + suffix
      const valid = await verifyMasterPasswordCandidate(fullPassword, vaultState, accounts)

      if (!valid) {
        setError(t('tools.password.door.fail'))
        setVerifying(false)
        return
      }

      const keyiv = getKeyIv(fullPassword)
      unlock(keyiv, false, fullPassword)
      handleClose()

      useUi.getState().toast({
        title: t('tools.password.recover.verify'),
        tone: 'success',
      })
    } catch {
      setError(t('tools.password.door.fail'))
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Modal
      open={isModalOpen}
      onClose={handleClose}
      title={t('tools.password.recover.title')}
      width={460}
    >
      <form onSubmit={(e) => void handleVerify(e)} className="space-y-4 pt-1">
        <div className="flex items-start gap-3 rounded-[var(--r-md)] bg-[var(--accent-soft)] p-3 text-[var(--accent)]">
          <KeyRound size={20} className="shrink-0 mt-0.5" />
          <p
            data-testid="password-recover-hint-text"
            className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-primary)]"
          >
            {t('tools.password.recover.hint', { hint: hint || '***' })}
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.password.recover.tail_3_label')}
          </label>
          <div className="flex items-center gap-2">
            <div
              data-testid="password-recover-prefix-badge"
              className="flex h-10 w-24 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] font-mono text-[length:var(--text-15)] font-semibold text-[var(--text-secondary)] tracking-widest"
            >
              {hint || '***'}
            </div>
            <span className="text-[var(--text-tertiary)] font-bold">+</span>
            <input
              data-testid="password-recover-suffix-input"
              type="password"
              maxLength={3}
              value={suffix}
              onChange={(e) => {
                setSuffix(e.target.value.slice(0, 3))
                if (error) setError(null)
              }}
              placeholder={t('tools.password.recover.tail_3_placeholder')}
              autoFocus
              className={cn(
                'block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-14)] text-[var(--text-primary)] font-mono tracking-widest',
                'placeholder:text-[var(--text-tertiary)] placeholder:font-sans placeholder:tracking-normal',
                'focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
              )}
            />
          </div>
        </div>

        {error && (
          <div
            data-testid="password-recover-error"
            role="alert"
            className="flex items-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--danger-soft,rgba(239,68,68,0.1))] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]"
          >
            <ShieldAlert size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={verifying}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="password-recover-submit"
            variant="primary"
            type="submit"
            disabled={verifying}
          >
            {verifying ? <Spinner size={14} className="mr-1.5" /> : null}
            <span>{t('tools.password.recover.verify')}</span>
          </Button>
        </div>
      </form>
    </Modal>
  )
}
