import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { AlertCircle, KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Button, Spinner } from '../../../components/primitives'
import { usePasswordVaultStore } from './store'
import { getKeyIv, verifyMasterPasswordCandidate } from './crypto'

export interface DoorProps {
  className?: string
}

export function Door({ className }: DoorProps) {
  const [password, setPassword] = useState('')
  const [rememberLogin, setRememberLogin] = useState(false)
  const [isCapsLock, setIsCapsLock] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(false)
  const [loading, setLoading] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const vaultState = usePasswordVaultStore((s) => s.vaultState)
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const unlock = usePasswordVaultStore((s) => s.unlock)
  const openRecover = usePasswordVaultStore((s) => s.openRecover)
  const openReset = usePasswordVaultStore((s) => s.openReset)

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current)
    }
  }, [])

  const triggerFail = (msg: string) => {
    setError(msg)
    setShake(true)
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current)
    shakeTimerRef.current = setTimeout(() => {
      setShake(false)
    }, 500)
    inputRef.current?.select()
  }

  const handleSubmit = async () => {
    if (loading) return

    if (!password || password.length !== 6) {
      triggerFail(t('tools.password.door.placeholder'))
      return
    }

    setLoading(true)
    setError(null)

    try {
      const valid = await verifyMasterPasswordCandidate(password, vaultState, accounts)
      if (!valid) {
        triggerFail(t('tools.password.door.fail'))
        return
      }

      const keyiv = getKeyIv(password)
      unlock(keyiv, rememberLogin, password)
    } catch {
      triggerFail(t('tools.password.door.fail'))
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    setIsCapsLock(e.getModifierState('CapsLock'))
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const handleKeyUp = (e: KeyboardEvent<HTMLInputElement>) => {
    setIsCapsLock(e.getModifierState('CapsLock'))
  }

  return (
    <div
      data-testid="password-door"
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center p-4 bg-[var(--bg-base)]',
        className,
      )}
    >
      <div
        data-testid="password-door-card"
        className={cn(
          'w-full max-w-sm rounded-[var(--r-xl)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-6 shadow-lg',
          'transition-[box-shadow,border-color] duration-[var(--dur-base)]',
          shake && 'door-fail',
        )}
      >
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <KeyRound size={24} />
          </div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.password.door.title')}
          </h2>
          <p className="mt-1 flex items-center gap-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <ShieldCheck size={13} className="text-[var(--accent)]" />
            <span>{'Inkstone Zero-Knowledge Vault'}</span>
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[var(--text-tertiary)]">
              <Lock size={16} />
            </div>
            <input
              ref={inputRef}
              data-testid="password-door-input"
              type="password"
              inputMode="text"
              maxLength={6}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value.slice(0, 6))
                if (error) setError(null)
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              placeholder={t('tools.password.door.placeholder')}
              aria-label={t('tools.password.door.title')}
              aria-invalid={Boolean(error)}
              className={cn(
                'block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] py-2.5 pl-9 pr-3 text-[length:var(--text-14)] tracking-wider text-[var(--text-primary)]',
                'placeholder:text-[var(--text-tertiary)] placeholder:tracking-normal',
                'focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
                error && 'border-[var(--danger)] focus:border-[var(--danger)] focus:ring-[var(--danger)]',
              )}
            />
          </div>

          {/* CapsLock detection warning */}
          {isCapsLock && (
            <div
              data-testid="password-door-caps-lock"
              role="alert"
              className="flex items-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--warning-soft,rgba(234,179,8,0.1))] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--warning)]"
            >
              <AlertCircle size={14} className="shrink-0" />
              <span>{t('tools.password.door.caps_lock')}</span>
            </div>
          )}

          {/* Chinese IME composition warning */}
          {isComposing && (
            <div
              data-testid="password-door-ime-warn"
              role="alert"
              className="flex items-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--warning-soft,rgba(234,179,8,0.1))] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--warning)]"
            >
              <AlertCircle size={14} className="shrink-0" />
              <span>{t('tools.password.door.ime_warn')}</span>
            </div>
          )}

          {/* Validation error feedback */}
          {error && (
            <div
              data-testid="password-door-error"
              role="alert"
              className="text-center text-[length:var(--text-12)] font-medium text-[var(--danger)]"
            >
              {error}
            </div>
          )}

          {/* 24-hour remember login checkbox */}
          <label className="flex items-center gap-2 cursor-pointer select-none text-[length:var(--text-13)] text-[var(--text-secondary)]">
            <input
              data-testid="password-door-remember"
              type="checkbox"
              checked={rememberLogin}
              onChange={(e) => setRememberLogin(e.target.checked)}
              className="size-4 rounded border-[var(--border-subtle)] text-[var(--accent)] focus:ring-[var(--accent)]"
            />
            <span>{t('tools.password.door.remember_login')}</span>
          </label>

          <Button
            data-testid="password-door-submit"
            variant="primary"
            className="w-full justify-center"
            onClick={() => void handleSubmit()}
            disabled={loading}
          >
            {loading ? <Spinner size={16} /> : t('tools.password.door.title')}
          </Button>

          <div className="flex items-center justify-between pt-2 text-[length:var(--text-12)]">
            <button
              data-testid="password-door-forgot"
              type="button"
              onClick={openRecover}
              className="text-[var(--accent)] transition-colors hover:underline"
            >
              {t('tools.password.door.forgot')}
            </button>
            <button
              data-testid="password-door-modify"
              type="button"
              onClick={openReset}
              className="text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] hover:underline"
            >
              {t('tools.password.door.modify')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
