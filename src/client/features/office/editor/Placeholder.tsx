import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'

export interface OfficeEditorPlaceholderProps {
  title: string
  /** The editor could not start; offers the one action that can help. */
  failed?: boolean
  /** Why it could not start, when the caller has a localized sentence for it. */
  detail?: string
  onRetry?: () => void
}

/** The empty surface an editor shows while its chunk, packages and snapshot are on their way. */
export function OfficeEditorPlaceholder({ title, failed = false, detail, onRetry }: OfficeEditorPlaceholderProps) {
  if (failed) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-[var(--bg-base)]">
        <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{t('office.editor.failed')}</p>
        <p className="max-w-[320px] truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]" title={detail ?? title}>
          {detail ?? title}
        </p>
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t('office.editor.retry')}
          </Button>
        )}
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1 bg-[var(--bg-base)] text-[var(--text-tertiary)]">
      <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{title}</p>
      <p className="text-[length:var(--text-12)]">{t('office.editor.loading')}</p>
    </div>
  )
}