import { useState, useEffect, useCallback } from 'react'
import { Copy, Check, RefreshCw, AlertTriangle } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Input, Checkbox } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import {
  generateRandomPassword,
  DEFAULT_CUSTOM_SYMBOLS,
} from './utils/generator'
import { evaluatePasswordStrength, type PasswordStrengthResult } from './crypto/strength'

export interface PasswordGeneratorFormProps {
  onApply?: (password: string) => void
  onClose?: () => void
  showApply?: boolean
}

export function PasswordGeneratorForm({
  onApply,
  onClose,
  showApply = false,
}: PasswordGeneratorFormProps) {
  const toast = useUi((s) => s.toast)
  const [length, setLength] = useState<number>(16)
  const [uppercase, setUppercase] = useState<boolean>(true)
  const [lowercase, setLowercase] = useState<boolean>(true)
  const [numbers, setNumbers] = useState<boolean>(true)
  const [symbols, setSymbols] = useState<boolean>(true)
  const [customSymbols, setCustomSymbols] = useState<string>(DEFAULT_CUSTOM_SYMBOLS)

  const [password, setPassword] = useState<string>('')
  const [copied, setCopied] = useState<boolean>(false)

  const isCharsetValid = uppercase || lowercase || numbers || (symbols && customSymbols.length > 0)

  const handleGenerate = useCallback(() => {
    if (!isCharsetValid) {
      setPassword('')
      return
    }
    const pwd = generateRandomPassword({
      length,
      uppercase,
      lowercase,
      numbers,
      symbols,
      customSymbols,
    })
    setPassword(pwd)
  }, [length, uppercase, lowercase, numbers, symbols, customSymbols, isCharsetValid])

  useEffect(() => {
    handleGenerate()
  }, [handleGenerate])

  const strength: PasswordStrengthResult = evaluatePasswordStrength(password)

  const handleCopy = async () => {
    if (!password) return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(password)
      }
      setCopied(true)
      toast({ title: t('tools.password.account.copied'), tone: 'success' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ title: t('tools.password.account.copied'), tone: 'success' })
    }
  }

  const handleApply = () => {
    if (onApply && password) {
      onApply(password)
      onClose?.()
    }
  }

  const getStrengthBarColor = (score: number) => {
    switch (score) {
      case 0:
        return 'bg-red-500'
      case 1:
        return 'bg-orange-500'
      case 2:
        return 'bg-amber-500'
      case 3:
        return 'bg-blue-500'
      case 4:
        return 'bg-emerald-500'
      default:
        return 'bg-zinc-300 dark:bg-zinc-700'
    }
  }

  return (
    <div className="flex flex-col gap-5 text-[var(--text-primary)]">
      {/* Generated Password Box */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] p-3">
          <span
            data-testid="generated-password-output"
            className="flex-1 font-mono text-[length:var(--text-15)] font-semibold tracking-wide break-all select-all text-[var(--text-primary)]"
          >
            {password || (
              <span className="text-[var(--text-quaternary)] italic">
                {t('tools.password.generator.title')}
              </span>
            )}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={handleGenerate}
              title={t('tools.password.generator.generate')}
              aria-label={t('tools.password.generator.generate')}
            />
            <Button
              type="button"
              variant={copied ? 'subtle' : 'secondary'}
              size="sm"
              icon={copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              onClick={handleCopy}
              title={t('tools.password.generator.copy')}
              aria-label={t('tools.password.generator.copy')}
            >
              {copied ? t('tools.password.common.copied') : t('tools.password.generator.copy')}
            </Button>
          </div>
        </div>

        {/* Strength Meter Bar */}
        {password ? (
          <div className="flex flex-col gap-1 px-1">
            <div className="flex items-center justify-between text-[length:var(--text-12)]">
              <span className="text-[var(--text-secondary)]">
                {t('tools.password.strength.label')}
              </span>
              <span className="font-medium text-[var(--text-primary)]">{strength.label}</span>
            </div>
            <div className="flex h-1.5 w-full gap-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
              {[0, 1, 2, 3].map((step) => (
                <div
                  key={step}
                  className={`h-full flex-1 transition-all duration-200 ${
                    step <= strength.score ? getStrengthBarColor(strength.score) : 'bg-transparent'
                  }`}
                />
              ))}
            </div>
            {strength.warning && (
              <p className="mt-0.5 text-[length:var(--text-11)] text-amber-500">
                {strength.warning}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {!isCharsetValid && (
        <div className="flex items-center gap-2 rounded-[var(--r-md)] bg-red-500/10 p-2.5 text-[length:var(--text-12)] text-red-500">
          <AlertTriangle size={16} />
          <span>{t('tools.password.generator.at_least_one_type')}</span>
        </div>
      )}

      {/* Password Length Control */}
      <div className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5">
        <div className="flex items-center justify-between">
          <label
            htmlFor="password-length-slider"
            className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]"
          >
            {t('tools.password.generator.length')}
          </label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={256}
              value={length}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val)) {
                  setLength(Math.max(1, Math.min(256, val)))
                }
              }}
              className="h-7 w-16 text-center font-mono text-[length:var(--text-12)]"
              aria-label={t('tools.password.generator.length')}
            />
            <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.password.common.digits')}</span>
          </div>
        </div>
        <input
          id="password-length-slider"
          type="range"
          min={1}
          max={256}
          value={length}
          onChange={(e) => setLength(parseInt(e.target.value, 10))}
          className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--border-default)] accent-[var(--accent)]"
          aria-label={t('tools.password.generator.length')}
        />
        <div className="flex justify-between text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          <span>{1}</span>
          <span>{16}</span>
          <span>{32}</span>
          <span>{64}</span>
          <span>{128}</span>
          <span>{256}</span>
        </div>
      </div>

      {/* Character Type Options */}
      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2.5 cursor-pointer rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5 text-[length:var(--text-13)] hover:bg-[var(--bg-hover)]">
          <Checkbox checked={uppercase} onChange={setUppercase} />
          <span>{t('tools.password.generator.uppercase')}</span>
        </label>
        <label className="flex items-center gap-2.5 cursor-pointer rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5 text-[length:var(--text-13)] hover:bg-[var(--bg-hover)]">
          <Checkbox checked={lowercase} onChange={setLowercase} />
          <span>{t('tools.password.generator.lowercase')}</span>
        </label>
        <label className="flex items-center gap-2.5 cursor-pointer rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5 text-[length:var(--text-13)] hover:bg-[var(--bg-hover)]">
          <Checkbox checked={numbers} onChange={setNumbers} />
          <span>{t('tools.password.generator.numbers')}</span>
        </label>
        <label className="flex items-center gap-2.5 cursor-pointer rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5 text-[length:var(--text-13)] hover:bg-[var(--bg-hover)]">
          <Checkbox checked={symbols} onChange={setSymbols} />
          <span>{t('tools.password.generator.symbols')}</span>
        </label>
      </div>

      {/* Custom Symbols Input */}
      {symbols && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="custom-symbols-input"
            className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]"
          >
            {t('tools.password.generator.special_chars')}
          </label>
          <Input
            id="custom-symbols-input"
            value={customSymbols}
            onChange={(e) => setCustomSymbols(e.target.value)}
            placeholder={DEFAULT_CUSTOM_SYMBOLS}
            className="font-mono text-[length:var(--text-12)]"
            invalid={customSymbols.length === 0}
          />
          {customSymbols.length === 0 && (
            <span className="text-[length:var(--text-11)] text-red-500">
              {t('tools.password.generator.symbols_empty')}
            </span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="secondary"
          icon={<RefreshCw size={14} />}
          onClick={handleGenerate}
        >
          {t('tools.password.generator.generate')}
        </Button>
        {showApply && onApply && (
          <Button
            type="button"
            variant="primary"
            onClick={handleApply}
            disabled={!password || !isCharsetValid}
          >
            {t('tools.password.generator.apply')}
          </Button>
        )}
      </div>
    </div>
  )
}

export interface PasswordGeneratorModalProps {
  open?: boolean
  onClose?: () => void
  onApply?: (password: string) => void
}

export function PasswordGeneratorModal({
  open,
  onClose,
  onApply,
}: PasswordGeneratorModalProps) {
  const storeIsOpen = usePasswordVaultStore((s) => s.isGeneratorModalOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeGeneratorModal)

  const isVisible = open !== undefined ? open : storeIsOpen
  const handleClose = onClose || storeClose

  return (
    <Modal
      open={isVisible}
      onClose={handleClose}
      title={t('tools.password.generator.title')}
      width={520}
    >
      <PasswordGeneratorForm
        onApply={onApply}
        onClose={handleClose}
        showApply={Boolean(onApply)}
      />
    </Modal>
  )
}
