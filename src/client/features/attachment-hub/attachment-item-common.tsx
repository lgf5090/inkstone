import { useRef, useState } from 'react'
import {
  Copy,
  Download,
  Eye,
  FolderClosed,
  Paperclip,
  Pencil,
  Pin,
  QrCode,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import type { HubAttachmentWithUsage } from '@shared/attachment-hub'
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/clipboard'
import { useUi } from '../../store/ui'
import { Menu, useContextMenu, type MenuItem } from '../../components/overlay'
import { useHubOrganizer } from './attachment-store'
import { useHubScope } from './hub-scope'
import {
  HUB_ATTACHMENT_DRAG_TYPE,
  badgeLabelOf,
  fileExtensionOf,
  getFileCategory,
} from './attachment-helpers'

export interface AttachmentMenuCtx {
  file: HubAttachmentWithUsage
  onPreview: () => void
  onRename: () => void
  onShowQr: () => void
  onInsertHere?: () => void
  onToggleStar: () => void
  onTogglePin: () => void
  onMoveToFolder: () => void
  onDelete: () => void
}

/** The two views are the same set of commands over the same rows, so they share one props shape. */
export interface AttachmentViewProps {
  files: HubAttachmentWithUsage[]
  selectedIds: Set<string>
  activeFile: HubAttachmentWithUsage | null
  onToggleSelect: (id: string, e: React.MouseEvent) => void
  onSelectActive: (file: HubAttachmentWithUsage) => void
  onPreview: (file: HubAttachmentWithUsage) => void
  onRename: (file: HubAttachmentWithUsage) => void
  onShowQr: (file: HubAttachmentWithUsage) => void
  onInsertHere?: (file: HubAttachmentWithUsage) => void
  onToggleStar: (file: HubAttachmentWithUsage) => void
  onTogglePin: (file: HubAttachmentWithUsage) => void
  onMoveToFolder: (file: HubAttachmentWithUsage) => void
  onDelete: (file: HubAttachmentWithUsage) => void
  onUploadClick?: () => void
}

export function fileBadgeOf(file: HubAttachmentWithUsage): { isImage: boolean; label: string } {
  const ext = fileExtensionOf(file.filename)
  return { isImage: getFileCategory(file.mime, file.filename) === 'image', label: badgeLabelOf(ext) }
}

export function useFileFolder(file: HubAttachmentWithUsage) {
  const scope = useHubScope()
  const folders = useHubOrganizer(scope, (state) => state.folders)
  return file.folderId ? folders.find((folder) => folder.id === file.folderId) : undefined
}

export function useCardMenu() {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const contextMenu = useContextMenu()
  return {
    buttonRef,
    isOpen,
    toggle: () => setIsOpen((prev) => !prev),
    close: () => setIsOpen(false),
    contextMenu,
    handleContextMenu: (e: React.MouseEvent) => {
      setIsOpen(false)
      contextMenu.onContextMenu(e)
    },
  }
}

export function AttachmentMenus({ menu, items }: { menu: ReturnType<typeof useCardMenu>; items: MenuItem[] }) {
  return (
    <>
      <Menu open={menu.isOpen} anchor={menu.buttonRef} items={items} onClose={menu.close} />
      {menu.contextMenu.point && <Menu open anchor={menu.contextMenu.point} items={items} onClose={menu.contextMenu.close} />}
    </>
  )
}

export function cardDragStart(e: React.DragEvent, fileId: string): void {
  e.dataTransfer.setData(HUB_ATTACHMENT_DRAG_TYPE, JSON.stringify([fileId]))
  e.dataTransfer.effectAllowed = 'move'
}

export function markdownOf(file: HubAttachmentWithUsage): string {
  const { isImage } = fileBadgeOf(file)
  return isImage ? `![${file.filename}](${file.url})` : `[${file.filename}](${file.url})`
}

export async function copyAsMarkdown(file: HubAttachmentWithUsage): Promise<boolean> {
  return copyText(markdownOf(file))
}

export async function copyFileUrl(file: HubAttachmentWithUsage): Promise<boolean> {
  return copyText(new URL(file.url, window.location.origin).href)
}

export function downloadFile(file: HubAttachmentWithUsage): void {
  const link = document.createElement('a')
  link.href = file.url
  link.download = file.filename
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

/** Non-images have no in-app viewer: the browser's own is the one that can actually show them. */
export function openFileExternally(file: HubAttachmentWithUsage): void {
  window.open(new URL(file.url, window.location.origin).href, '_blank', 'noopener,noreferrer')
}

export function reportCopyFailure(): void {
  useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
}

export function buildAttachmentMenuItems(ctx: AttachmentMenuCtx): MenuItem[] {
  const items: MenuItem[] = [{ id: 'preview', label: t('common.preview'), icon: <Eye size={13} />, onSelect: ctx.onPreview }]
  if (ctx.onInsertHere) {
    items.push({ id: 'insert', label: t('attachments.insert_here'), icon: <Paperclip size={13} />, onSelect: ctx.onInsertHere })
  }
  items.push(
    { id: 'copy-markdown', label: t('attachments.copy_markdown'), icon: <Copy size={13} />, separatorBefore: true, onSelect: () => void copyAsMarkdown(ctx.file).then((copied) => { if (!copied) reportCopyFailure() }) },
    { id: 'copy-link', label: t('attachments.copy_link'), icon: <Copy size={13} />, onSelect: () => void copyFileUrl(ctx.file).then((copied) => { if (!copied) reportCopyFailure() }) },
    { id: 'qr', label: t('attachments.qr_code_title'), icon: <QrCode size={13} />, onSelect: ctx.onShowQr },
    { id: 'star', label: ctx.file.isStarred ? t('attachments.unstar') : t('attachments.star'), icon: <Star size={13} />, separatorBefore: true, onSelect: ctx.onToggleStar },
    { id: 'pin', label: ctx.file.isPinned ? t('attachments.unpin') : t('attachments.pin'), icon: <Pin size={13} />, onSelect: ctx.onTogglePin },
    { id: 'move', label: t('attachments.move_to'), icon: <FolderClosed size={13} />, onSelect: ctx.onMoveToFolder },
    { id: 'rename', label: t('attachments.rename'), icon: <Pencil size={13} />, onSelect: ctx.onRename },
    { id: 'download', label: t('common.download'), icon: <Download size={13} />, separatorBefore: true, onSelect: () => downloadFile(ctx.file) },
    { id: 'delete', label: t('attachments.delete'), icon: <Trash2 size={13} />, tone: 'danger', separatorBefore: true, onSelect: ctx.onDelete },
  )
  return items
}

export function UploadEmptyState({ onUploadClick }: { onUploadClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onUploadClick}
      className='flex flex-1 min-h-[var(--empty-h-sm)] cursor-pointer flex-col items-center justify-center rounded-[var(--r-xl)] border-2 border-dashed border-[var(--border-subtle)] bg-[var(--bg-sunken)]/20 px-[var(--sp-4)] py-[var(--sp-8)] text-center transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/10'
    >
      <span className='mb-[var(--sp-3)] flex size-[var(--sp-12)] items-center justify-center rounded-[var(--r-xl)] bg-[var(--bg-surface)] text-[var(--accent)] shadow-[var(--shadow-xs)]'>
        <Upload size={22} />
      </span>
      <span className='text-[length:var(--text-13)] font-semibold text-[var(--text-secondary)]'>
        {t('attachments.drag_drop_hint')}
      </span>
      <span className='mt-[var(--sp-1)] max-w-sm text-[length:var(--text-11-5)] text-[var(--text-tertiary)]'>
        {t('attachments.upload_guide_hint')}
      </span>
    </button>
  )
}
