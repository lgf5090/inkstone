import { Copy, Download, FolderInput, Scissors, Share2, Trash2, X } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'

export interface SelectionBarProps {
  count: number
  totalBytes: number
  busy: boolean
  writable: boolean
  onDownload: () => void
  onShare: () => void
  onCopy: () => void
  onCut: () => void
  onMove: () => void
  onDelete: () => void
  onClear: () => void
}

export function SelectionBar({
  count,
  totalBytes,
  busy,
  writable,
  onDownload,
  onShare,
  onCopy,
  onCut,
  onMove,
  onDelete,
  onClear,
}: SelectionBarProps) {
  if (count === 0) return null
  return (
    <div role="toolbar" aria-label={t('clouddrive.selection.count', { count })} className="cd-selection-bar">
      <span className="mr-auto flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
        <span className="font-medium text-[var(--text-primary)]">{t('clouddrive.selection.count', { count })}</span>
        {totalBytes > 0 && <span className="tabular-nums">{t('clouddrive.status.selected_size', { size: formatBytes(totalBytes) })}</span>}
      </span>
      <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={onDownload}>
        {t('clouddrive.action.download')}
      </Button>
      <Button size="sm" variant="secondary" icon={<Share2 size={13} />} onClick={onShare} disabled={busy}>
        {t('clouddrive.action.share')}
      </Button>
      <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={onCopy} disabled={!writable || busy}>
        {t('clouddrive.action.copy')}
      </Button>
      <Button size="sm" variant="secondary" icon={<Scissors size={13} />} onClick={onCut} disabled={!writable || busy}>
        {t('clouddrive.action.cut')}
      </Button>
      <Button size="sm" variant="secondary" icon={<FolderInput size={13} />} onClick={onMove} disabled={!writable || busy}>
        {t('clouddrive.action.move')}
      </Button>
      <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={onDelete} disabled={!writable || busy} className="text-[var(--danger)]">
        {t('clouddrive.action.delete')}
      </Button>
      <IconButton label={t('clouddrive.action.clear_selection')} size="sm" onClick={onClear}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
