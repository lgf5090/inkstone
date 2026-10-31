import { useCallback, useEffect, useState } from 'react'
import { Copy, RefreshCw, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { IconButton } from '../../../components/primitives'
import { Checkbox, Slider } from '../../../components/form'
import { Modal, Tooltip } from '../../../components/overlay'
import { PasswordStrengthIndicator } from './AccountForm'
import { usePasswordVaultStore } from './store'
import { copySecret } from './utils/clipboard'
import { DEFAULT_CUSTOM_SYMBOLS, generateRandomPassword } from './utils/generator'

/**
 * One generator for the whole module.
 *
 * The random-password page and the generator dialog used to carry separate implementations with
 * different character sets (25 versus 32 symbols) and different rules; this delegates to the shared
 * one so a password made in either place is made the same way.
 */
export function generatePassword(options: {
  length: number
  uppercase: boolean
  lowercase: boolean
  numbers: boolean
  symbols: boolean
}): string {
  return generateRandomPassword({
    length: options.length,
    uppercase: options.uppercase,
    lowercase: options.lowercase,
    numbers: options.numbers,
    symbols: options.symbols,
    customSymbols: DEFAULT_CUSTOM_SYMBOLS,
  })
}

export function Generator({ className }: { className?: string }) {
  const [length, setLength] = useState(16)
  const [uppercase, setUppercase] = useState(true)
  const [lowercase, setLowercase] = useState(true)
  const [numbers, setNumbers] = useState(true)
  const [symbols, setSymbols] = useState(true)
  const [generatedPassword, setGeneratedPassword] = useState('')

  const handleGenerate = useCallback(() => {
    const pwd = generatePassword({ length, uppercase, lowercase, numbers, symbols })
    setGeneratedPassword(pwd)
  }, [length, uppercase, lowercase, numbers, symbols])

  useEffect(() => {
    handleGenerate()
  }, [handleGenerate])

  const copyPassword = async () => {
    if (!generatedPassword) return
    try {
      await copySecret(generatedPassword)
      useUi.getState().toast({
        title: t('tools.password.account.copied'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({ title: t('tools.password.common.copy_failed'), tone: 'danger' })
    }
  }

  return (
    <div
      data-testid="password-generator-view"
      className={cn(
        'flex h-full min-h-0 flex-1 flex-col items-center justify-center p-6 bg-[var(--bg-base)]',
        className,
      )}
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <div className="flex size-9 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <Sparkles size={18} />
          </div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.password.generator.title')}
          </h2>
        </div>

        {/* Display generated password */}
        <div className="relative mb-4 flex items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
          <span
            className="font-mono text-[length:var(--text-15)] font-semibold tracking-wider text-[var(--text-primary)] break-all select-all mr-2"
            data-testid="generated-password-text"
          >
            {generatedPassword}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <Tooltip label={t('tools.password.generator.generate')}>
              <IconButton
                label={t('tools.password.generator.generate')}
                size="sm"
                variant="ghost"
                onClick={handleGenerate}
                data-testid="regenerate-btn"
              >
                <RefreshCw size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label={t('tools.password.generator.copy')}>
              <IconButton
                label={t('tools.password.generator.copy')}
                size="sm"
                variant="secondary"
                onClick={copyPassword}
                data-testid="copy-generated-btn"
              >
                <Copy size={14} />
              </IconButton>
            </Tooltip>
          </div>
        </div>

        <PasswordStrengthIndicator password={generatedPassword} />

        {/* Length Slider */}
        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            <span>{t('tools.password.generator.length')}</span>
            <span className="font-mono">{length}</span>
          </div>
          <Slider
            value={length}
            min={6}
            max={64}
            step={1}
            onChange={setLength}
            data-testid="length-slider"
          />
        </div>

        {/* Options */}
        <div className="mt-5 grid grid-cols-2 gap-3 text-[length:var(--text-12)]">
          <Checkbox
            checked={uppercase}
            onChange={setUppercase}
            label={t('tools.password.generator.uppercase')}
          />
          <Checkbox
            checked={lowercase}
            onChange={setLowercase}
            label={t('tools.password.generator.lowercase')}
          />
          <Checkbox
            checked={numbers}
            onChange={setNumbers}
            label={t('tools.password.generator.numbers')}
          />
          <Checkbox
            checked={symbols}
            onChange={setSymbols}
            label={t('tools.password.generator.symbols')}
          />
        </div>
      </div>
    </div>
  )
}

export function GeneratorModal() {
  const isGeneratorModalOpen = usePasswordVaultStore((s) => s.isGeneratorModalOpen)
  const closeGeneratorModal = usePasswordVaultStore((s) => s.closeGeneratorModal)

  return (
    <Modal
      open={isGeneratorModalOpen}
      onClose={closeGeneratorModal}
      title={t('tools.password.generator.title')}
      width={460}
    >
      <Generator className="p-0 bg-transparent" />
    </Modal>
  )
}
