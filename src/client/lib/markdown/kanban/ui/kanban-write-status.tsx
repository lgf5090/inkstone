import { RotateCcw, RotateCw } from 'lucide-react'
import { t } from '../../../i18n'

interface KanbanWriteStatusProps {
  unsaved?: boolean
  onRetry?: () => void
  onDiscard?: () => void
}

export function KanbanWriteStatus({ unsaved, onRetry, onDiscard }: KanbanWriteStatusProps) {
  if (!unsaved || !onRetry) return null
  // The chip joins the height of the row it sits in on a phone, so its two buttons — the only
  // actions in the header that are easy to miss while they are needed — get a finger's target.
  return (
    <span
      data-kanban-write-status
      role='status'
      className='inline-flex h-[var(--sp-9)] items-center gap-[var(--sp-1)] rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-[var(--sp-2)] text-[length:var(--text-12)] text-[var(--text-secondary)] md:h-auto md:py-[var(--sp-1)]'
    >
      <span>{t('preview.kanban_unsaved')}</span>
      <button
        type='button'
        onClick={onRetry}
        className='inline-flex size-9 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] md:size-5'
        aria-label={t('common.retry')}
        title={t('common.retry')}
      >
        <RotateCw size={12} aria-hidden />
      </button>
      {onDiscard && (
        <button
          type='button'
          onClick={onDiscard}
          className='inline-flex size-9 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] md:size-5'
          aria-label={t('preview.kanban_discard_changes')}
          title={t('preview.kanban_discard_changes')}
        >
          <RotateCcw size={12} aria-hidden />
        </button>
      )}
    </span>
  )
}
