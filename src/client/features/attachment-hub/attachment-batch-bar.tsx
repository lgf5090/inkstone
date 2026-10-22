import { Download, FolderClosed, Star, Trash2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import { Button, IconButton } from '../../components/primitives'
import { t } from '../../lib/i18n'

interface AttachmentBatchBarProps {
  selectedCount: number
  onClearSelection: () => void
  onBatchDownload: () => void
  onBatchMove: () => void
  onBatchStar: () => void
  onBatchDelete: () => void
}

export function AttachmentBatchBar(props: AttachmentBatchBarProps) {
  const { selectedCount, onClearSelection, onBatchDownload, onBatchMove, onBatchStar, onBatchDelete } = props
  if (selectedCount === 0) return null

  const buttons: { key: MessageKey; icon: ReactNode; variant: 'secondary' | 'danger'; onClick: () => void }[] = [
    { key: 'common.download', icon: <Download size={13} />, variant: 'secondary', onClick: onBatchDownload },
    { key: 'attachments.batch_move', icon: <FolderClosed size={13} />, variant: 'secondary', onClick: onBatchMove },
    { key: 'attachments.star', icon: <Star size={13} />, variant: 'secondary', onClick: onBatchStar },
    { key: 'common.delete', icon: <Trash2 size={13} />, variant: 'danger', onClick: onBatchDelete },
  ]

  return (
    <div className='anim-pop absolute bottom-[var(--sp-4)] left-1/2 z-[var(--z-float)] flex -translate-x-1/2 items-center gap-[var(--sp-2)] rounded-[var(--r-xl)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-[var(--sp-4)] py-[var(--sp-2)] shadow-[var(--shadow-modal)]'>
      <div className='flex items-center gap-[var(--sp-2)] border-r border-[var(--border-subtle)] pr-[var(--sp-3)]'>
        <span className='text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]'>
          {t('attachments.selected_count', { value0: selectedCount })}
        </span>
        <IconButton label={t('common.clear')} size='sm' onClick={onClearSelection}>
          <X size={13} />
        </IconButton>
      </div>
      <div className='flex items-center gap-[var(--sp-1-5)]'>
        {buttons.map((button) => (
          <Button key={button.key} size='sm' variant={button.variant} icon={button.icon} onClick={button.onClick}>
            {t(button.key)}
          </Button>
        ))}
      </div>
    </div>
  )
}
