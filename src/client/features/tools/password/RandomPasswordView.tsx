import { KeyRound } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { PasswordGeneratorForm } from './PasswordGeneratorModal'

export function RandomPasswordView() {
  return (
    <div
      data-testid="random-password-view"
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg-base)] p-6 md:p-10"
    >
      <div className="mx-auto w-full max-w-xl">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <KeyRound size={22} />
          </div>
          <div>
            <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
              {t('tools.password.generator.title')}
            </h1>
            <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('tools.password.generator.desc')}
            </p>
          </div>
        </div>

        {/* Card Container */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-sm">
          <PasswordGeneratorForm showApply={false} />
        </div>
      </div>
    </div>
  )
}
