import { ArrowUpRight, Copy, CornerDownRight, Trash2 } from 'lucide-react'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { t } from '../../../i18n'
import { useUi } from '../../../../store/ui'
import type { KanbanSubtask } from '../types'

const SUBTASK_MENU_WIDTH = 176

interface KanbanSubtaskMenuProps {
  open: boolean
  panelId: string
  subtask: KanbanSubtask
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onDuplicate: () => void
  onConvertToItem?: () => void
  onDelete: () => void
}

function copySubtaskName(subtask: KanbanSubtask): void {
  const fail = () => useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
  if (!navigator.clipboard?.writeText) {
    fail()
  } else {
    navigator.clipboard
      .writeText(subtask.title)
      .then(() => useUi.getState().toast({ title: t('common.copied'), tone: 'success' }))
      .catch(fail)
  }
}

// `Menu` closes after an item runs, so a row here only says what it does.
function kanbanSubtaskMenuItems({
  subtask,
  onDuplicate,
  onConvertToItem,
  onDelete,
}: Pick<KanbanSubtaskMenuProps, 'subtask' | 'onDuplicate' | 'onConvertToItem' | 'onDelete'>): MenuItem[] {
  return [
    { id: 'duplicate', label: t('preview.kanban_duplicate_subitem'), icon: <Copy size={14} />, onSelect: onDuplicate },
    { id: 'copy-name', label: t('preview.kanban_copy_subitem_name'), icon: <CornerDownRight size={14} />, onSelect: () => copySubtaskName(subtask) },
    ...(onConvertToItem
      ? [{ id: 'convert', label: t('preview.kanban_convert_to_item'), icon: <ArrowUpRight size={14} />, onSelect: onConvertToItem }]
      : []),
    { id: 'delete', label: t('preview.kanban_delete_subitem'), icon: <Trash2 size={14} />, tone: 'danger', separatorBefore: true, onSelect: onDelete },
  ]
}

export function KanbanSubtaskMenu({
  open,
  panelId,
  subtask,
  anchorRef,
  onClose,
  onDuplicate,
  onConvertToItem,
  onDelete,
}: KanbanSubtaskMenuProps) {
  return (
    <Menu
      open={open}
      anchor={anchorRef}
      onClose={onClose}
      panelId={panelId}
      align='end'
      width={SUBTASK_MENU_WIDTH}
      label={t('common.more_actions')}
      items={kanbanSubtaskMenuItems({ subtask, onDuplicate, onConvertToItem, onDelete })}
    />
  )
}
