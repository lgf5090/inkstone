import { useRef, useState } from 'react'
import { Archive, FolderInput, Mail, MailOpen, Star, Trash2, X } from 'lucide-react'
import type { EmailBatchAction, EmailFolder } from '@shared/email/model'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Menu, confirm, useEscape, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { folderPathLabel } from './MessageRow'

export function MessageBatchBar({
  selectedCount,
  folders,
  onClear,
  onAction,
}: {
  selectedCount: number
  folders: readonly EmailFolder[]
  onClear: () => void
  onAction: (action: EmailBatchAction, folderId?: string) => Promise<boolean>
}) {
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const moveRef = useRef<HTMLButtonElement>(null)
  useEscape(selectedCount > 0, onClear)
  if (selectedCount === 0) return null

  const run = async (action: EmailBatchAction, folderId?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onAction(action, folderId)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (busy) return
    const ok = await confirm({
      title: t('email.batch.delete_title'),
      description: t('email.batch.delete_hint'),
      confirmLabel: t('email.detail.delete'),
      tone: 'danger',
    })
    if (ok) await run('trash')
  }

  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const moveItems: MenuItem[] = folders.some((folder) => folder.id !== 'trash')
    ? folders
        .filter((folder) => folder.id !== 'trash')
        .map((folder) => ({
          id: folder.id,
          label: folderPathLabel(folder, byId),
          icon: <FolderInput size={13} />,
          onSelect: () => {
            setMoveOpen(false)
            void run('move', folder.id)
          },
        }))
    : [{ id: 'empty', label: t('email.message.move_empty'), disabled: true }]

  return (
    <div
      role="toolbar"
      aria-label={t('email.batch.bar')}
      aria-busy={busy}
      data-email-batch-bar=""
      className="anim-pop absolute bottom-[var(--sp-4)] left-1/2 z-[var(--z-float)] flex max-w-[calc(100%_-_var(--sp-8))] -translate-x-1/2 flex-wrap items-center justify-center gap-[var(--sp-2)] rounded-[var(--r-xl)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-[var(--sp-4)] py-[var(--sp-2)] shadow-[var(--shadow-modal)]"
    >
      <div className="flex items-center gap-[var(--sp-2)] border-r border-[var(--border-subtle)] pr-[var(--sp-3)]">
        <span aria-live="polite" className="text-[length:var(--text-12-5)] font-semibold tabular-nums text-[var(--text-primary)]">
          {t('email.batch.selected', { count: selectedCount })}
        </span>
        {busy && <Spinner size={12} />}
        {busy && <span className="sr-only">{t('email.batch.working')}</span>}
        <IconButton label={t('email.batch.clear')} size="sm" disabled={busy} onClick={onClear}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-[var(--sp-1-5)]">
        <Button size="sm" variant="secondary" icon={<MailOpen size={13} />} disabled={busy} onClick={() => { void run('read') }}>
          {t('email.list.mark_read')}
        </Button>
        <Button size="sm" variant="secondary" icon={<Mail size={13} />} disabled={busy} onClick={() => { void run('unread') }}>
          {t('email.list.mark_unread')}
        </Button>
        <Button size="sm" variant="secondary" icon={<Star size={13} />} disabled={busy} onClick={() => { void run('star') }}>
          {t('email.list.star')}
        </Button>
        <Button
          ref={moveRef}
          size="sm"
          variant="secondary"
          icon={<FolderInput size={13} />}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={moveOpen}
          onClick={() => setMoveOpen((open) => !open)}
        >
          {t('email.message.move_to')}
        </Button>
        <Button size="sm" variant="secondary" icon={<Archive size={13} />} disabled={busy} onClick={() => { void run('archive') }}>
          {t('email.message.archive')}
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 size={13} />} disabled={busy} onClick={() => { void remove() }}>
          {t('email.detail.delete')}
        </Button>
      </div>
      <Menu
        anchor={moveRef}
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        items={moveItems}
        align="end"
        width={200}
        label={t('email.message.move_to')}
      />
    </div>
  )
}
