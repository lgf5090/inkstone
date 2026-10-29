import { useEffect, useMemo } from 'react'
import {
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FolderInput,
  FolderOpen,
  ListChecks,
  Palette,
  Pencil,
  Scissors,
  Share2,
  Tags,
  Trash2,
} from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { Menu, useContextMenu, type MenuItem } from '../../../components/overlay'
import { FolderColorMenu, TagEditorMenu } from './ColorTagMenus'

export interface ContextMenuTarget {
  entry: CloudDriveEntry
  point: { x: number; y: number }
}

export interface ContextMenuProps {
  target: ContextMenuTarget | null
  /** The current selection the action applies to; the right-clicked entry is included. */
  targets: CloudDriveEntry[]
  readOnly: boolean
  showCheckboxes: boolean
  canPaste: boolean
  busy: boolean
  onClose: () => void
  onOpen: (entry: CloudDriveEntry) => void
  onPreview: (entry: CloudDriveEntry) => void
  onDownload: (entries: CloudDriveEntry[]) => void
  onShare: (entries: CloudDriveEntry[]) => void
  onCopy: (entries: CloudDriveEntry[]) => void
  onCut: (entries: CloudDriveEntry[]) => void
  onPaste: () => void
  onRename: (entry: CloudDriveEntry) => void
  onMove: (entries: CloudDriveEntry[]) => void
  onDelete: (entries: CloudDriveEntry[]) => void
  onColor: (entry: CloudDriveEntry, color: string | null) => void
  onAddTag: (entry: CloudDriveEntry, tag: string, color: string) => void
  onRemoveTag: (entry: CloudDriveEntry, tag: string) => void
  onToggleCheckboxes: () => void
}

export function ContextMenu({
  target,
  targets,
  readOnly,
  showCheckboxes,
  canPaste,
  busy,
  onClose,
  onOpen,
  onPreview,
  onDownload,
  onShare,
  onCopy,
  onCut,
  onPaste,
  onRename,
  onMove,
  onDelete,
  onColor,
  onAddTag,
  onRemoveTag,
  onToggleCheckboxes,
}: ContextMenuProps) {
  const menu = useContextMenu()

  const pointX = target?.point.x
  const pointY = target?.point.y
  const pointKey = target === null ? 'closed' : `${pointX}:${pointY}`
  useEffect(() => {
    if (target) menu.openAt(target.point)
    else menu.close()
    // The menu is repositioned for a new point, not for a row whose tags just changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointKey])

  const entry = target?.entry ?? null
  const writable = !readOnly && targets.every((item) => !item.readOnly) && targets.length > 0
  const metadataWritable = writable && targets.every((item) => item.storageKind !== 'external')
  const copyable = writable && targets.every((item) => item.storageKind !== 'external')
  const single = targets.length === 1 && entry !== null
  const isFolder = entry?.kind === 'folder'

  const items = useMemo<MenuItem[]>(() => {
    if (!entry) return []
    const rows: MenuItem[] = [
      {
        id: 'open',
        label: isFolder ? t('clouddrive.action.open') : t('clouddrive.action.preview'),
        icon: isFolder ? <FolderOpen size={14} /> : <Eye size={14} />,
        onSelect: () => (isFolder ? onOpen(entry) : onPreview(entry)),
      },
      {
        id: 'download',
        label: isFolder ? t('clouddrive.action.download_zip') : t('clouddrive.action.download'),
        icon: <Download size={14} />,
        onSelect: () => onDownload(targets),
      },
      {
        id: 'share',
        label: t('clouddrive.action.share'),
        icon: <Share2 size={14} />,
        onSelect: () => onShare(targets),
      },
      {
        id: 'copy',
        label: t('clouddrive.action.copy'),
        icon: <Copy size={14} />,
        disabled: !copyable,
        separatorBefore: true,
        onSelect: () => onCopy(targets),
      },
      {
        id: 'cut',
        label: t('clouddrive.action.cut'),
        icon: <Scissors size={14} />,
        disabled: !writable,
        onSelect: () => onCut(targets),
      },
      {
        id: 'paste',
        label: t('clouddrive.action.paste'),
        icon: <ClipboardPaste size={14} />,
        disabled: !writable || !canPaste,
        onSelect: onPaste,
      },
      {
        id: 'rename',
        label: t('clouddrive.action.rename'),
        icon: <Pencil size={14} />,
        disabled: !writable || !single,
        separatorBefore: true,
        onSelect: () => onRename(entry),
      },
      {
        id: 'move',
        label: t('clouddrive.action.move'),
        icon: <FolderInput size={14} />,
        disabled: !writable,
        onSelect: () => onMove(targets),
      },
      {
        id: 'delete',
        label: t('clouddrive.action.delete'),
        icon: <Trash2 size={14} />,
        tone: 'danger',
        disabled: !writable || busy,
        onSelect: () => onDelete(targets),
      },
      {
        id: 'color',
        label: t('clouddrive.action.color'),
        icon: <Palette size={14} />,
        disabled: !metadataWritable || !single || !isFolder,
        separatorBefore: true,
        submenu: ({ closeMenu }) => (
          <FolderColorMenu
            value={entry.color}
            onPick={(color) => {
              onColor(entry, color)
              closeMenu()
            }}
          />
        ),
      },
      {
        id: 'tags',
        label: t('clouddrive.action.tags'),
        icon: <Tags size={14} />,
        disabled: !single || !metadataWritable,
        submenu: () => (
          <TagEditorMenu
            tags={entry.tags}
            busy={busy}
            onAdd={(tag, color) => onAddTag(entry, tag, color)}
            onRemove={(tag) => onRemoveTag(entry, tag)}
          />
        ),
      },
    ]
    rows.push({
      id: 'checkboxes',
      label: showCheckboxes ? t('clouddrive.action.hide_checkboxes') : t('clouddrive.action.show_checkboxes'),
      icon: <ListChecks size={14} />,
      separatorBefore: true,
      onSelect: onToggleCheckboxes,
    })
    return rows
  }, [
    entry,
    targets,
    isFolder,
    writable,
    metadataWritable,
    copyable,
    single,
    busy,
    showCheckboxes,
    canPaste,
    onOpen,
    onPreview,
    onDownload,
    onShare,
    onCopy,
    onCut,
    onPaste,
    onRename,
    onMove,
    onDelete,
    onColor,
    onAddTag,
    onRemoveTag,
    onToggleCheckboxes,
  ])

  return (
    <Menu
      anchor={menu.point ?? { x: 0, y: 0 }}
      open={target !== null && menu.point !== null}
      onClose={() => {
        menu.close()
        onClose()
      }}
      items={items}
      width={224}
    />
  )
}
