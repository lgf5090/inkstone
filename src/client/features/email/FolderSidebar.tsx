import { useRef, useState } from 'react'
import { Archive, FileText, Inbox, MoreHorizontal, Plus, Send, Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSystemFolder } from '@shared/email/model'
import { EMAIL_SIDEBAR_FOLDERS, isEmailSystemFolder } from '@shared/email/model'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { SectionLabel } from '../../components/primitives'
import { IconButton } from '../../components/primitives'
import { Menu, confirm, prompt, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import { SYSTEM_FOLDER_LABEL_KEYS } from './format'

const FOLDER_ICONS: Record<EmailSystemFolder, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  draft: FileText,
  archive: Archive,
  trash: Trash2,
  spam: Trash2,
}

function reportFailure(error: unknown): void {
  useUi.getState().toast({ title: t('email.toast.failed'), description: emailErrorText(error), tone: 'danger' })
}

export function FolderSidebar({
  folders,
  activeFolderId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: {
  folders: readonly EmailFolder[]
  activeFolderId: string | null
  onSelect: (folderId: string) => void
  onCreate: (name: string) => Promise<void>
  onRename: (folderId: string, name: string) => Promise<void>
  onDelete: (folderId: string) => Promise<void>
  onClose?: () => void
}) {
  const [menuFolder, setMenuFolder] = useState<EmailFolder | null>(null)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const customFolders = folders.filter((folder) => folder.isDeletable && !isEmailSystemFolder(folder.id))
  const byId = new Map(folders.map((folder) => [folder.id, folder]))

  const choose = (folderId: string): void => {
    onSelect(folderId)
    onClose?.()
  }

  const create = async (): Promise<void> => {
    const name = await prompt({
      title: t('email.folder.new_title'),
      description: t('email.folder.new_hint'),
      placeholder: t('email.folder.name_placeholder'),
      confirmLabel: t('email.folder.create'),
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await onCreate(trimmed)
    } catch (error) {
      reportFailure(error)
    }
  }

  const rename = async (folder: EmailFolder): Promise<void> => {
    const name = await prompt({
      title: t('email.folder.rename_title', { name: folder.name }),
      placeholder: t('email.folder.name_placeholder'),
      defaultValue: folder.name,
      confirmLabel: t('email.folder.rename'),
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === folder.name) return
    try {
      await onRename(folder.id, trimmed)
    } catch (error) {
      reportFailure(error)
    }
  }

  const remove = async (folder: EmailFolder): Promise<void> => {
    const ok = await confirm({
      title: t('email.folder.delete_title', { name: folder.name }),
      description: t('email.folder.delete_hint'),
      confirmLabel: t('email.folder.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await onDelete(folder.id)
    } catch (error) {
      reportFailure(error)
    }
  }

  const menuItems: MenuItem[] = menuFolder
    ? [
        { id: 'rename', label: t('email.folder.rename'), onSelect: () => { void rename(menuFolder) } },
        { id: 'delete', label: t('email.folder.delete'), tone: 'danger', onSelect: () => { void remove(menuFolder) } },
      ]
    : []

  return (
    <nav aria-label={t('email.a11y.folders')} className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto bg-[var(--bg-sunken)] px-2 py-3">
      <div className="flex flex-col gap-0.5">
        {EMAIL_SIDEBAR_FOLDERS.map((id) => {
          const Icon = FOLDER_ICONS[id]
          const folder = byId.get(id)
          const unread = folder?.unreadCount ?? 0
          const active = activeFolderId === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => choose(id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-8 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
                active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center"><Icon size={14} aria-hidden="true" /></span>
              <span className="min-w-0 flex-1 truncate">{t(SYSTEM_FOLDER_LABEL_KEYS[id])}</span>
              {unread > 0 && <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{unread}</span>}
            </button>
          )
        })}
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-1 pr-0.5">
          <SectionLabel className="p-0">{t('email.folder.custom')}</SectionLabel>
          <IconButton label={t('email.folder.new')} size="xs" onClick={() => { void create() }}>
            <Plus size={12} />
          </IconButton>
        </div>
        {customFolders.map((folder) => {
          const active = activeFolderId === folder.id
          return (
            <div key={folder.id} className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => choose(folder.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
                  active ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center"><FileText size={13} aria-hidden="true" /></span>
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                {folder.unreadCount > 0 && <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{folder.unreadCount}</span>}
              </button>
              <IconButton
                label={t('email.folder.more', { name: folder.name })}
                size="xs"
                active={menuFolder?.id === folder.id}
                aria-haspopup="menu"
                aria-expanded={menuFolder?.id === folder.id}
                onClick={(event) => {
                  menuAnchor.current = event.currentTarget
                  setMenuFolder(menuFolder?.id === folder.id ? null : folder)
                }}
              >
                <MoreHorizontal size={12} />
              </IconButton>
            </div>
          )
        })}
      </div>
      <Menu
        anchor={menuAnchor}
        open={menuFolder !== null}
        onClose={() => setMenuFolder(null)}
        items={menuItems}
        width={168}
        label={t('email.folder.more_actions')}
      />
    </nav>
  )
}
