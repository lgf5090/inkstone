import { useId, useState } from 'react'
import { AlertTriangle, ChevronDown, Settings2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import type { MessageKey } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button } from '../../components/primitives'
import { useAssistant } from './assistant-store'
import { diagnoseAssistantError } from './error-diagnosis'

/**
 * A failure the reader can act on: what happened, what to do, and the provider's own line behind a
 * disclosure rather than in place of the explanation.
 */
export function AssistantErrorCard({
  error,
  code,
  onRetry,
  retryLabel,
}: {
  error: string
  code?: string | null
  onRetry?: () => void
  retryLabel: MessageKey
}) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const diagnosis = diagnoseAssistantError(code, error)
  return (
    <div
      role="alert"
      className="flex max-w-[72ch] flex-col gap-1.5 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[var(--danger-soft)] px-2.5 py-2 text-[length:var(--text-12)] text-[var(--danger)]"
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t(diagnosis.title)}</p>
          <p className="mt-0.5 break-words text-[var(--text-secondary)]">
            {diagnosis.rawPrimary ? error : t(diagnosis.hint)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[19px]">
        {onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {t(retryLabel)}
          </Button>
        )}
        {diagnosis.settings && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Settings2 size={12} />}
            onClick={() => useAssistant.getState().setView('settings')}
          >
            {t('assistant.error.open_settings')}
          </Button>
        )}
        {!diagnosis.rawPrimary && (
          <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
        >
          {t('assistant.error.detail')}
          <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        )}
      </div>
      {open && !diagnosis.rawPrimary && (
        <p id={detailId} className="break-words pl-[19px] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {error}
        </p>
      )}
    </div>
  )
}
