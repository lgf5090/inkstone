import { KeyRound, ShieldCheck } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { useToolsStore } from '../store'

export function PasswordApp() {
  const activePasswordView = useToolsStore((s) => s.activePasswordView)

  return (
    <div
      data-testid="password-app-root"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <KeyRound size={28} />
        </div>
        <h2 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('tools.password.module_name')}
        </h2>
        <p className="mt-2 max-w-md text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t(`tools.password.nav.${activePasswordView}` as any)}
        </p>
        <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <ShieldCheck size={14} className="text-[var(--accent)]" />
          <span>E2E Encrypted Vault</span>
        </div>
      </div>
    </div>
  )
}
