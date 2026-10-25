import { useState, type FormEvent } from 'react'
import { AlertCircle } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useUi } from '../../../store/ui'
import { Button, Spinner } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { usePasswordVaultStore } from './store'
import { passwordApi } from './api'
import {
  decryptValue,
  encryptValue,
  evaluatePasswordStrength,
  getKeyIv,
  getRecoveryPass,
  hashMasterPassword,
  verifyMasterPasswordCandidate,
} from './crypto'

export interface ResetProps {
  open?: boolean
  onClose?: () => void
}

export function Reset({ open, onClose }: ResetProps) {
  const storeOpen = usePasswordVaultStore((s) => s.isResetOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeReset)
  const vaultState = usePasswordVaultStore((s) => s.vaultState)
  const masterPasswordText = usePasswordVaultStore((s) => s.masterPasswordText)
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const unlock = usePasswordVaultStore((s) => s.unlock)

  const isModalOpen = open !== undefined ? open : storeOpen
  const handleClose = onClose || storeClose

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const strength = evaluatePasswordStrength(newPassword)

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (submitting) return

    if (!oldPassword || oldPassword.length !== 6) {
      setError(t('tools.password.door.fail'))
      return
    }

    if (!newPassword || newPassword.length !== 6) {
      setError(t('tools.password.door.placeholder'))
      return
    }

    if (newPassword !== confirmPassword) {
      setError(t('tools.password.setting.mismatch'))
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      // 1. Validate old password
      let oldValid = false
      if (masterPasswordText) {
        oldValid = oldPassword === masterPasswordText
      } else {
        oldValid = await verifyMasterPasswordCandidate(oldPassword, vaultState, accounts)
      }

      if (!oldValid) {
        setError(t('tools.password.door.fail'))
        setSubmitting(false)
        return
      }

      // 2. Batch re-encrypt accounts
      const oldKeyIv = getKeyIv(oldPassword)
      const newKeyIv = getKeyIv(newPassword)

      let allAccounts = accounts
      if (!allAccounts || allAccounts.length === 0) {
        allAccounts = await passwordApi.getAccounts()
      }

      const reencrypted = allAccounts.map((acc) => {
        const tryDec = (val: string) => {
          if (!val) return ''
          try {
            return decryptValue(oldKeyIv, val)
          } catch {
            return val
          }
        }
        return {
          id: acc.id,
          title: encryptValue(newKeyIv, tryDec(acc.title)),
          username: encryptValue(newKeyIv, tryDec(acc.username)),
          password: encryptValue(newKeyIv, tryDec(acc.password)),
          link: encryptValue(newKeyIv, tryDec(acc.link)),
          remark: encryptValue(newKeyIv, tryDec(acc.remark)),
        }
      })

      // 3. Call API to reset master password and replace ciphertexts
      await passwordApi.resetMasterPassword({
        newMasterHash: hashMasterPassword(newPassword),
        newRecoveryHint: getRecoveryPass(newPassword.slice(0, 3)),
        accounts: reencrypted,
      })

      // 4. Update memory keys and unlock
      unlock(newKeyIv, false, newPassword)
      handleClose()

      useUi.getState().toast({
        title: t('tools.password.reset.title'),
        tone: 'success',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={isModalOpen}
      onClose={handleClose}
      title={t('tools.password.reset.title')}
      width={480}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 pt-1">
        <div>
          <label className="mb-1.5 block text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.password.reset.old_pass')}
          </label>
          <input
            data-testid="password-reset-old"
            type="password"
            maxLength={6}
            value={oldPassword}
            onChange={(e) => {
              setOldPassword(e.target.value.slice(0, 6))
              if (error) setError(null)
            }}
            placeholder={t('tools.password.reset.old_pass')}
            autoFocus
            className={cn(
              'block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-14)] text-[var(--text-primary)] tracking-widest',
              'placeholder:text-[var(--text-tertiary)] placeholder:tracking-normal',
              'focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
            )}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.password.reset.new_pass')}
          </label>
          <input
            data-testid="password-reset-new"
            type="password"
            maxLength={6}
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value.slice(0, 6))
              if (error) setError(null)
            }}
            placeholder={t('tools.password.reset.new_pass')}
            className={cn(
              'block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-14)] text-[var(--text-primary)] tracking-widest',
              'placeholder:text-[var(--text-tertiary)] placeholder:tracking-normal',
              'focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
            )}
          />
        </div>

        {/* Strength Indicator for New Password */}
        {newPassword.length > 0 && (
          <div data-testid="password-reset-strength" className="space-y-1.5">
            <div className="flex items-center justify-between text-[length:var(--text-12)]">
              <span className="text-[var(--text-tertiary)]">{t('tools.password.strength.new_label')}</span>
              <span
                className={cn(
                  'font-medium',
                  strength.score <= 1 && 'text-[var(--danger)]',
                  strength.score === 2 && 'text-[var(--warning)]',
                  strength.score >= 3 && 'text-[var(--accent)]',
                )}
              >
                {strength.label}
              </span>
            </div>
            <div className="flex h-1.5 w-full gap-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
              {[1, 2, 3, 4].map((step) => (
                <div
                  key={step}
                  className={cn(
                    'flex-1 transition-[background-color] duration-[var(--dur-fast)]',
                    step <= strength.score
                      ? strength.score <= 1
                        ? 'bg-[var(--danger)]'
                        : strength.score === 2
                        ? 'bg-[var(--warning)]'
                        : 'bg-[var(--accent)]'
                      : 'bg-[var(--border-subtle)]',
                  )}
                />
              ))}
            </div>
            {strength.warning && (
              <p className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--warning)]">
                <AlertCircle size={12} className="shrink-0" />
                <span>{strength.warning}</span>
              </p>
            )}
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.password.reset.confirm_new')}
          </label>
          <input
            data-testid="password-reset-confirm"
            type="password"
            maxLength={6}
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value.slice(0, 6))
              if (error) setError(null)
            }}
            placeholder={t('tools.password.reset.confirm_new')}
            className={cn(
              'block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-14)] text-[var(--text-primary)] tracking-widest',
              'placeholder:text-[var(--text-tertiary)] placeholder:tracking-normal',
              'focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
            )}
          />
        </div>

        {error && (
          <div
            data-testid="password-reset-error"
            role="alert"
            className="rounded-[var(--r-sm)] bg-[var(--danger-soft,rgba(239,68,68,0.1))] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]"
          >
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="password-reset-submit"
            variant="primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? <Spinner size={14} className="mr-1.5" /> : null}
            <span>{t('tools.password.reset.title')}</span>
          </Button>
        </div>
      </form>
    </Modal>
  )
}
