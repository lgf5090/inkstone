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
  encryptValue,
  evaluatePasswordStrength,
  getKeyIv,
  getRecoveryPass,
  hashMasterPassword,
} from './crypto'

export interface SettingProps {
  open?: boolean
  onClose?: () => void
}

export function Setting({ open, onClose }: SettingProps) {
  const storeOpen = usePasswordVaultStore((s) => s.isSettingOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeSetting)
  const vaultState = usePasswordVaultStore((s) => s.vaultState)
  const unlock = usePasswordVaultStore((s) => s.unlock)

  const isModalOpen = open !== undefined ? open : storeOpen
  const handleClose = onClose || storeClose

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const strength = evaluatePasswordStrength(password)

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (submitting) return

    if (!password || password.length !== 6) {
      setError(t('tools.password.door.placeholder'))
      return
    }

    if (password !== confirmPassword) {
      setError(t('tools.password.setting.mismatch'))
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const masterHash = hashMasterPassword(password)
      const recoveryHint = getRecoveryPass(password.slice(0, 3))

      // 1. Initialize vault
      await passwordApi.initVault(masterHash, recoveryHint)

      // 2. Create default group
      const defaultGroupName = t('tools.password.setting.default_group')
      const defaultGroup = await passwordApi.createGroup({ name: defaultGroupName })

      // 3. Create guided welcome account
      const keyiv = getKeyIv(password)
      const welcomeTitle = t('tools.password.setting.welcome_account_title')
      const welcomeUser = t('tools.password.setting.welcome_account_user')

      await passwordApi.createAccount({
        groupId: defaultGroup.id,
        title: encryptValue(keyiv, welcomeTitle),
        username: encryptValue(keyiv, welcomeUser),
        password: encryptValue(keyiv, password),
        link: encryptValue(keyiv, 'https://github.com/shuaiplus/inkstone'),
        remark: encryptValue(keyiv, 'Inkstone Password Vault'),
      })

      // 4. Close modal and unlock
      handleClose()
      unlock(keyiv, false, password)

      useUi.getState().toast({
        title: t('tools.password.setting.submit'),
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
      title={t('tools.password.setting.title')}
      description={t('tools.password.setting.desc')}
      width={480}
      dismissible={Boolean(vaultState?.hasVault)}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 pt-1">
        <div>
          <label className="mb-1.5 block text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.password.setting.input_label')}
          </label>
          <input
            data-testid="password-setting-input"
            type="password"
            maxLength={6}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value.slice(0, 6))
              if (error) setError(null)
            }}
            placeholder={t('tools.password.door.placeholder')}
            autoFocus
            className={cn(
              'block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-14)] text-[var(--text-primary)] tracking-widest',
              'placeholder:text-[var(--text-tertiary)] placeholder:tracking-normal',
              'focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
            )}
          />
        </div>

        {/* Password Strength Indicator */}
        {password.length > 0 && (
          <div data-testid="password-setting-strength" className="space-y-1.5">
            <div className="flex items-center justify-between text-[length:var(--text-12)]">
              <span className="text-[var(--text-tertiary)]">{t('tools.password.strength.label')}</span>
              <span
                data-testid="password-strength-label"
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
            {t('tools.password.setting.confirm_label')}
          </label>
          <input
            data-testid="password-setting-confirm"
            type="password"
            maxLength={6}
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value.slice(0, 6))
              if (error) setError(null)
            }}
            placeholder={t('tools.password.setting.confirm_label')}
            className={cn(
              'block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-14)] text-[var(--text-primary)] tracking-widest',
              'placeholder:text-[var(--text-tertiary)] placeholder:tracking-normal',
              'focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
            )}
          />
        </div>

        {error && (
          <div
            data-testid="password-setting-error"
            role="alert"
            className="rounded-[var(--r-sm)] bg-[var(--danger-soft,rgba(239,68,68,0.1))] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]"
          >
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          {Boolean(vaultState?.hasVault) && (
            <Button variant="ghost" onClick={handleClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
          )}
          <Button
            data-testid="password-setting-submit"
            variant="primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? <Spinner size={14} className="mr-1.5" /> : null}
            <span>{t('tools.password.setting.submit')}</span>
          </Button>
        </div>
      </form>
    </Modal>
  )
}
