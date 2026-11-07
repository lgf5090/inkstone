import { SquareTerminal } from 'lucide-react'
import { t } from '../../lib/i18n'

export function WebsshReplayPage({ slug: _slug }: { slug: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] p-6">
      <div className="w-full max-w-[440px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
        <div className="flex items-center gap-2">
          <SquareTerminal size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <h1 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('webssh.app.title')}
          </h1>
        </div>
        <p className="mt-2 text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t('webssh.replay.missing')}
        </p>
      </div>
    </div>
  )
}
